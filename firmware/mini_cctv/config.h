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
// Frame sent to the Stick.  240x128 = exactly 15x8 JPEG MCUs (16x16), fits the
// Stick Plus2 panel (240x135) with no ragged edges and decodes fast.
// Must be multiples of 16.
// ---------------------------------------------------------------------------
#define OUT_W        240
#define OUT_H        128
#define JPEG_QUALITY 85 // 1..100, higher = sharper + bigger frames (85 ~ 5-12 KB)

// What the sensor captures before we shrink it to OUT_W x OUT_H. Capturing more
// pixels than we send and averaging them down gives a much cleaner picture.
//   FRAMESIZE_VGA  (640x480)  sharper, ~8-12 fps   <- default
//   FRAMESIZE_QVGA (320x240)  faster, ~15+ fps, softer
#define CAM_FRAMESIZE FRAMESIZE_VGA

// Sensor tuning. These match the stock CameraWebServer sketch for the
// ESP32-S3-EYE pinout (vflip on, brightness +1, saturation 0).
#define CAM_VFLIP      1
#define CAM_HMIRROR    0
#define CAM_BRIGHTNESS 1 // -2..2
#define CAM_SATURATION 0 // -2..2
