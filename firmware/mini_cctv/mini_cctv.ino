// mini-cctv camera node  (Arduino IDE sketch; also builds with PlatformIO, see ../platformio.ini)
//
// Arduino IDE > Tools settings (OceanLabz ESP32-S3-WROOM N16R8 CAM and similar):
//   Board:             "ESP32S3 Dev Module"   (XIAO_ESP32S3 also works for a XIAO)
//   PSRAM:             "OPI PSRAM"   <- required, the sketch stops at boot without it
//   Flash Size:        16MB (128Mb)  for an N16 board (8MB for N8)
//   Partition Scheme:  "16M Flash (3MB APP/9.9MB FATFS)" or any scheme with a >= 2 MB app
//   USB CDC On Boot:   "Enabled" if you use the board's native-USB port for the Serial Monitor
//
// Camera pins: pick the model below (or in a build flag). Default is the
// ESP32-S3-EYE pinout (Freenove WROOM CAM and most S3 CAM clones). For a
// Seeed XIAO ESP32S3 Sense use CAMERA_MODEL_XIAO_ESP32S3.
#if !defined(CAMERA_MODEL_ESP32S3_EYE) && !defined(CAMERA_MODEL_XIAO_ESP32S3) && !defined(CAMERA_MODEL_ESP32S3_CAM_LCD)
#define CAMERA_MODEL_ESP32S3_EYE
//#define CAMERA_MODEL_XIAO_ESP32S3
//#define CAMERA_MODEL_ESP32S3_CAM_LCD
#endif

// What it does (captureTask runs all of this in a loop on core 1):
//   sensor RGB565 640x480
//     -> motion detection (80x60 brightness grid of the whole sensor picture)
//     -> recording rules, video frames (320x240 MJPEG) and photos (full 640x480 JPEG) to the SD card
//     -> digital pan/zoom to the 240x135 picture the Stick shows, history frame for the DVR
//     -> filter (night / grey / thermal / edge)
//     -> compare with the picture the viewers have, band by band, and keep only what changed
//   A "view override" can replace the live picture with a DVR rewind, a photo or a clip.
//
// HTTP, port 80:
//   /d?f=8|j&s=N    changed bands since update N (delta.h): what the Bruce app watches
//   /m?s=N          motion events, long-poll (the Stick's guard mode)
//   /ctl?...        controls: zoom, pan, filter, night, flip, photo, record, rewind, play clips
//   /files?d=photos|clips   list;   /f?d=..&n=..  download;   /gallery  page for a phone
//   /jpg  /status  /          whole-picture JPEG, stats, viewer page
// HTTP, port 81:  /stream     MJPEG for browsers / VLC

#include <Arduino.h>
#include <Preferences.h>
#include <WiFi.h>
#include "esp_camera.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "img_converters.h"

#include "camera_pins.h"
#include "config.h"
#include "delta.h"
#include "filters.h"
#include "history.h"
#include "jpegtools.h"
#include "modes.h"
#include "motion.h"
#include "rec_policy.h"
#include "scaler.h"
#include "sdstore.h"
#include "view.h"

#define BAND_H        16 // = JPEG MCU height, so every strip is a clean multiple of MCUs
#define NBANDS        ((OUT_H + BAND_H - 1) / BAND_H)
#define RGB_LEN       ((size_t)OUT_W * OUT_H * 2)
#define RAW_LEN       ((size_t)OUT_W * OUT_H)
#define STRIP_MAX     12288
#define FULL_JPG_MAX  49152
#define RESP_MAX      (DELTA_HEADER + (size_t)NBANDS * (2 + STRIP_MAX))
#define LONGPOLL_MS   150
#define STRIP_WAIT_MS 500
#define DEC_MAXW      320 // largest picture the playback decoder handles
#define DEC_MAXH      240
#define CLIP_MAX_FRAMES 4000

static_assert(NBANDS <= DELTA_MAX_BANDS, "too many bands");
static_assert(OUT_H > BAND_H * (NBANDS - 1), "last band must have at least one row");

enum { OV_NONE = 0, OV_REWIND = 1, OV_PHOTO = 2, OV_CLIP = 3 };

static SemaphoreHandle_t g_mtx;

// ---- shared with the viewers, guarded by g_mtx. Only captureTask writes the picture state.
static DeltaState g_ds;
static uint8_t *g_raw;           // RGB332 picture, RAW_LEN
static uint8_t *g_strip[NBANDS]; // strip JPEGs, STRIP_MAX each
static uint8_t *g_fullJpg;       // whole-picture JPEG, FULL_JPG_MAX
static size_t g_fullLen;
static uint32_t g_fullSeq;

// ---- private to captureTask
static uint8_t *g_refRgb;  // the picture viewers currently have (RGB565), RGB_LEN
static uint8_t *g_newRgb;  // the freshly built live picture, RGB_LEN
static uint8_t *g_ovRgb;   // rewind / photo / clip picture, RGB_LEN
static uint8_t *g_rawNew;  // dither scratch (also the filter's luma plane), RAW_LEN
static uint8_t *g_tmp;     // JPEG scratch, FULL_JPG_MAX
static uint8_t *g_recRgb;  // video frame, REC_WIDTH x REC_HEIGHT RGB565
static uint8_t *g_decTmp;  // decoder output, DEC_MAXW x DEC_MAXH RGB565
static uint8_t *g_readBuf; // file read buffer, SLOT_BYTES
static uint8_t *g_histBuf;
static uint32_t *g_clipOffs;
static uint32_t *g_clipSizes;
static uint8_t g_grid[MOTION_CELLS];
static MotionDetector g_motion;
static History g_hist;
static HistEntry g_histEnts[HIST_MAX_FRAMES];
static RecPolicy g_rec;
static FilterState g_filtState;
static int g_decLayout = -1; // how the JPEG decoder lays out RGB565 (see jpegtools.h); -1 = unusable

// ---- controls (written by HTTP handlers, read by captureTask)
static View g_view = {VIEW_ZOOM_MIN, 50, 50};
static volatile int g_filter = FILTER_NONE;
static volatile bool g_night = false;
static volatile bool g_vflip = CAM_VFLIP;
static volatile bool g_mirror = CAM_HMIRROR;
static volatile int g_bright = CAM_BRIGHTNESS;
static volatile bool g_sensorDirty = true;
static volatile bool g_forceFull = true;
static volatile int g_mode = DEFAULT_MODE;
static volatile uint32_t g_tlSec = TIMELAPSE_SEC;
static volatile bool g_autoRec = REC_AUTO_DEFAULT; // lets you switch off auto-recording in Security mode
static volatile bool g_recWantStart = false;
static volatile bool g_recWantStop = false;
static volatile uint32_t g_snapReq = 0; // photo number to take, 0 = none
static volatile int g_ovMode = OV_NONE;
static volatile uint32_t g_ovPosT = 0; // rewind: the moment (millis) being viewed
static volatile bool g_ovPlay = false;
static volatile bool g_ovReload = false;
static volatile int32_t g_ovSeekMs = 0;
static char g_ovName[32];

