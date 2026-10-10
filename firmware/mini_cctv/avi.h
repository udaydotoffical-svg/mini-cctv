#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>

// Minimal MJPEG AVI writer and reader (pure C++, tested on a PC with ffprobe/ffmpeg by
// tools/test_avi.cpp). One video stream, every frame a JPEG, an idx1 index at the end so players
// can seek. The file layout is fixed, which makes the header patch-up at the end trivial:
//
//   0   RIFF size 'AVI '
//   12  LIST size 'hdrl'          [avih @24, LIST 'strl' @88 with strh @100 and strf @164]
//   212 LIST size 'movi'          chunks '00dc' <len> <jpeg> (+ pad to even) start at 224
//   ... 'idx1'                    16 bytes per frame; offsets count from the 'movi' fourcc (@220)
//
// All file access goes through two small function-pointer structs so the same code runs on an SD
// card (SD_MMC File) and on a PC.

struct AviIO {
    void *ctx;
    size_t (*write)(void *ctx, const void *data, size_t n);
    bool (*seek)(void *ctx, uint32_t pos);
};

struct AviReadIO {
    void *ctx;
    size_t (*read)(void *ctx, void *buf, size_t n);
    bool (*seek)(void *ctx, uint32_t pos);
    uint32_t size;
};

#define AVI_MOVI_FOURCC_POS 220
#define AVI_FIRST_CHUNK_POS 224

static inline void avi_w32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}
static inline void avi_w16(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
}
static inline uint32_t avi_r32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static inline void avi_cc(uint8_t *p, const char *s) { memcpy(p, s, 4); }

struct AviWriter {
    AviIO io;
    uint32_t w, h;
    uint32_t *offs;  // per frame: chunk header offset from the 'movi' fourcc
    uint32_t *sizes; // per frame: JPEG size
    uint32_t maxFrames;
    uint32_t frames;
    uint32_t pos;      // current end of file
    uint32_t maxChunk; // largest frame, for the suggested buffer size
    bool ok;

    bool put(const void *d, size_t n) {
        if (!ok) return false;
        if (io.write(io.ctx, d, n) != n) ok = false;
        else pos += (uint32_t)n;
        return ok;
    }

    bool begin(const AviIO &i, uint32_t width, uint32_t height, uint32_t *offsBuf, uint32_t *sizesBuf, uint32_t maxF) {
        io = i;
        w = width;
        h = height;
        offs = offsBuf;
        sizes = sizesBuf;
        maxFrames = maxF;
        frames = 0;
        pos = 0;
        maxChunk = 0;
        ok = true;

        uint8_t hd[AVI_FIRST_CHUNK_POS];
        memset(hd, 0, sizeof(hd));
        avi_cc(hd + 0, "RIFF");
        avi_cc(hd + 8, "AVI ");
        avi_cc(hd + 12, "LIST");
        avi_w32(hd + 16, 192);
        avi_cc(hd + 20, "hdrl");
        avi_cc(hd + 24, "avih");
        avi_w32(hd + 28, 56);
        avi_w32(hd + 44, 0x10); // AVIF_HASINDEX
        avi_w32(hd + 56, 1);    // streams
        avi_w32(hd + 64, w);
        avi_w32(hd + 68, h);
        avi_cc(hd + 88, "LIST");
        avi_w32(hd + 92, 116);
        avi_cc(hd + 96, "strl");
        avi_cc(hd + 100, "strh");
        avi_w32(hd + 104, 56);
        avi_cc(hd + 108, "vids");
        avi_cc(hd + 112, "MJPG");
        avi_w32(hd + 148, 0xFFFFFFFFu); // quality: default
        avi_w16(hd + 160, w);           // rcFrame right
        avi_w16(hd + 162, h);           // rcFrame bottom
        avi_cc(hd + 164, "strf");
        avi_w32(hd + 168, 40);
        avi_w32(hd + 172, 40); // BITMAPINFOHEADER.biSize
        avi_w32(hd + 176, w);
        avi_w32(hd + 180, h);
        avi_w16(hd + 184, 1);  // planes
        avi_w16(hd + 186, 24); // bit count
        avi_cc(hd + 188, "MJPG");
        avi_w32(hd + 192, w * h * 3);
        avi_cc(hd + 212, "LIST");
        avi_cc(hd + 220, "movi");
        return put(hd, sizeof(hd));
    }

    bool addFrame(const uint8_t *jpg, uint32_t len) {
        if (!ok || frames >= maxFrames || len == 0) return false;
        uint8_t ch[8];
        avi_cc(ch, "00dc");
        avi_w32(ch + 4, len);
        offs[frames] = pos - AVI_MOVI_FOURCC_POS;
        sizes[frames] = len;
        if (!put(ch, 8) || !put(jpg, len)) return false;
        if (len & 1) {
            const uint8_t z = 0;
            if (!put(&z, 1)) return false;
        }
        if (len > maxChunk) maxChunk = len;
        frames++;
        return true;
    }

