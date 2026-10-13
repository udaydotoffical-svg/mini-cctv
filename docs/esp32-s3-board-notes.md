# ESP32-S3 CAM board: field notes for another project

Written from the mini-cctv project (`udaydotoffical-svg/mini-cctv`). Every line is tagged:
**[verified]** = seen working on the real board (boot log or running firmware),
**[built]** = compiles and passes host tests, not run on the board,
**[general]** = standard ESP32-S3 knowledge, not checked on this board,
**[unknown]** = not confirmed. Do not treat [general] or [unknown] as facts about this board.

## 1. The board

- **OceanLabz ESP32-S3-WROOM N16R8 CAM** [verified]. Module ESP32-S3-WROOM-1 N16R8: dual-core Xtensa LX7 up to 240 MHz, **16 MB flash (quad), 8 MB octal PSRAM**, WiFi 2.4 GHz + BLE 5 (no classic Bluetooth, no Ethernet).
- Two USB-C ports: one goes through a USB-UART bridge, the other is the chip's native USB (GPIO19 D-, GPIO20 D+) [general; the exact labelling on this board is [unknown], so try the other port if the serial monitor stays empty]. Native USB serial needs "USB CDC On Boot: Enabled".
- microSD slot and a camera connector (DVP, 24-pin-style). The vendor publishes no pinout; the pins below were found by matching boards that share the layout and then proven on the board.
- Camera sensor model: **[unknown]**. The code asks the driver for RGB565 and works with OV2640 / OV3660 / OV5640 alike.

## 2. Pins (proven on this board)

Camera = the **ESP32-S3-EYE map** (same as Freenove ESP32-S3 WROOM CAM) [verified, camera streams]:

| Signal | GPIO | | Signal | GPIO |
|---|---|---|---|---|
| XCLK | 15 | | D0 (Y2) | 11 |
| SIOD (SDA) | 4 | | D1 (Y3) | 9 |
| SIOC (SCL) | 5 | | D2 (Y4) | 8 |
| VSYNC | 6 | | D3 (Y5) | 10 |
| HREF | 7 | | D4 (Y6) | 12 |
| PCLK | 13 | | D5 (Y7) | 18 |
| PWDN / RESET | -1 / -1 (not wired) | | D6 (Y8) | 17 |
| | | | D7 (Y9) | 16 |

microSD, **1-bit SD_MMC mode** [verified: `SD: ok, 7.5 GB card`, clips recorded]: **CLK 39, CMD 38, D0 40**.
Arduino: `SD_MMC.setPins(39, 38, 40); SD_MMC.begin("/sdcard", true);` (the `true` is 1-bit mode). FAT32 card. SPI-wired SD (as on the XIAO ESP32S3 Sense) is a different thing and does not apply.

Taken by the above: GPIO 4-13, 15-18, 38-40.
Do **not** use on an N16R8 [general]: GPIO 26-32 (flash), **35, 36, 37 (octal PSRAM)**, 19/20 (native USB, unless you give it up), 0/3/45/46 (boot strapping; careful), 43/44 (UART0 TX/RX, used for the serial monitor).
Probably free [general, **not checked against a schematic**]: 1, 2, 14, 21, 41, 42, 47, 48. 48 may drive an on-board RGB LED on some boards; check before wiring. The mini-cctv firmware does not use any of these.
Other boards' camera maps (do NOT use here): XIAO ESP32S3 Sense uses XCLK=10, SIOD=40, SIOC=39 which collides with this board's SD pins; the "CAM_LCD" map uses XCLK=40, SIOD=17.

## 3. Build settings that work

Arduino IDE / arduino-cli [verified in IDE, built on core 3.3.12 and 2.0.17 with arduino-cli/PlatformIO]:

| Setting | Value |
|---|---|
| Board | ESP32S3 Dev Module |
| **PSRAM** | **OPI PSRAM** (QSPI or Disabled: the chip boots wrong or PSRAM is not found) |
| Flash size | 16 MB (128 Mb) |
| Flash mode | QIO |
| Partition scheme | "16M Flash (3MB APP/9.9MB FATFS)" (`app3M_fat9M_16MB`); any scheme with a >=2 MB app works |
| USB CDC On Boot | Enabled if using the native-USB port for Serial |