// ---- status, written by captureTask
static volatile int g_motionLevel = 0;
static volatile bool g_motionBig = false;
static volatile bool g_motionActive = false;
static volatile uint32_t g_motionSeq = 0; // counts motion events (rising edges)
static volatile bool g_recording = false;
static volatile uint32_t g_clipPosMs = 0, g_clipLenMs = 0;
static volatile uint32_t g_histSpanMs = 0;
static volatile uint32_t g_stripWantedAt = 0; // millis() of last /d?f=j request
static volatile uint32_t g_fullWantedAt = 0;  // millis() of last /jpg or /stream request
static volatile float g_fps = 0;
static volatile uint32_t g_updates = 0;
static volatile uint32_t g_msLoop = 0, g_msWait = 0; // average loop and sensor-wait time, microseconds

static uint8_t *g_resp; // private to the /d handler (one httpd task serves port 80)

static httpd_handle_t g_httpd = nullptr;
static httpd_handle_t g_stream = nullptr;

// The chosen mode, timelapse interval and auto-record switch survive power cycles.
static Preferences g_prefs;
static void loadPrefs() {
    g_prefs.begin("cctv", true);
    const int m = g_prefs.getUChar("mode", DEFAULT_MODE);
    const uint32_t tl = g_prefs.getUShort("tl", TIMELAPSE_SEC);
    const bool ar = g_prefs.getUChar("ar", REC_AUTO_DEFAULT ? 1 : 0) != 0;
    g_prefs.end();
    g_autoRec = ar;
    g_mode = (m >= 0 && m < MODE_COUNT) ? m : DEFAULT_MODE;
    g_tlSec = tl < 5 ? 5 : (tl > 3600 ? 3600 : tl);
}
static void savePrefs() {
    g_prefs.begin("cctv", false);
    g_prefs.putUChar("mode", (uint8_t)g_mode);
    g_prefs.putUShort("tl", (uint16_t)g_tlSec);
    g_prefs.putUChar("ar", g_autoRec ? 1 : 0);
    g_prefs.end();
}

static inline bool recent(uint32_t t, uint32_t ms) { return t != 0 && (uint32_t)(millis() - t) < ms; }

// ---------------------------------------------------------------------------
static bool initCamera() {
    camera_config_t c = {};
    c.ledc_channel = LEDC_CHANNEL_0;
    c.ledc_timer = LEDC_TIMER_0;
    c.pin_d0 = Y2_GPIO_NUM;
    c.pin_d1 = Y3_GPIO_NUM;
    c.pin_d2 = Y4_GPIO_NUM;
    c.pin_d3 = Y5_GPIO_NUM;
    c.pin_d4 = Y6_GPIO_NUM;
    c.pin_d5 = Y7_GPIO_NUM;
    c.pin_d6 = Y8_GPIO_NUM;
    c.pin_d7 = Y9_GPIO_NUM;
    c.pin_xclk = XCLK_GPIO_NUM;
    c.pin_pclk = PCLK_GPIO_NUM;
    c.pin_vsync = VSYNC_GPIO_NUM;
    c.pin_href = HREF_GPIO_NUM;
    c.pin_sccb_sda = SIOD_GPIO_NUM;
    c.pin_sccb_scl = SIOC_GPIO_NUM;
    c.pin_pwdn = PWDN_GPIO_NUM;
    c.pin_reset = RESET_GPIO_NUM;
    c.xclk_freq_hz = 20000000;
    c.pixel_format = PIXFORMAT_RGB565; // works on OV2640/OV3660/OV5640 alike
    c.frame_size = CAM_FRAMESIZE;      // see config.h
    c.jpeg_quality = 12;               // unused for RGB565
    c.fb_count = 2;
    c.fb_location = CAMERA_FB_IN_PSRAM;
    c.grab_mode = CAMERA_GRAB_LATEST;

    esp_err_t err = esp_camera_init(&c);
    if (err != ESP_OK) {
        Serial.printf("camera init failed: 0x%x\n", err);
        return false;
    }
    return true;
}

static void applySensor() {
    sensor_t *s = esp_camera_sensor_get();
    if (!s) return;
    s->set_vflip(s, g_vflip);
    s->set_hmirror(s, g_mirror);
    s->set_brightness(s, g_bright);
    s->set_saturation(s, CAM_SATURATION);
    if (g_night) { // long exposures and high gain: grainy but you can see
        s->set_exposure_ctrl(s, 1);
        s->set_gain_ctrl(s, 1);
        s->set_aec2(s, 1);
        s->set_ae_level(s, 2);
        s->set_gainceiling(s, GAINCEILING_128X);
    } else {
        s->set_aec2(s, 0);
        s->set_ae_level(s, 0);
        s->set_gainceiling(s, GAINCEILING_2X);
    }
}

// ---------------------------------------------------------------------------
// JPEG output sink for fmt2jpg_cb: appends into a fixed buffer, no big malloc.
struct JpgSink {
    uint8_t *buf;
    size_t cap;
    size_t len;
    bool overflow;
};
static size_t jpgSink(void *arg, size_t, const void *data, size_t len) {
    JpgSink *s = (JpgSink *)arg;
    if (len == 0) return 0;
    if (s->len + len > s->cap) {
        s->overflow = true;
        return 0;
    }
    memcpy(s->buf + s->len, data, len);
    s->len += len;
    return len;
}

static size_t encodeJpg(uint8_t *rgb, uint16_t w, uint16_t h, uint8_t quality, uint8_t *dst, size_t cap) {
    JpgSink sink = {dst, cap, 0, false};
    if (!fmt2jpg_cb(rgb, (size_t)w * h * 2, w, h, PIXFORMAT_RGB565, quality, jpgSink, &sink) || sink.overflow) return 0;
    return sink.len;
}

// Encode into a free SD slot. Returns the slot, or -1 (no free slot / too big).
static int encodeToSlot(uint8_t *rgb, uint16_t w, uint16_t h, uint8_t q, uint32_t *len, uint32_t waitMs) {
    const int s = slotAcquire(waitMs);
    if (s < 0) return -1;
    size_t n = encodeJpg(rgb, w, h, q, g_slot[s], SLOT_BYTES);
    if (!n && q > 62) n = encodeJpg(rgb, w, h, 62, g_slot[s], SLOT_BYTES); // noisy scene: retry smaller
    if (!n) {
        slotRelease(s);
        return -1;
    }
    *len = (uint32_t)n;
    return s;
}

// ---------------------------------------------------------------------------
// The camera driver's JPEG decoder returns RGB565 in a layout that differs between driver
// versions, so decode a known pure-red picture once and learn which one this is.
static void calibrateDecoder() {
    uint8_t src[16 * 16 * 2];
    for (int i = 0; i < 16 * 16; i++) pix_put(src + i * 2, 0xF800);
    const size_t n = encodeJpg(src, 16, 16, 90, g_tmp, FULL_JPG_MAX);
    uint8_t out[16 * 16 * 2];
    memset(out, 0, sizeof(out));
    if (n && jpg2rgb565(g_tmp, n, out, JPG_SCALE_NONE)) {
        const int o = (8 * 16 + 8) * 2;
        g_decLayout = decoderLayoutFromRed(out[o], out[o + 1]);
    }
    Serial.printf("JPEG decoder layout: %d%s\n", g_decLayout, g_decLayout < 0 ? " (rewind/photo/clip viewing disabled)" : "");
}

