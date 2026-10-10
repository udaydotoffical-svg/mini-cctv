#pragma once
// microSD storage: photos and AVI clips (FAT32, 1-bit SD_MMC).
//
// All SD *writes* happen on one task (writerTask) fed through a queue, so a slow SD card can never
// stall the camera or the viewers. Encoded pictures travel in a small pool of buffers ("slots"):
// the capture task takes a free slot, fills it, posts a job, and the writer hands the slot back.
// If no slot is free the capture task just drops that video frame.
#include <Arduino.h>
#include <FS.h>
#include <SD_MMC.h>

#include "avi.h"
#include "config.h"

#define SLOT_COUNT     6
#define SLOT_BYTES     (160 * 1024)
#define REC_LONGEST_MS (REC_MAX_CLIP_MS > REC_CONT_CLIP_MS ? REC_MAX_CLIP_MS : REC_CONT_CLIP_MS)
#define REC_MAX_FRAMES (REC_FPS * (REC_LONGEST_MS / 1000) + 64)

enum { J_PHOTO = 1, J_VID_OPEN, J_VID_FRAME, J_VID_CLOSE };
struct SdJob {
    uint8_t type;
    int8_t slot; // -1 = none
    uint32_t len;
    uint32_t ts;  // frame time in ms
    uint32_t num; // photo / clip number
};

static volatile bool g_sdOk = false;
static uint8_t *g_slot[SLOT_COUNT];
static QueueHandle_t g_jobQ = nullptr;
static QueueHandle_t g_freeQ = nullptr;
static volatile uint32_t g_nextPhoto = 1;
static volatile uint32_t g_nextClip = 1;
static volatile uint32_t g_photoDoneNo = 0; // number of the last photo the writer finished (or failed)
static volatile bool g_photoDoneOk = false;
static volatile uint32_t g_sdFreeMB = 0;
static volatile uint64_t g_sdFreeBytes = 0; // estimate; measured exactly only when it looks low
static volatile bool g_clipWriting = false;

static File g_vf;
static AviWriter g_avi;
static bool g_clipOpen = false;
static uint32_t g_clipT0 = 0, g_clipTL = 0;
static uint32_t *g_aviOffs = nullptr;
static uint32_t *g_aviSizes = nullptr;

static const char *SD_PHOTO_DIR = "/cctv/photos";
static const char *SD_CLIP_DIR = "/cctv/clips";

static void sdPath(char *out, size_t n, bool clip, uint32_t no) {
    snprintf(out, n, clip ? "/cctv/clips/VID_%04u.avi" : "/cctv/photos/IMG_%04u.jpg", (unsigned)no);
}

// number in a name like IMG_0042.jpg, or 0
static uint32_t sdNumberOf(const char *name, const char *prefix) {
    const char *base = strrchr(name, '/');
    base = base ? base + 1 : name;
    const size_t pl = strlen(prefix);
    if (strncmp(base, prefix, pl) != 0) return 0;
    return (uint32_t)strtoul(base + pl, nullptr, 10);
}

static uint32_t sdScan(const char *dir, const char *prefix, bool wantOldest) {
    uint32_t best = 0;
    File root = SD_MMC.open(dir);
    if (!root || !root.isDirectory()) return 0;
    for (File f = root.openNextFile(); f; f = root.openNextFile()) {
        const uint32_t n = sdNumberOf(f.name(), prefix);
        if (!n) continue;
        if (best == 0 || (wantOldest ? n < best : n > best)) best = n;
    }
    return best;
}

static uint32_t sdFreeNow() {
    const uint64_t t = SD_MMC.totalBytes(), u = SD_MMC.usedBytes();
    return t > u ? (uint32_t)((t - u) / (1024ull * 1024ull)) : 0;
}