arduino-cli FQBN: `esp32:esp32:esp32s3:PSRAM=opi,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,FlashMode=qio`.
PlatformIO: `platform = espressif32@6.9.0`, `board = esp32-s3-devkitc-1`, `board_build.arduino.memory_type = qio_opi`, `board_upload.flash_size = 16MB`, `board_build.partitions = default_16MB.csv`, `-DBOARD_HAS_PSRAM`.
Serial monitor 115200. If upload cannot connect: hold BOOT, tap RESET, release BOOT.
Checking PSRAM at runtime: `psramFound()` must be true, else stop with a clear message (the mini-cctv sketch does).

## 4. Camera driver notes (esp32-camera)

- Config that works [verified]: `pixel_format = PIXFORMAT_RGB565`, `frame_size = FRAMESIZE_VGA` (640x480), `xclk_freq_hz = 20000000`, `fb_count = 2`, `fb_location = CAMERA_FB_IN_PSRAM`, `grab_mode = CAMERA_GRAB_LATEST`, `ledc_channel 0 / timer 0`.
- **Arduino-ESP32 core 2.x vs 3.x differ** in the bundled camera driver. Things that bit this project: the JPEG decode scale type (`jpg_scale_t`) is not available on core 3.x, and the byte order of the decoder's RGB565 output differs between versions (mini-cctv decodes a known red picture at boot to detect the layout). If you use the JPEG decoder, test on the exact core version you ship.
- Sensor tuning used: `set_vflip/hmirror/brightness/saturation`, night = `set_exposure_ctrl 1, set_gain_ctrl 1, set_aec2 1, set_ae_level 2, set_gainceiling GAINCEILING_128X`; day = `aec2 0, ae_level 0, gainceiling 2X`.

## 5. Memory and speed (measured on this board)

- Big buffers go to PSRAM: `heap_caps_calloc(1, n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)`. Allocate the largest first, before PSRAM fragments. Internal SRAM (~320 KB total, ~230 KB left after the sketch's globals) is for small, hot data and task stacks.
- Pipeline: capture task pinned to core 1 (24 KB stack, priority 2); SD writer task pinned to core 0 (8 KB stack) with a small buffer pool so a slow card never stalls capture.
- Throughput with 640x480 RGB565 + motion detection + scaling + HTTP delta stream: **about 5.6 updates/s idle, about 3.6 while also encoding and recording a clip** (the loop is processing-bound, the sensor wait is not the limit). JPEG encoding of a full frame in software is the expensive step.
- Firmware image ~1.29 MB (40% of a 3 MB app partition).

## 6. WiFi, SD, OTA

- WiFi AP + STA both work. AP: `WiFi.softAP(ssid, pass, channel, 0, 2)` (max 2 clients), `WiFi.setSleep(false)`, `WiFi.setTxPower(WIFI_POWER_19_5dBm)` [verified]. Stick on the AP gets ~5 fps streams.
- HTTP server: `esp_http_server` [verified].
- SD with no card prints `sdmmc_init_ocr: send_op_cond (1) returned 0x107` then fails: harmless, it only means no card answered. `E ... esp_core_dump_flash: Incorrect size of core dump image` at boot is also harmless (unused core-dump partition).
- OTA from GitHub (camera downloads its own firmware): `esp_http_client` + `esp_crt_bundle_attach` for HTTPS, `Update.begin / setMD5 / writeStream / end`, then `ESP.restart()`. **[built], not run on the board**: the TLS download and the AP -> STA -> back switch are unverified on hardware.

## 7. Power and other cautions

- [general] Camera + WiFi at 19.5 dBm + SD writes pull current spikes; a weak USB cable/port causes brownouts and random resets. Use a good cable and a 5 V / 1 A+ supply.
- [general] The board gets warm under continuous streaming; leave airflow.
- The camera AP password in this project is still the default; change anything you ship.

## 8. Where the working code is

`https://github.com/udaydotoffical-svg/mini-cctv`, folder `firmware/mini_cctv/`:
`camera_pins.h` (pin maps), `config.h` (SD pins, WiFi, tuning), `mini_cctv.ino` (`initCamera()`, `applySensor()`, PSRAM allocation, tasks), `sdstore.h` (SD_MMC setup), `otaupdate.h` (OTA), `platformio.ini` (envs). Reading `initCamera()` and `sdstore.h` is the fastest way to copy a known-good setup.