// The decoder's scale type is called jpg_scale_t in older camera drivers and esp_jpeg_image_scale_t in
// newer ones (Arduino-ESP32 core 3.x), but both still define the JPG_SCALE_* constants. Taking the type
// from a constant, and picking scales from a table, builds on either.
typedef decltype(JPG_SCALE_NONE) DecScale;
static const DecScale kDecScale[4] = {JPG_SCALE_NONE, JPG_SCALE_2X, JPG_SCALE_4X, JPG_SCALE_8X};

// Decode a JPEG and fit it, letterboxed, into g_ovRgb (the Stick-sized picture).
static bool decodeFit(const uint8_t *jpg, size_t len) {
    if (g_decLayout < 0) return false;
    int w, h;
    if (!jpegSize(jpg, len, &w, &h)) return false;
    int div = 1;
    int step = 0; // div = 1 << step
    while ((w / div > DEC_MAXW || h / div > DEC_MAXH) && div < 8) {
        div *= 2;
        step++;
    }
    const DecScale sc = kDecScale[step];
    if (w % div || h % div || w / div > DEC_MAXW || h / div > DEC_MAXH) return false;
    const int ow = w / div, oh = h / div;
    if (!jpg2rgb565(jpg, len, g_decTmp, sc)) return false;
    decoderNormalize(g_decTmp, (size_t)ow * oh, g_decLayout);
    memset(g_ovRgb, 0, RGB_LEN);
    int ox, oy, fw, fh;
    viewFitRect(ow, oh, OUT_W, OUT_H, &ox, &oy, &fw, &fh);
    scaleBoxRectInto565(g_decTmp, ow, oh, 0, 0, ow, oh, g_ovRgb + ((size_t)oy * OUT_W + ox) * 2, OUT_W, fw, fh);
    return true;
}

// ---------------------------------------------------------------------------
// View override: what the Stick sees instead of the live picture.
static File g_clipFile;
static AviReadIO g_clipIO;
static AviInfo g_clipInfo;
static uint32_t g_clipFrames = 0;
static int32_t g_clipPos = 0, g_clipShown = -1;
static uint32_t g_clipLastAdv = 0;
static int g_ovLastMode = OV_NONE;
static int g_ovIdx = -1;
static uint32_t g_ovTick = 0;

static void clipCloseView() {
    if (g_clipFile) g_clipFile.close();
    g_clipFrames = 0;
    g_clipShown = -1;
}

