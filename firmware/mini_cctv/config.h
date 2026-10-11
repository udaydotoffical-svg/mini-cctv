#pragma once

// ---------------------------------------------------------------------------
// WiFi
// Default: the camera is its own access point, so no router is needed.
// The Stick joins CCTV_AP_SSID and fetches http://192.168.4.1/jpg
// ---------------------------------------------------------------------------
#define CCTV_AP_SSID    "ESP32-CAM-S3"
#define CCTV_AP_PASS    "12345678" // must be >= 8 chars
#define CCTV_AP_CHANNEL 6

// Set to 1 to join an existing router instead (then point the Bruce app at the
// IP printed on the serial monitor and set JOIN_CAM_WIFI = false there).
#define USE_STA  0
#define STA_SSID ""
#define STA_PASS ""

// ---------------------------------------------------------------------------
// Picture sent to the Stick: exactly its screen, 240x135.
// ---------------------------------------------------------------------------
#define OUT_W 240
#define OUT_H 135

// What the sensor captures before we shrink it to OUT_W x OUT_H. Capturing more
// pixels than we send and averaging them down gives a much cleaner picture.
//   FRAMESIZE_VGA  (640x480)  sharper, ~8-12 fps   <- default
//   FRAMESIZE_QVGA (320x240)  faster, ~15+ fps, softer
#define CAM_FRAMESIZE FRAMESIZE_VGA

// JPEG quality 1..100. STRIP is the Stick's "Photo" mode (small 240x16 strips);
// FULL is the whole-frame JPEG for the browser page.
#define STRIP_JPEG_QUALITY 92
#define FULL_JPEG_QUALITY  85

// Only bands of the picture that really changed are sent. A band is resent when
// DELTA_PIX_COUNT pixels moved by more than DELTA_PIX_THRESH (sum of the three
// channel differences, 0..765), or when the whole band drifted by more than
// DELTA_MEAN_THRESH on average (0..255, catches slow exposure changes).
// Raise them if sensor noise makes bands resend on a still scene; lower them if
// small movements get missed.
#define DELTA_PIX_THRESH  48
#define DELTA_PIX_COUNT   8
#define DELTA_MEAN_THRESH 3

// Sensor tuning. These match the stock CameraWebServer sketch for the
// ESP32-S3-EYE pinout (vflip on, brightness +1, saturation 0).
#define CAM_VFLIP      1
#define CAM_HMIRROR    0
#define CAM_BRIGHTNESS 1 // -2..2
#define CAM_SATURATION 0 // -2..2

// ---------------------------------------------------------------------------
// microSD card (FAT32, wired 1-bit SD_MMC). Used for photos and video clips.
// The pins differ between boards; 39/38/40 are what the Freenove / ESP32-S3-EYE style
// boards use (CLK / CMD / D0). If the Serial Monitor says "SD: init failed", the pins are
// the first thing to check on your board's schematic.
// ---------------------------------------------------------------------------
#define SD_ENABLE      1
#define SD_CLK_PIN     39
#define SD_CMD_PIN     38
#define SD_D0_PIN      40
#define SD_MIN_FREE_MB 150 // oldest clips are deleted when less than this is free

// ---------------------------------------------------------------------------
// Photos and video
// ---------------------------------------------------------------------------
#define PHOTO_JPEG_QUALITY 92 // photos are the full 640x480 sensor picture
#define REC_WIDTH          320
#define REC_HEIGHT         240
#define REC_FPS            8
#define REC_JPEG_QUALITY   72
#define REC_AUTO_DEFAULT   1      // start clips automatically when motion is seen
#define REC_TAIL_MS        8000   // keep recording this long after motion stops
#define REC_MAX_CLIP_MS    120000 // clips are cut at this length
#define REC_COOLDOWN_MS    2000

// ---------------------------------------------------------------------------
// DVR rewind: whole-picture JPEGs of the last minutes, kept in PSRAM. A frame is stored 4 times
// a second while something moves and every 2 s while the scene is still.
// ---------------------------------------------------------------------------
#define HIST_BYTES       (3 * 1024 * 1024)
#define HIST_MAX_FRAMES  700
#define HIST_ACTIVE_MS   250
#define HIST_IDLE_MS     2000
#define HIST_JPEG_QUALITY 78

// ---------------------------------------------------------------------------
// Motion detection (see motion.h). Works on an 80x60 brightness grid of the whole sensor
// picture, so it keeps guarding the full scene even while the Stick is zoomed in.
// ---------------------------------------------------------------------------
#define MOTION_LUMA_THRESH 18   // a cell must change by this much (0..255) to count as moving
#define MOTION_MIN_CELLS   6    // of 4800 cells, at least this many to count as motion
#define MOTION_BIG_TENTHS  30   // moving area in tenths of a percent that counts as "person-sized"
#define MOTION_GLOBAL_PCT  50   // more than this percent changing at once = lights, not motion
#define MOTION_HOLD_MS     3000 // motion stays "active" this long after it stops

// ---------------------------------------------------------------------------
// Operating mode (see modes.h). This is only the mode used the very first time; after that the
// camera remembers whatever the Stick (or the /ctl?mode= link) last set, across power cycles.
//   MODE_LIVE  MODE_GUARD  MODE_SECURITY  MODE_CONTINUOUS  MODE_TIMELAPSE
// ---------------------------------------------------------------------------
#define DEFAULT_MODE      MODE_SECURITY
#define TIMELAPSE_SEC     60     // photo interval in MODE_TIMELAPSE (changeable from the Stick)
#define REC_CONT_CLIP_MS  300000 // clips are cut at this length in MODE_CONTINUOUS
#define EVENT_PHOTO_GAP_MS 8000  // at most one "motion started" photo this often

// ---- the box drawn around whatever is moving (the Stick's "Person box" setting)
#define BOX_DEFAULT  1     // on at first boot
#define BOX_THICK    2     // outline width in pixels
#define BOX_PAD      1     // grow the box by this many pixels
#define BOX_HOLD_MS  400   // keep showing a box this long after the last frame that had one

#define SHARPEN_DEFAULT 1  // mild sharpening of the picture sent to the Stick (Settings -> Sharpen)