// Delete the oldest clips (then photos) until there is room. Measuring free space exactly
// (usedBytes) scans the FAT and can take seconds on a big card, so we keep a running estimate and
// only measure when it says space is getting low.
static void sdMakeRoom() {
    if (g_sdFreeBytes / (1024ull * 1024ull) > 2ull * SD_MIN_FREE_MB) {
        g_sdFreeMB = (uint32_t)(g_sdFreeBytes / (1024ull * 1024ull));
        return;
    }
    uint32_t freeMB = sdFreeNow();
    for (int guard = 0; freeMB < SD_MIN_FREE_MB && guard < 40; guard++) {
        char path[48];
        uint32_t no = sdScan(SD_CLIP_DIR, "VID_", true);
        if (no) sdPath(path, sizeof path, true, no);
        else if ((no = sdScan(SD_PHOTO_DIR, "IMG_", true))) sdPath(path, sizeof path, false, no);
        else break;
        Serial.printf("SD: low space (%u MB free), deleting %s\n", (unsigned)freeMB, path);
        SD_MMC.remove(path);
        freeMB = sdFreeNow();
    }
    g_sdFreeMB = freeMB;
    g_sdFreeBytes = (uint64_t)freeMB * 1024ull * 1024ull;
}

static void sdNoteWritten(uint64_t bytes) {
    g_sdFreeBytes = g_sdFreeBytes > bytes ? g_sdFreeBytes - bytes : 0;
    g_sdFreeMB = (uint32_t)(g_sdFreeBytes / (1024ull * 1024ull));
}

static bool sdBegin(bool verbose) {
#if SD_ENABLE
    SD_MMC.setPins(SD_CLK_PIN, SD_CMD_PIN, SD_D0_PIN);
    if (!SD_MMC.begin("/sdcard", true)) {
        if (verbose) Serial.printf("SD: init failed (1-bit, CLK=%d CMD=%d D0=%d). Is a FAT32 card inserted, and are these "
                      "the right pins for this board? (see SD_*_PIN in config.h)\n",
                      SD_CLK_PIN, SD_CMD_PIN, SD_D0_PIN);
        return false;
    }
    if (SD_MMC.cardType() == CARD_NONE) {
        if (verbose) Serial.println("SD: no card detected");
        return false;
    }
    SD_MMC.mkdir("/cctv");
    SD_MMC.mkdir(SD_PHOTO_DIR);
    SD_MMC.mkdir(SD_CLIP_DIR);
    g_nextPhoto = sdScan(SD_PHOTO_DIR, "IMG_", false) + 1;
    g_nextClip = sdScan(SD_CLIP_DIR, "VID_", false) + 1;
    g_sdFreeMB = sdFreeNow();
    g_sdFreeBytes = (uint64_t)g_sdFreeMB * 1024ull * 1024ull;
    Serial.printf("SD: ok, %.1f GB card, %u MB free, next photo %u, next clip %u\n",
                  (double)SD_MMC.cardSize() / (1024.0 * 1024.0 * 1024.0), (unsigned)g_sdFreeMB,
                  (unsigned)g_nextPhoto, (unsigned)g_nextClip);
    return true;
#else
    return false;
#endif
}

// Newest `maxN` entries of a directory (highest numbers first).
struct SdEntry {
    uint32_t no;
    uint32_t size;
};
static int sdList(const char *dir, const char *prefix, SdEntry *out, int maxN) {
    int n = 0;
    File root = SD_MMC.open(dir);
    if (!root || !root.isDirectory()) return 0;
    for (File f = root.openNextFile(); f; f = root.openNextFile()) {
        const uint32_t no = sdNumberOf(f.name(), prefix);
        if (!no) continue;
        int pos = n;
        while (pos > 0 && out[pos - 1].no < no) pos--;
        if (pos >= maxN) continue;
        if (n < maxN) n++;
        for (int k = n - 1; k > pos; k--) out[k] = out[k - 1];
        out[pos] = {no, (uint32_t)f.size()};
    }
    return n;
}

// ------------------------------------------------------------------------------------- slots
static int slotAcquire(uint32_t waitMs) {
    int8_t s;
    return xQueueReceive(g_freeQ, &s, pdMS_TO_TICKS(waitMs)) == pdTRUE ? s : -1;
}
static void slotRelease(int s) {
    const int8_t v = (int8_t)s;
    xQueueSend(g_freeQ, &v, 0);
}
static bool sdPost(const SdJob &j) { return xQueueSend(g_jobQ, &j, 0) == pdTRUE; }