// Returns true when g_ovRgb holds the picture to show.
static bool updateOverride(uint32_t now) {
    int mode = g_ovMode;
    if (mode != g_ovLastMode) {
        if (g_ovLastMode == OV_CLIP) clipCloseView();
        g_ovLastMode = mode;
        g_ovIdx = -1;
        g_ovReload = true;
        g_forceFull = true;
        g_ovTick = now;
    }
    if (mode == OV_NONE) return false;

    char name[32];
    if (g_ovReload) {
        xSemaphoreTake(g_mtx, portMAX_DELAY);
        strlcpy(name, g_ovName, sizeof name);
        xSemaphoreGive(g_mtx);
    }

    if (mode == OV_REWIND) {
        uint32_t pos = g_ovPosT;
        if (g_ovPlay) { // playing forward at normal speed: the viewed moment advances with the clock
            pos += now - g_ovTick;
            g_ovPosT = pos;
            if (g_hist.count == 0 || pos >= g_hist.newestT()) { // caught up with live
                g_ovMode = OV_NONE;
                g_ovPlay = false;
                return false;
            }
        }
        g_ovTick = now;
        if (g_hist.count == 0) { // the mode no longer keeps history
            g_ovMode = OV_NONE;
            return false;
        }
        const int idx = g_hist.indexAtOrBefore(pos);
        if (idx < 0) return false;
        if (idx != g_ovIdx || g_ovReload) {
            const HistEntry *e = g_hist.at(idx);
            if (!decodeFit(g_hist.data(e), e->len)) return false;
            filterApply(g_filter, g_ovRgb, OUT_W, OUT_H, g_rawNew, &g_filtState);
            g_ovIdx = idx;
        }
        g_ovReload = false;
        return true;
    }

    if (mode == OV_PHOTO) {
        if (g_ovReload) {
            g_ovReload = false;
            char path[64];
            snprintf(path, sizeof path, "%s/%s", SD_PHOTO_DIR, name);
            File f = SD_MMC.open(path);
            if (!f) return false;
            const size_t n = f.read(g_readBuf, SLOT_BYTES);
            f.close();
            if (!n || !decodeFit(g_readBuf, n)) {
                g_ovMode = OV_NONE;
                return false;
            }
            g_ovIdx = 1;
        }
        return g_ovIdx == 1;
    }

    if (mode == OV_CLIP) {
        if (g_ovReload) {
            g_ovReload = false;
            clipCloseView();
            char path[64];
            snprintf(path, sizeof path, "%s/%s", SD_CLIP_DIR, name);
            g_clipFile = SD_MMC.open(path);
            if (!g_clipFile) {
                g_ovMode = OV_NONE;
                return false;
            }
            g_clipIO = {&g_clipFile, sdFileRead, sdFileSeek, (uint32_t)g_clipFile.size()};
            if (!aviOpen(g_clipIO, &g_clipInfo)) {
                Serial.printf("clip %s: cannot read (an unfinished recording?)\n", path);
                clipCloseView();
                g_ovMode = OV_NONE;
                return false;
            }
            g_clipFrames = aviReadIndex(g_clipIO, g_clipInfo, g_clipOffs, g_clipSizes, CLIP_MAX_FRAMES);
            g_clipPos = 0;
            g_clipShown = -1;
            g_clipLastAdv = now;
            g_ovPlay = true;
            g_clipLenMs = (uint32_t)((uint64_t)g_clipFrames * g_clipInfo.usPerFrame / 1000);
        }
        if (g_clipFrames == 0) return false;
        const uint32_t us = g_clipInfo.usPerFrame ? g_clipInfo.usPerFrame : 125000;
        const int32_t sk = g_ovSeekMs;
        if (sk) {
            g_ovSeekMs -= sk;
            g_clipPos += (int32_t)((int64_t)sk * 1000 / us);
        }
        if (g_ovPlay) {
            const uint32_t steps = (uint32_t)((uint64_t)(now - g_clipLastAdv) * 1000 / us);
            if (steps) {
                g_clipPos += steps;
                g_clipLastAdv += (uint32_t)((uint64_t)steps * us / 1000);
            }
        } else {
            g_clipLastAdv = now;
        }
        if (g_clipPos >= (int32_t)g_clipFrames - 1) {
            g_clipPos = g_clipFrames - 1;
            if (g_ovPlay) g_ovPlay = false; // reached the end: stay on the last frame
        }
        if (g_clipPos < 0) g_clipPos = 0;
        if (g_clipPos != g_clipShown) {
            const uint32_t n = aviReadFrame(g_clipIO, g_clipOffs[g_clipPos], g_clipSizes[g_clipPos], g_readBuf, SLOT_BYTES);
            if (n) decodeFit(g_readBuf, n); // an unreadable frame keeps the previous picture
            g_clipShown = g_clipPos;        // either way don't retry it endlessly
        }
        g_clipPosMs = (uint32_t)((uint64_t)g_clipPos * us / 1000);
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
static void captureTask(void *) {
    int fails = 0;
    uint32_t winStart = millis(), winFrames = 0;
    uint32_t lastHist = 0, lastRecFrame = 0, lastEventPhoto = 0, lastTimelapse = 0;
    int lastMode = -1;
    uint32_t loopStartUs = micros();
    bool prevActive = false;
    const MotionParams mp = {MOTION_LUMA_THRESH, MOTION_MIN_CELLS, MOTION_BIG_TENTHS, MOTION_GLOBAL_PCT, MOTION_HOLD_MS};

    for (;;) {
        const uint32_t waitStartUs = micros();
        camera_fb_t *fb = esp_camera_fb_get();
        const uint32_t gotUs = micros();
        if (!fb) {
            if (++fails > 30) {
                Serial.println("camera stalled, restarting");
                ESP.restart();
            }
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        fails = 0;
        const uint32_t now = millis();

        if (g_sensorDirty) {
            g_sensorDirty = false;
            applySensor();
        }

        const ModeCaps caps = modeCaps(g_mode);
        if (g_mode != lastMode) { // a new mode starts from a clean slate
            lastMode = g_mode;
            g_motion.reset();
            prevActive = false;
            lastTimelapse = now;
            if (!caps.history) {
                g_hist.init(g_histBuf, HIST_BYTES, g_histEnts, HIST_MAX_FRAMES);
                g_histSpanMs = 0;
            }
        }

        // --- motion, from the whole sensor picture (independent of zoom and filters)
        MotionResult mr = {0, 0, false, false, false};
        if (caps.motion) {
            motionGrid(fb->buf, fb->width, fb->height, g_grid);
            mr = g_motion.update(g_grid, now, mp);
        }
        g_motionLevel = mr.level;
        g_motionBig = mr.big;
        g_motionActive = mr.active;
        const bool rising = mr.active && !prevActive;
        if (rising) g_motionSeq++;
        prevActive = mr.active;

        // --- recording rules
        if (g_recWantStart) { g_recWantStart = false; g_rec.requestStart(); }
        if (g_recWantStop) { g_recWantStop = false; g_rec.requestStop(); }
        // Security records a clip per motion event; Continuous pretends there is always motion, so
        // clips follow each other without a gap.
        const bool contRec = caps.continuous;
        const RecConfig rc = {(caps.autoRec && g_autoRec) || contRec, contRec ? 1000000000u : REC_TAIL_MS,
                              contRec ? REC_CONT_CLIP_MS : REC_MAX_CLIP_MS, contRec ? 0u : REC_COOLDOWN_MS};
        const RecAction act = g_rec.update(now, contRec ? true : mr.active, g_sdOk, rc);
        if (act == REC_START) {
            const SdJob j = {J_VID_OPEN, -1, 0, now, g_nextClip++};
            if (!sdPost(j)) g_rec.recording = false; // writer is swamped: try again next time
            lastRecFrame = 0;
        } else if (act == REC_STOP) {
            const SdJob j = {J_VID_CLOSE, -1, 0, now, 0};
            sdPost(j);
        }
        g_recording = g_rec.recording;
        if (g_rec.recording && now - lastRecFrame >= 1000 / REC_FPS) {
            lastRecFrame = now;
            scaleBoxRect565(fb->buf, fb->width, fb->height, 0, 0, fb->width, fb->height, g_recRgb, REC_WIDTH, REC_HEIGHT);
            uint32_t n;
            const int s = encodeToSlot(g_recRgb, REC_WIDTH, REC_HEIGHT, REC_JPEG_QUALITY, &n, 0);
            if (s >= 0) {
                const SdJob j = {J_VID_FRAME, (int8_t)s, n, now, 0};
                if (!sdPost(j)) slotRelease(s);
            } // else the SD card is behind: drop this frame
        }

        // --- automatic photos: when motion starts (Security), or on a timer (Timelapse)
        if (g_sdOk && g_snapReq == 0) {
            if (caps.eventPhoto && rising && now - lastEventPhoto >= EVENT_PHOTO_GAP_MS) {
                g_snapReq = g_nextPhoto++;
                lastEventPhoto = now;
            } else if (caps.timelapse && now - lastTimelapse >= g_tlSec * 1000) {
                g_snapReq = g_nextPhoto++;
                lastTimelapse = now;
            }
        }

        // --- photo (the full sensor picture)
        if (g_snapReq) {
            const uint32_t no = g_snapReq;
            g_snapReq = 0;
            uint32_t n = 0;
            const int s = g_sdOk ? encodeToSlot(fb->buf, fb->width, fb->height, PHOTO_JPEG_QUALITY, &n, 800) : -1;
            if (s >= 0) {
                const SdJob j = {J_PHOTO, (int8_t)s, n, now, no};
                if (!sdPost(j)) {
                    slotRelease(s);
                    g_photoDoneOk = false;
                    g_photoDoneNo = no;
                }
            } else {
                g_photoDoneOk = false;
                g_photoDoneNo = no;
            }
        }

        // --- the live picture the Stick sees: pan/zoom, then (below) filter
        int cx, cy, cw, ch;
        viewCropRect(g_view, fb->width, fb->height, OUT_W, OUT_H, &cx, &cy, &cw, &ch);
        scaleBoxRect565(fb->buf, fb->width, fb->height, cx, cy, cw, ch, g_newRgb, OUT_W, OUT_H);
        esp_camera_fb_return(fb);

        // --- DVR history (unfiltered; a few frames a second while something moves)
        if (caps.history && now - lastHist >= ((mr.level > 0 || mr.active) ? HIST_ACTIVE_MS : HIST_IDLE_MS)) {
            lastHist = now;
            const size_t n = encodeJpg(g_newRgb, OUT_W, OUT_H, HIST_JPEG_QUALITY, g_tmp, FULL_JPG_MAX);
            if (n) g_hist.push(g_tmp, n, now);
            g_histSpanMs = g_hist.count ? g_hist.newestT() - g_hist.oldestT() : 0;
        }

        filterApply(g_filter, g_newRgb, OUT_W, OUT_H, g_rawNew, &g_filtState);

        // --- live, or rewind / photo / clip
        const bool ov = updateOverride(now);
        const uint8_t *shown = ov ? g_ovRgb : g_newRgb;

        // Which bands differ from what viewers already have?
        uint32_t changed = 0;
        if (g_ds.seq == 0 || g_forceFull) {
            changed = (1u << NBANDS) - 1; // first picture, or the view changed: everything
            g_forceFull = false;
        } else {
            for (int i = 0; i < NBANDS; i++) {
                const size_t off = (size_t)i * BAND_H * OUT_W * 2;
                const size_t px = (size_t)deltaBandRows(i, NBANDS, BAND_H, OUT_H) * OUT_W;
                if (bandChanged(g_refRgb + off, shown + off, px, DELTA_PIX_THRESH, DELTA_PIX_COUNT, DELTA_MEAN_THRESH))
                    changed |= 1u << i;
            }
        }

        if (changed) {
            for (int i = 0; i < NBANDS; i++) { // heavy work outside the lock
                if (!(changed & (1u << i))) continue;
                const int rows = deltaBandRows(i, NBANDS, BAND_H, OUT_H);
                const size_t off = (size_t)i * BAND_H * OUT_W * 2;
                memcpy(g_refRgb + off, shown + off, (size_t)rows * OUT_W * 2);
                rgb565ToRgb332Dither(g_refRgb + off, g_rawNew + (size_t)i * BAND_H * OUT_W, OUT_W, rows, i * BAND_H);
            }
            xSemaphoreTake(g_mtx, portMAX_DELAY);
            const uint32_t seq = g_ds.seq + 1;
            for (int i = 0; i < NBANDS; i++) {
                if (!(changed & (1u << i))) continue;
                const int rows = deltaBandRows(i, NBANDS, BAND_H, OUT_H);
                const size_t o = (size_t)i * BAND_H * OUT_W;
                memcpy(g_raw + o, g_rawNew + o, (size_t)rows * OUT_W);
                g_ds.bandSeq[i] = seq;
            }
            g_ds.seq = seq;
            xSemaphoreGive(g_mtx);
            g_updates++;
        }

        // Strip JPEGs for viewers in Photo mode: only bands that are out of date.
        if (recent(g_stripWantedAt, 4000)) {
            for (int i = 0; i < NBANDS; i++) {
                if (g_ds.jpgSeq[i] == g_ds.bandSeq[i]) continue; // only this task writes these
                const int rows = deltaBandRows(i, NBANDS, BAND_H, OUT_H);
                const size_t off = (size_t)i * BAND_H * OUT_W * 2;
                const size_t n = encodeJpg(g_refRgb + off, OUT_W, rows, STRIP_JPEG_QUALITY, g_tmp, STRIP_MAX);
                xSemaphoreTake(g_mtx, portMAX_DELAY);
                if (n) memcpy(g_strip[i], g_tmp, n);
                g_ds.jpgLen[i] = (uint16_t)n; // 0 = could not encode; viewers skip it
                g_ds.jpgSeq[i] = g_ds.bandSeq[i];
                xSemaphoreGive(g_mtx);
            }
        }

        // Whole-picture JPEG for browsers.
        if (recent(g_fullWantedAt, 4000) && g_fullSeq != g_ds.seq && g_ds.seq != 0) {
            const size_t n = encodeJpg(g_refRgb, OUT_W, OUT_H, FULL_JPEG_QUALITY, g_tmp, FULL_JPG_MAX);
            xSemaphoreTake(g_mtx, portMAX_DELAY);
            if (n) {
                memcpy(g_fullJpg, g_tmp, n);
                g_fullLen = n;
            }
            g_fullSeq = g_ds.seq;
            xSemaphoreGive(g_mtx);
        }

        // --- stats
        const uint32_t endUs = micros();
        g_msWait += ((int32_t)(gotUs - waitStartUs) - (int32_t)g_msWait) / 16;
        g_msLoop += ((int32_t)(endUs - loopStartUs) - (int32_t)g_msLoop) / 16;
        loopStartUs = endUs;
        winFrames++;
        if (now - winStart >= 2000) {
            g_fps = winFrames * 1000.0f / (now - winStart);
            winFrames = 0;
            winStart = now;
        }
        vTaskDelay(1); // let idle task / wifi breathe
    }
}

// ---------------------------------------------------------------------------
// Send a buffer, then close the connection. Bruce opens a fresh connection per
// request and reads until Content-Length, so an explicit close avoids any
// keep-alive confusion on either side.
static esp_err_t sendAndClose(httpd_req_t *req, const char *type, const uint8_t *buf, size_t len) {
    httpd_resp_set_type(req, type);
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_set_hdr(req, "Connection", "close");
    esp_err_t r = httpd_resp_send(req, (const char *)buf, len); // sets Content-Length
    httpd_sess_trigger_close(req->handle, httpd_req_to_sockfd(req));
    return r;
}

static uint8_t headerFlags() {
    uint8_t f = 0;
    if (g_recording) f |= DF_REC;
    if (g_sdOk) f |= DF_SD;
    if (g_motionBig) f |= DF_BIG;
    if (g_motionActive) f |= DF_MOTION;
    if (g_ovMode != OV_NONE) f |= DF_OVERRIDE;
    return f;
}

static esp_err_t deltaHandler(httpd_req_t *req) {
    uint32_t since = 0;
    bool jpg = false;
    char q[64];
    if (httpd_req_get_url_query_str(req, q, sizeof(q)) == ESP_OK) {
        char v[16];
        if (httpd_query_key_value(q, "s", v, sizeof(v)) == ESP_OK) since = (uint32_t)strtoul(v, nullptr, 10);
        if (httpd_query_key_value(q, "f", v, sizeof(v)) == ESP_OK) jpg = (v[0] == 'j');
    }
    const uint32_t t0 = millis();
    if (jpg) g_stripWantedAt = t0 | 1;

    size_t total = 0;
    for (;;) {
        xSemaphoreTake(g_mtx, portMAX_DELAY);
        uint32_t seq = 0;
        bool waiting = false;
        const uint32_t mask = deltaPlan(g_ds, since, jpg, NBANDS, &seq, &waiting);
        const uint32_t waited = millis() - t0;
        bool send;
        if (waiting) send = waited >= STRIP_WAIT_MS; // strips still being encoded
        else if (mask) send = true;                  // something to show
        else send = waited >= LONGPOLL_MS;           // nothing yet: hold the request open
        if (send) {
            total = deltaBuild(g_resp, RESP_MAX, g_ds, mask, seq, (uint8_t)g_motionLevel, headerFlags(), jpg, NBANDS,
                               BAND_H, OUT_W, OUT_H, g_raw, (const uint8_t *const *)g_strip);
        }
        xSemaphoreGive(g_mtx);
        if (send) break;
        vTaskDelay(pdMS_TO_TICKS(3));
    }
    if (!total) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "response too large");
        return ESP_FAIL;
    }
    return sendAndClose(req, "application/octet-stream", g_resp, total);
}

// Motion events: long-polls up to ~0.9 s for a new motion event, then answers with the current state.
static esp_err_t motionHandler(httpd_req_t *req) {
    uint32_t last = 0;
    char q[48];
    if (httpd_req_get_url_query_str(req, q, sizeof(q)) == ESP_OK) {
        char v[16];
        if (httpd_query_key_value(q, "s", v, sizeof(v)) == ESP_OK) last = (uint32_t)strtoul(v, nullptr, 10);
    }
    const uint32_t t0 = millis();
    while (g_motionSeq == last && millis() - t0 < 900) vTaskDelay(pdMS_TO_TICKS(20));
    char json[140];
    const int n = snprintf(json, sizeof(json), "{\"ms\":%lu,\"lv\":%d,\"big\":%d,\"act\":%d,\"rec\":%d,\"mode\":%d,\"sd\":%d}",
                           (unsigned long)g_motionSeq, (int)g_motionLevel, g_motionBig ? 1 : 0, g_motionActive ? 1 : 0,
                           g_recording ? 1 : 0, (int)g_mode, g_sdOk ? 1 : 0);
    return sendAndClose(req, "application/json", (const uint8_t *)json, n);
}

// ---- controls ---------------------------------------------------------------------------------
static bool nameOk(const char *n) {
    const size_t l = strlen(n);
    if (l == 0 || l > 24 || strstr(n, "..")) return false;
    for (size_t i = 0; i < l; i++) {
        const char c = n[i];
        if (!(isalnum((unsigned char)c) || c == '_' || c == '.')) return false;
    }
    return true;
}

static esp_err_t ctlHandler(httpd_req_t *req) {
    char q[200] = "", v[40];
    if (httpd_req_get_url_query_str(req, q, sizeof q) != ESP_OK) q[0] = 0;
    const char *msg = "ok";
    char name[32] = "";
    auto has = [&](const char *k) { return httpd_query_key_value(q, k, v, sizeof v) == ESP_OK; };

    if (has("z")) { g_view.zoom10 = viewClamp(atoi(v), VIEW_ZOOM_MIN, VIEW_ZOOM_MAX); g_forceFull = true; }
    if (has("px")) { g_view.px = viewClamp(atoi(v), 0, 100); g_forceFull = true; }
    if (has("py")) { g_view.py = viewClamp(atoi(v), 0, 100); g_forceFull = true; }
    if (has("f")) { g_filter = viewClamp(atoi(v), 0, FILTER_COUNT - 1); g_forceFull = true; }
    if (has("n")) { g_night = atoi(v) != 0; g_sensorDirty = true; }
    if (has("fl")) { g_vflip = atoi(v) != 0; g_sensorDirty = true; }
    if (has("mi")) { g_mirror = atoi(v) != 0; g_sensorDirty = true; }
    if (has("br")) { g_bright = viewClamp(atoi(v), -2, 2); g_sensorDirty = true; }
    if (has("auto")) {
        const bool a = atoi(v) != 0;
        if (a != g_autoRec) {
            g_autoRec = a;
            savePrefs();
        }
    }
    if (has("mode")) {
        const int m = atoi(v);
        if (m >= 0 && m < MODE_COUNT && m != g_mode) {
            g_mode = m;
            savePrefs();
            if (modeCaps(m).needsSd && !g_sdOk) msg = "mode set, but no SD card";
        }
    }
    if (has("tl")) {
        g_tlSec = (uint32_t)viewClamp(atoi(v), 5, 3600);
        savePrefs();
    }

    if (has("rec")) {
        if (!g_sdOk) msg = "no SD card";
        else if (v[0] == 't') { if (g_recording) g_recWantStop = true; else g_recWantStart = true; }
        else if (atoi(v)) g_recWantStart = true;
        else g_recWantStop = true;
    }

    if (has("snap")) {
        if (!g_sdOk) {
            msg = "no SD card";
        } else {
            const uint32_t no = g_nextPhoto++;
            snprintf(name, sizeof name, "IMG_%04u.jpg", (unsigned)no);
            g_snapReq = no;
            const uint32_t t0 = millis();
            while (g_photoDoneNo < no && millis() - t0 < 3500) vTaskDelay(pdMS_TO_TICKS(20));
            msg = (g_photoDoneNo >= no && g_photoDoneOk) ? "saved" : "photo failed";
        }
    }

    if (has("live")) { g_ovMode = OV_NONE; g_ovPlay = false; g_forceFull = true; }
    if (has("rw")) { // rewind: seconds back from now
        if (!modeCaps(g_mode).history) msg = "rewind needs Guard or Security";
        else if (g_hist.count == 0) msg = "no history yet";
        else {
            const uint32_t secs = (uint32_t)viewClamp(atoi(v), 0, 3600);
            if (g_ovMode != OV_REWIND) g_ovPlay = false;
            if (secs == 0) {
                g_ovMode = OV_NONE;
            } else {
                const uint32_t now = millis();
                g_ovPosT = now > secs * 1000 ? now - secs * 1000 : 0;
                if (g_ovPosT < g_hist.oldestT()) g_ovPosT = g_hist.oldestT(); // can't go before the first frame we have
                g_ovMode = OV_REWIND;
            }
            g_ovReload = true;
        }
    }
    if (has("rwp")) { g_ovPlay = atoi(v) != 0; g_ovTick = millis(); }
    if (has("photo") || has("clip")) {
        const bool clip = httpd_query_key_value(q, "clip", v, sizeof v) == ESP_OK;
        if (!clip) httpd_query_key_value(q, "photo", v, sizeof v);
        if (!g_sdOk) msg = "no SD card";
        else if (!nameOk(v)) msg = "bad name";
        else if (g_decLayout < 0) msg = "decoder unavailable";
        else {
            xSemaphoreTake(g_mtx, portMAX_DELAY);
            strlcpy(g_ovName, v, sizeof g_ovName);
            xSemaphoreGive(g_mtx);
            strlcpy(name, v, sizeof name);
            g_ovReload = true;
            g_ovMode = clip ? OV_CLIP : OV_PHOTO;
            g_forceFull = true;
        }
    }
    if (has("pp")) g_ovPlay = atoi(v) != 0;
    if (has("sk")) g_ovSeekMs += atoi(v) * 1000;

    char json[480];
    const int n = snprintf(json, sizeof json,
                           "{\"z\":%d,\"px\":%d,\"py\":%d,\"f\":%d,\"n\":%d,\"fl\":%d,\"mi\":%d,\"br\":%d,\"rec\":%d,"
                           "\"auto\":%d,\"sd\":%d,\"free\":%lu,\"ov\":%d,\"ago\":%lu,\"hist\":%lu,\"play\":%d,\"mode\":%d,\"tl\":%lu,"
                           "\"cpos\":%lu,\"clen\":%lu,\"name\":\"%s\",\"msg\":\"%s\"}",
                           g_view.zoom10, g_view.px, g_view.py, (int)g_filter, g_night ? 1 : 0, g_vflip ? 1 : 0,
                           g_mirror ? 1 : 0, (int)g_bright, g_recording ? 1 : 0, g_autoRec ? 1 : 0, g_sdOk ? 1 : 0,
                           (unsigned long)g_sdFreeMB, (int)g_ovMode, (unsigned long)(g_ovMode == OV_REWIND ? (millis() - g_ovPosT) / 1000 : 0),
                           (unsigned long)(g_histSpanMs / 1000), g_ovPlay ? 1 : 0, (int)g_mode, (unsigned long)g_tlSec,
                           (unsigned long)(g_clipPosMs / 1000),
                           (unsigned long)(g_clipLenMs / 1000), name, msg);
    return sendAndClose(req, "application/json", (const uint8_t *)json, n);
}

// ---- files --------------------------------------------------------------------------------------
static esp_err_t filesHandler(httpd_req_t *req) {
    char q[64], d[12] = "photos";
    if (httpd_req_get_url_query_str(req, q, sizeof q) == ESP_OK) httpd_query_key_value(q, "d", d, sizeof d);
    const bool clips = strcmp(d, "clips") == 0;
    SdEntry ents[24];
    const int n = g_sdOk ? sdList(clips ? SD_CLIP_DIR : SD_PHOTO_DIR, clips ? "VID_" : "IMG_", ents, 24) : 0;
    char *json = (char *)malloc(1500);
    if (!json) return ESP_FAIL;
    int o = snprintf(json, 1500, "{\"d\":\"%s\",\"sd\":%d,\"free\":%lu,\"f\":[", clips ? "clips" : "photos", g_sdOk ? 1 : 0,
                     (unsigned long)g_sdFreeMB);
    for (int i = 0; i < n && o < 1400; i++)
        o += snprintf(json + o, 1500 - o, "%s[\"%s_%04u.%s\",%u]", i ? "," : "", clips ? "VID" : "IMG",
                      (unsigned)ents[i].no, clips ? "avi" : "jpg", (unsigned)ents[i].size);
    o += snprintf(json + o, 1500 - o, "]}");
    const esp_err_t r = sendAndClose(req, "application/json", (const uint8_t *)json, o);
    free(json);
    return r;
}

static esp_err_t fileHandler(httpd_req_t *req) {
    char q[96], d[12] = "photos", n[32] = "";
    if (httpd_req_get_url_query_str(req, q, sizeof q) == ESP_OK) {
        httpd_query_key_value(q, "d", d, sizeof d);
        httpd_query_key_value(q, "n", n, sizeof n);
    }
    if (!g_sdOk || !nameOk(n)) {
        httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "not found");
        return ESP_FAIL;
    }
    char path[72];
    snprintf(path, sizeof path, "%s/%s", strcmp(d, "clips") == 0 ? SD_CLIP_DIR : SD_PHOTO_DIR, n);
    File f = SD_MMC.open(path);
    if (!f) {
        httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "not found");
        return ESP_FAIL;
    }
    httpd_resp_set_type(req, strstr(n, ".avi") ? "video/x-msvideo" : "image/jpeg");
    uint8_t *buf = (uint8_t *)malloc(4096);
    esp_err_t r = ESP_OK;
    while (buf && r == ESP_OK) {
        const size_t k = f.read(buf, 4096);
        if (!k) break;
        r = httpd_resp_send_chunk(req, (const char *)buf, k);
    }
    free(buf);
    f.close();
    if (r == ESP_OK) httpd_resp_send_chunk(req, nullptr, 0);
    return r;
}

