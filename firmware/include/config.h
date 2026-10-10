#pragma once

// ---------------------------------------------------------------------------
// WiFi
// Default: the camera is its own access point, so no router is needed.
// The Stick joins CCTV_AP_SSID and fetches http://192.168.4.1/jpg
// ---------------------------------------------------------------------------
#define CCTV_AP_SSID    "MiniCCTV"
#define CCTV_AP_PASS    "cctv12345" // must be >= 8 chars
#define CCTV_AP_CHANNEL 6

// Set to 1 to join an existing router instead (then point the Bruce app at the
// IP printed on the serial monitor and set JOIN_CAM_WIFI = false there).
#define USE_STA  0
#define STA_SSID ""
#define STA_PASS ""

// ---------------------------------------------------------------------------
// Frame sent to the Stick.  240x128 = exactly 15x8 JPEG MCUs (16x16), fits the
// Stick Plus2 panel (240x135) with no ragged edges and decodes fast.
// Must be multiples of 16.
// ---------------------------------------------------------------------------
#define OUT_W        240
#define OUT_H        128
#define JPEG_QUALITY 60 // 1..100, higher = bigger frames (60 ~ 6-9 KB)

// Flip these if the picture is upside down / mirrored on your board.
#define CAM_VFLIP   0
#define CAM_HMIRROR 0