    // Writes the index and fixes up the header. usPerFrame = average time per frame.
    bool finish(uint32_t usPerFrame) {
        if (!ok) return false;
        const uint32_t moviEnd = pos;
        uint8_t ih[8];
        avi_cc(ih, "idx1");
        avi_w32(ih + 4, frames * 16);
        put(ih, 8);
        for (uint32_t i = 0; i < frames && ok; i++) {
            uint8_t e[16];
            avi_cc(e, "00dc");
            avi_w32(e + 4, 0x10); // AVIIF_KEYFRAME
            avi_w32(e + 8, offs[i]);
            avi_w32(e + 12, sizes[i]);
            put(e, 16);
        }
        if (!ok) return false;

        uint8_t v[4];
        auto patch = [&](uint32_t at, uint32_t val) {
            avi_w32(v, val);
            if (!io.seek(io.ctx, at) || io.write(io.ctx, v, 4) != 4) ok = false;
        };
        const uint32_t bytesPerSec = usPerFrame ? (uint32_t)((uint64_t)maxChunk * 1000000u / usPerFrame) : 0;
        patch(4, pos - 8);                   // RIFF size
        patch(32, usPerFrame);               // avih: microseconds per frame
        patch(36, bytesPerSec);              // avih: max bytes per second
        patch(48, frames);                   // avih: total frames
        patch(60, maxChunk);                 // avih: suggested buffer
        patch(128, usPerFrame);              // strh: scale
        patch(132, 1000000);                 // strh: rate (rate/scale = fps)
        patch(140, frames);                  // strh: length
        patch(144, maxChunk);                // strh: suggested buffer
        patch(216, moviEnd - 220);           // movi LIST size: from the 'movi' fourcc to the last chunk
        return ok;
    }
};

struct AviInfo {
    uint32_t w, h, usPerFrame, frames;
    uint32_t indexPos; // where the idx1 entries start
};

// Reads the header and finds the index of a file written by AviWriter.
static inline bool aviOpen(const AviReadIO &io, AviInfo *info) {
    uint8_t hd[AVI_FIRST_CHUNK_POS];
    if (io.size < AVI_FIRST_CHUNK_POS || !io.seek(io.ctx, 0) || io.read(io.ctx, hd, sizeof(hd)) != sizeof(hd)) return false;
    if (memcmp(hd, "RIFF", 4) || memcmp(hd + 8, "AVI ", 4) || memcmp(hd + 24, "avih", 4) || memcmp(hd + 220, "movi", 4)) return false;
    info->usPerFrame = avi_r32(hd + 32);
    info->frames = avi_r32(hd + 48);
    info->w = avi_r32(hd + 64);
    info->h = avi_r32(hd + 68);
    const uint32_t idx = 220 + avi_r32(hd + 216); // end of the movi list
    uint8_t ih[8];
    if (idx + 8 > io.size || !io.seek(io.ctx, idx) || io.read(io.ctx, ih, 8) != 8 || memcmp(ih, "idx1", 4)) return false;
    info->indexPos = idx + 8;
    if (avi_r32(ih + 4) / 16 < info->frames) return false;
    return true;
}

// Loads up to maxN index entries. Returns how many.
static inline uint32_t aviReadIndex(const AviReadIO &io, const AviInfo &info, uint32_t *offs, uint32_t *sizes, uint32_t maxN) {
    uint32_t n = info.frames < maxN ? info.frames : maxN;
    if (!io.seek(io.ctx, info.indexPos)) return 0;
    for (uint32_t i = 0; i < n; i++) {
        uint8_t e[16];
        if (io.read(io.ctx, e, 16) != 16) return i;
        offs[i] = avi_r32(e + 8);
        sizes[i] = avi_r32(e + 12);
    }
    return n;
}

// Reads one frame's JPEG into buf (cap bytes). Returns its length, or 0 on error.
static inline uint32_t aviReadFrame(const AviReadIO &io, uint32_t off, uint32_t size, uint8_t *buf, uint32_t cap) {
    if (size == 0 || size > cap) return 0;
    uint8_t ch[8];
    if (!io.seek(io.ctx, AVI_MOVI_FOURCC_POS + off) || io.read(io.ctx, ch, 8) != 8 || memcmp(ch, "00dc", 4)) return 0;
    if (avi_r32(ch + 4) != size) return 0;
    return io.read(io.ctx, buf, size) == size ? size : 0;
}