static esp_err_t galleryHandler(httpd_req_t *req) {
    httpd_resp_set_type(req, "text/html");
    httpd_resp_send_chunk(req, "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
                               "<body style='background:#000;color:#9f9;font:16px monospace;padding:8px'><h3>mini-cctv files</h3>", HTTPD_RESP_USE_STRLEN);
    for (int pass = 0; pass < 2; pass++) {
        const bool clips = pass == 1;
        SdEntry ents[24];
        const int n = g_sdOk ? sdList(clips ? SD_CLIP_DIR : SD_PHOTO_DIR, clips ? "VID_" : "IMG_", ents, 24) : 0;
        httpd_resp_send_chunk(req, clips ? "<h4>Clips (newest first)</h4>" : "<h4>Photos (newest first)</h4>", HTTPD_RESP_USE_STRLEN);
        if (!g_sdOk) httpd_resp_send_chunk(req, "<p>No SD card.</p>", HTTPD_RESP_USE_STRLEN);
        for (int i = 0; i < n; i++) {
            char line[200];
            snprintf(line, sizeof line, "<p><a style='color:#9f9' href='/f?d=%s&n=%s_%04u.%s'>%s_%04u.%s</a> %u KB</p>",
                     clips ? "clips" : "photos", clips ? "VID" : "IMG", (unsigned)ents[i].no, clips ? "avi" : "jpg",
                     clips ? "VID" : "IMG", (unsigned)ents[i].no, clips ? "avi" : "jpg", (unsigned)(ents[i].size / 1024));
            httpd_resp_send_chunk(req, line, HTTPD_RESP_USE_STRLEN);
        }
    }
    return httpd_resp_send_chunk(req, nullptr, 0);
}