// ------------------------------------------------------------------------------------- writer
static size_t sdFileWrite(void *c, const void *d, size_t n) { return ((File *)c)->write((const uint8_t *)d, n); }
static bool sdFileSeek(void *c, uint32_t p) { return ((File *)c)->seek(p); }
static size_t sdFileRead(void *c, void *b, size_t n) { return ((File *)c)->read((uint8_t *)b, n); }

static void clipClose() {
    if (!g_clipOpen) return;
    uint32_t us = 1000000 / REC_FPS;
    if (g_avi.frames > 1 && g_clipTL > g_clipT0) us = (uint32_t)((uint64_t)(g_clipTL - g_clipT0) * 1000 / (g_avi.frames - 1));
    g_avi.finish(us);
    sdNoteWritten((uint64_t)g_vf.size());
    g_vf.close();
    g_clipOpen = false;
    g_clipWriting = false;
}

static void writerTask(void *) {
    for (;;) {
        SdJob j;
        if (xQueueReceive(g_jobQ, &j, portMAX_DELAY) != pdTRUE) continue;
        char path[48];
        switch (j.type) {
            case J_PHOTO: {
                bool ok = false;
                if (g_sdOk && j.slot >= 0) {
                    sdMakeRoom();
                    sdPath(path, sizeof path, false, j.num);
                    File f = SD_MMC.open(path, FILE_WRITE);
                    if (f) {
                        ok = f.write(g_slot[j.slot], j.len) == j.len;
                        f.close();
                        if (ok) sdNoteWritten(j.len);
                    }
                    if (!ok) Serial.printf("SD: writing %s failed\n", path);
                }
                g_photoDoneOk = ok;
                g_photoDoneNo = j.num;
                break;
            }
            case J_VID_OPEN:
                clipClose();
                if (!g_sdOk) break;
                sdMakeRoom();
                sdPath(path, sizeof path, true, j.num);
                g_vf = SD_MMC.open(path, FILE_WRITE);
                if (g_vf) {
                    AviIO io = {&g_vf, sdFileWrite, sdFileSeek};
                    g_clipOpen = g_avi.begin(io, REC_WIDTH, REC_HEIGHT, g_aviOffs, g_aviSizes, REC_MAX_FRAMES);
                    g_clipT0 = g_clipTL = j.ts;
                    g_clipWriting = g_clipOpen;
                    Serial.printf("REC: %s\n", path);
                } else {
                    Serial.printf("SD: cannot create %s\n", path);
                }
                break;
            case J_VID_FRAME:
                if (g_clipOpen && j.slot >= 0) {
                    if (g_avi.addFrame(g_slot[j.slot], j.len)) g_clipTL = j.ts;
                    else {
                        Serial.println("REC: write failed or clip full, closing");
                        clipClose();
                    }
                }
                break;
            case J_VID_CLOSE:
                clipClose();
                break;
        }
        if (j.slot >= 0) slotRelease(j.slot);
    }
}

static bool sdStartWriter() {
    g_jobQ = xQueueCreate(16, sizeof(SdJob));
    g_freeQ = xQueueCreate(SLOT_COUNT, sizeof(int8_t));
    g_aviOffs = (uint32_t *)heap_caps_calloc(REC_MAX_FRAMES, 4, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    g_aviSizes = (uint32_t *)heap_caps_calloc(REC_MAX_FRAMES, 4, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    bool ok = g_jobQ && g_freeQ && g_aviOffs && g_aviSizes;
    for (int i = 0; i < SLOT_COUNT; i++) {
        g_slot[i] = (uint8_t *)heap_caps_malloc(SLOT_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        ok = ok && g_slot[i];
        if (g_slot[i]) slotRelease(i);
    }
    if (!ok) return false;
    xTaskCreatePinnedToCore(writerTask, "sdwrite", 8192, nullptr, 1, nullptr, 0);
    return true;
}
