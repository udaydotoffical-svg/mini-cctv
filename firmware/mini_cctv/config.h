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