// Whole-picture JPEG, copied out so a slow client never stalls capture.
static bool grabFull(uint8_t **buf, size_t *len, uint32_t waitMs) {
    g_fullWantedAt = millis() | 1;
    const uint32_t t0 = millis();
    for (;;) {
        bool ready = false;
        xSemaphoreTake(g_mtx, portMAX_DELAY);
        if (g_fullLen && g_fullSeq == g_ds.seq) {
            *buf = (uint8_t *)malloc(g_fullLen);
            if (*buf) {
                memcpy(*buf, g_fullJpg, g_fullLen);
                *len = g_fullLen;
            }
            ready = true;
        }
        xSemaphoreGive(g_mtx);
        if (ready) return *buf != nullptr;
        if (millis() - t0 >= waitMs) return false;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

static esp_err_t jpgHandler(httpd_req_t *req) {
    uint8_t *buf = nullptr;
    size_t len = 0;
    if (!grabFull(&buf, &len, 800)) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "no frame yet");
        return ESP_FAIL;
    }
    esp_err_t r = sendAndClose(req, "image/jpeg", buf, len);
    free(buf);
    return r;
}

static esp_err_t statusHandler(httpd_req_t *req) {
    char json[460];
    xSemaphoreTake(g_mtx, portMAX_DELAY);
    const uint32_t seq = g_ds.seq;
    xSemaphoreGive(g_mtx);
    const int n = snprintf(json, sizeof(json),
             "{\"fps\":%.1f,\"seq\":%lu,\"updates\":%lu,\"w\":%d,\"h\":%d,\"bands\":%d,\"band_h\":%d,"
             "\"ms_loop\":%lu,\"ms_wait\":%lu,\"motion\":%d,\"mseq\":%lu,\"mode\":%d,\"rec\":%d,\"sd\":%d,\"free_mb\":%lu,"
             "\"hist_s\":%lu,\"dec\":%d,\"free_heap\":%u,\"free_psram\":%u}",
             (double)g_fps, (unsigned long)seq, (unsigned long)g_updates, OUT_W, OUT_H, NBANDS, BAND_H,
             (unsigned long)(g_msLoop / 1000), (unsigned long)(g_msWait / 1000), (int)g_motionLevel,
             (unsigned long)g_motionSeq, (int)g_mode, g_recording ? 1 : 0, g_sdOk ? 1 : 0, (unsigned long)g_sdFreeMB, (unsigned long)(g_histSpanMs / 1000), g_decLayout,
             (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getFreePsram());
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, json, n);
}

static const char INDEX_HTML[] =
    "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>mini-cctv</title><body style='margin:0;background:#000;color:#9f9;font:14px monospace'>"
    "<img id=v style='width:100%;image-rendering:pixelated;display:block'>"
    "<p style='padding:0 8px'><a style='color:#9f9' href=/gallery>photos &amp; clips</a> | <a style='color:#9f9' href=/status>status</a> | "
    "<a style='color:#9f9' href=/jpg>jpg</a> | <a style='color:#9f9' href='/ctl?snap=1'>take photo</a> | "
    "<a style='color:#9f9' href='/ctl?rec=t'>record on/off</a></p>"
    "<script>v.src='http://'+location.hostname+':81/stream'</script>";

static esp_err_t indexHandler(httpd_req_t *req) {
    httpd_resp_set_type(req, "text/html");
    return httpd_resp_send(req, INDEX_HTML, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t streamHandler(httpd_req_t *req) {
    static const char *BOUNDARY = "\r\n--frame\r\n";
    esp_err_t r = httpd_resp_set_type(req, "multipart/x-mixed-replace;boundary=frame");
    if (r != ESP_OK) return r;
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    uint32_t lastSeq = 0;
    for (;;) {
        g_fullWantedAt = millis() | 1;
        xSemaphoreTake(g_mtx, portMAX_DELAY);
        const bool fresh = g_fullLen && g_fullSeq == g_ds.seq && g_fullSeq != lastSeq;
        const uint32_t seq = g_fullSeq;
        uint8_t *buf = nullptr;
        size_t len = 0;
        if (fresh && (buf = (uint8_t *)malloc(g_fullLen))) {
            memcpy(buf, g_fullJpg, g_fullLen);
            len = g_fullLen;
        }
        xSemaphoreGive(g_mtx);
        if (!buf) {
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        lastSeq = seq;
        char hdr[80];
        int hl = snprintf(hdr, sizeof(hdr), "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", (unsigned)len);
        r = httpd_resp_send_chunk(req, BOUNDARY, strlen(BOUNDARY));
        if (r == ESP_OK) r = httpd_resp_send_chunk(req, hdr, hl);
        if (r == ESP_OK) r = httpd_resp_send_chunk(req, (const char *)buf, len);
        free(buf);
        if (r != ESP_OK) break; // client went away
    }
    return r;
}

static void startServers() {
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.lru_purge_enable = true; // Bruce opens a fresh connection per request
    cfg.max_open_sockets = 4;
    cfg.stack_size = 10240;
    cfg.server_port = 80;
    cfg.max_uri_handlers = 12;

    httpd_uri_t uris[] = {
        {"/d", HTTP_GET, deltaHandler, nullptr},   {"/m", HTTP_GET, motionHandler, nullptr},
        {"/ctl", HTTP_GET, ctlHandler, nullptr},   {"/files", HTTP_GET, filesHandler, nullptr},
        {"/f", HTTP_GET, fileHandler, nullptr},    {"/gallery", HTTP_GET, galleryHandler, nullptr},
        {"/jpg", HTTP_GET, jpgHandler, nullptr},   {"/status", HTTP_GET, statusHandler, nullptr},
        {"/", HTTP_GET, indexHandler, nullptr},
    };
    if (httpd_start(&g_httpd, &cfg) == ESP_OK)
        for (auto &u : uris) httpd_register_uri_handler(g_httpd, &u);

    cfg.server_port = 81;
    cfg.ctrl_port += 1;
    cfg.max_open_sockets = 2;
    httpd_uri_t stream = {"/stream", HTTP_GET, streamHandler, nullptr};
    if (httpd_start(&g_stream, &cfg) == ESP_OK) httpd_register_uri_handler(g_stream, &stream);
}

static void startWifi() {
#if USE_STA
    WiFi.mode(WIFI_STA);
    WiFi.begin(STA_SSID, STA_PASS);
    Serial.print("joining " STA_SSID);
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print('.');
    }
    Serial.printf("\nviewer: http://%s/   Bruce app host: http://%s\n", WiFi.localIP().toString().c_str(),
                  WiFi.localIP().toString().c_str());
#else
    WiFi.mode(WIFI_AP);
    WiFi.softAP(CCTV_AP_SSID, CCTV_AP_PASS, CCTV_AP_CHANNEL, 0, 2);
    Serial.printf("AP \"%s\" up. viewer: http://%s/\n", CCTV_AP_SSID, WiFi.softAPIP().toString().c_str());
#endif
    WiFi.setSleep(false);
    WiFi.setTxPower(WIFI_POWER_19_5dBm);
}

static uint8_t *psramAlloc(size_t n) { return (uint8_t *)heap_caps_calloc(1, n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT); }

void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println("\nmini-cctv camera node");

    if (!psramFound()) {
        Serial.println("PSRAM not found: Arduino IDE > Tools > PSRAM = \"OPI PSRAM\" (PlatformIO: qio_opi vs qio_qspi env)");
        for (;;) delay(1000);
    }

    // The camera needs two big contiguous buffers, so it goes first; the history buffer (the
    // biggest) comes next, before the PSRAM gets fragmented.
    if (!initCamera()) {
        Serial.println("camera init failed, rebooting in 5s");
        delay(5000);
        ESP.restart();
    }
    bool ok = true;
    g_histBuf = psramAlloc(HIST_BYTES);
    g_refRgb = psramAlloc(RGB_LEN);
    g_newRgb = psramAlloc(RGB_LEN);
    g_ovRgb = psramAlloc(RGB_LEN);
    g_raw = psramAlloc(RAW_LEN);
    g_rawNew = psramAlloc(RAW_LEN);
    g_fullJpg = psramAlloc(FULL_JPG_MAX);
    g_tmp = psramAlloc(FULL_JPG_MAX);
    g_resp = psramAlloc(RESP_MAX);
    g_recRgb = psramAlloc((size_t)REC_WIDTH * REC_HEIGHT * 2);
    g_decTmp = psramAlloc((size_t)DEC_MAXW * DEC_MAXH * 2);
    g_readBuf = psramAlloc(SLOT_BYTES);
    g_clipOffs = (uint32_t *)psramAlloc(CLIP_MAX_FRAMES * 4);
    g_clipSizes = (uint32_t *)psramAlloc(CLIP_MAX_FRAMES * 4);
    ok = g_refRgb && g_newRgb && g_ovRgb && g_raw && g_rawNew && g_fullJpg && g_tmp && g_resp && g_recRgb && g_decTmp &&
         g_readBuf && g_histBuf && g_clipOffs && g_clipSizes;
    for (int i = 0; i < NBANDS; i++) {
        g_strip[i] = psramAlloc(STRIP_MAX);
        ok = ok && g_strip[i];
    }
    g_mtx = xSemaphoreCreateMutex();
    memset(&g_ds, 0, sizeof(g_ds));
    g_hist.init(g_histBuf, HIST_BYTES, g_histEnts, HIST_MAX_FRAMES);
    g_motion.reset();
    g_rec.init();
    filterStateInit(&g_filtState);

    if (!ok || !g_mtx) {
        Serial.printf("out of memory (free PSRAM %u), rebooting in 5s. Lower HIST_BYTES in config.h?\n", (unsigned)ESP.getFreePsram());
        delay(5000);
        ESP.restart();
    }
    calibrateDecoder();

    loadPrefs();
    g_sdOk = sdBegin(true);
    if (!sdStartWriter()) {
        Serial.println("SD writer could not start (out of memory); photos and recording disabled");
        g_sdOk = false;
    }
    Serial.printf("mode: %s (%s)\n", modeName(g_mode), modeBlurb(g_mode));
    if (!g_sdOk) {
        Serial.println("WARNING: no usable SD card. Live view, motion alerts and rewind still work; photos and "
                       "recording are off until a FAT32 card is inserted (it is picked up automatically).");
        if (modeCaps(g_mode).needsSd) Serial.printf("WARNING: %s mode really wants an SD card.\n", modeName(g_mode));
    }

    startWifi();
    startServers();
    // the JPEG encoder keeps big state on the stack, so give the task plenty
    xTaskCreatePinnedToCore(captureTask, "capture", 24576, nullptr, 2, nullptr, 1);
    Serial.println("streaming");
}

void loop() {
    delay(5000);
    static uint32_t lastSdTry = 0;
    if (!g_sdOk && SD_ENABLE && g_jobQ && millis() - lastSdTry > 30000) { // card inserted after boot?
        lastSdTry = millis();
        SD_MMC.end();
        if (sdBegin(false)) {
            g_sdOk = true;
            Serial.println("SD: card found and mounted, photos and recording are on");
        }
    }
    Serial.printf("fps=%.1f seq=%lu updates=%lu loop=%lums wait=%lums mode=%s motion=%d rec=%d sd=%d hist=%ds heap=%u psram=%u\n",
                  (double)g_fps, (unsigned long)g_ds.seq, (unsigned long)g_updates, (unsigned long)(g_msLoop / 1000),
                  (unsigned long)(g_msWait / 1000), modeName(g_mode), (int)g_motionLevel, g_recording ? 1 : 0, g_sdOk ? 1 : 0,
                  (int)(g_histSpanMs / 1000),
                  (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getFreePsram());
}
