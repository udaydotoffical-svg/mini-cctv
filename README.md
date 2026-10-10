# mini-cctv

Live camera feed from an **ESP32-S3 camera board** to a **JS app running inside Bruce** on an **M5StickC Plus2**, with a menu, exit buttons and two picture modes.

```
 ESP32-S3 CAM                                            M5StickC Plus2 (Bruce, full build)
┌──────────────────────────┐   WiFi (S3 is the AP)      ┌───────────────────────────────────┐
│ sensor VGA -> 240x135    │                            │ bruce/MiniCCTV.js                 │
│ split into 9 bands       │   GET /d?f=j&s=<last seen> │  wifi.httpFetch(..., binary)      │
│ keep only bands that     │ ◀───────────────────────── │  draw only the bands it receives  │
│ really changed           │ ──── changed bands ──────▶ │  display.drawJpg  (Photo mode)    │
│ firmware/mini_cctv       │                            │  display.drawBitmap (Fast mode)   │
└──────────────────────────┘                            └───────────────────────────────────┘
```

## Why not USB OTG?

The Stick Plus2 is built around a plain ESP32 (ESP32-PICO-V3-02). That chip has no USB peripheral at all, so it can't be a USB host or device. Its USB-C port goes to a CH9102 USB-to-serial chip, used for charging and flashing. An S3 camera can act as a USB device, but nothing on the Stick can host it.

The Grove port (G32/G33) isn't an option either. Bruce's JS `serial` module only talks to the USB serial port, and there is no JS API for a UART on the Grove pins.

That leaves **WiFi**, and Bruce's JS has what it needs: `wifi.httpFetch(..., {responseType:'binary'})` returns a `Uint8Array`, and `display.drawJpg` / `display.drawBitmap` draw from one directly. No SD card, no files.

## On the Stick

Run **JS Interpreter → MiniCCTV.js**. A menu comes up:

| | |
|---|---|
| **Watch live** | joins the camera's WiFi, checks the camera, starts the picture |
| **Mode: Photo / Fast** | choose the picture mode (also switchable while watching) |
| **Exit** | leaves the app |

The Stick has two side buttons and the front M5 button. Bruce calls them **UP** (Prev), **DOWN** (Next) and **M5** (Sel).

| Where | UP | DOWN | M5 |
|---|---|---|---|
| Menu | move up | move down | select |
| Watching | back to menu | Photo ⇄ Fast | show / hide the info line |
| Anywhere | **UP + DOWN together quit the app** | | |

The info line at the top of the picture shows the mode, how many picture updates per second arrive (`still` when the scene isn't changing) and how many milliseconds the last update spent on the network (`net`) and being drawn (`draw`). If something is slow, those two numbers say which half to look at. Errors (`http 500`, `short 123/456`, `net ...`) appear there too.

### The two modes

| | Photo (default) | Fast |
|---|---|---|
| Colour | 16-bit, the most the Stick's screen can show | 8-bit (256 colours), dithered |
| Blinking | Moving areas blink briefly | Never blinks |
| Cost | JPEG decode per changed band | none, the data is drawn as is |

Photo is the best-looking picture the Stick can show. Its blink is Bruce's: `drawJpg` clears the area it paints before decoding into it, so a full-frame JPEG would flash the whole screen every frame. Because the camera sends only the bands that changed, still parts of the scene never blink at all and only the strips with movement do. If that bothers you, press DOWN for Fast.

## Setup

### 1. Flash the camera (Arduino IDE)

Open `firmware/mini_cctv/mini_cctv.ino` (the files in that folder go together). No extra libraries: the camera driver ships with the ESP32 board package.

| Tools menu | Setting |
|---|---|
| Board | `XIAO_ESP32S3` (or `ESP32S3 Dev Module` for a generic S3 CAM board) |
| **PSRAM** | **`OPI PSRAM`**. Required: with PSRAM disabled the sketch stops at boot |
| USB CDC On Boot | `Enabled` (so the Serial Monitor works on native-USB boards like the XIAO) |
| Flash Size / Partition / CPU | 8MB or more / default / 240MHz |

Camera pins: at the top of `mini_cctv.ino`, choose `CAMERA_MODEL_ESP32S3_EYE` (default; Freenove WROOM CAM and most S3 CAM clones), `CAMERA_MODEL_XIAO_ESP32S3` (XIAO ESP32S3 Sense) or `CAMERA_MODEL_ESP32S3_CAM_LCD`. For another board, add a pin block to `camera_pins.h`. `CAM_VFLIP` is on by default (the S3-EYE sensor is mounted upside down); if the picture is still wrong, change `CAM_VFLIP` / `CAM_HMIRROR` in `config.h`.

PlatformIO also works: `cd firmware && pio run -e s3cam -t upload`, with envs `s3cam`, `s3cam_qspi`, `s3cam_lcd` and `xiao_s3`. It builds the same sketch folder.

On boot the camera starts a WiFi network **`ESP32-CAM-S3`** (password `12345678`; change both in `config.h`). Join it from a phone and open `http://192.168.4.1/` to check the camera works before involving the Stick.

### 2. Put the app on the Stick

Copy `bruce/MiniCCTV.js` to `/BruceJS/` on the Stick's SD card, or upload it through the Bruce WebUI. It joins the `ESP32-CAM-S3` network by itself, so you don't need to connect WiFi in Bruce first. The config block at the top of the file must agree with `config.h` (SSID, password, `OUT_W`/`OUT_H`). If they don't, the app says so on screen instead of drawing garbage.

### Using your router instead

Set `USE_STA 1` and your SSID and password in `config.h`. Read the IP from the serial monitor. In `MiniCCTV.js` set `CAM_HOST` to `http://<that ip>` and `JOIN_CAM_WIFI = false`, then connect the Stick to the same network from Bruce's WiFi menu.

## Tuning (`firmware/mini_cctv/config.h`)

| Setting | Effect |
|---|---|
| `CAM_FRAMESIZE` | `FRAMESIZE_VGA` (default): the sensor captures 640x480 and it is averaged down to 240x135, which is sharper and less noisy. `FRAMESIZE_QVGA` is faster but softer |
| `STRIP_JPEG_QUALITY` | Photo mode quality, 92 by default. Raise for even cleaner colour, lower for fewer bytes |
| `DELTA_PIX_THRESH`, `DELTA_PIX_COUNT`, `DELTA_MEAN_THRESH` | How much a band has to change before it's resent. Raise them if a still scene keeps updating (sensor noise); lower them if small movements get missed |

The panel is only 240x135, so there's a ceiling on sharpness that no setting can lift.

## How it works

- **Bands.** The camera cuts the 240x135 picture into nine bands of 16 rows (16 is the JPEG block height). Each time the picture changes it numbers the update (`seq`) and remembers, per band, the update at which that band last changed.
- **Stateless updates.** The Stick asks "what changed since update N?" (`/d?f=j&s=N`) and gets only those bands, plus the new `seq` for next time. A lost reply is repaired by asking again. A camera that reboots counts from 1 again, which the Stick notices and restarts from a full picture. The format is documented in `firmware/mini_cctv/delta.h`.
- **Long-polling.** If nothing has changed the camera holds the request open for up to 150 ms instead of answering "nothing". A quiet scene costs almost no traffic, and a change shows up as soon as it happens.
- **Noise.** Bands are compared with a tolerance, and a band that hasn't really changed isn't touched. Still parts of the picture stay perfectly steady instead of crawling with sensor noise.
- **Cleaner scaling.** The sensor captures VGA and every source pixel under each output pixel is averaged, rather than skipping pixels.
- **Fast mode** dithers to 8-bit with an 8x8 ordered pattern. The pattern is fixed to the screen so it doesn't shimmer, and brightness is preserved on average.
- **Why the camera does the work.** Bruce decodes baseline JPEGs only and can't scale or stream. `httpFetch` buffers a whole reply and needs `Content-Length`, so the camera answers with fixed-size replies and closes the connection afterwards.
- **Quirks of Bruce that shaped this** (read from its source): `drawBitmap` at 16 bits would be drawn as a 1-bit bitmap on the Stick's display library, so Fast mode uses 8 bits; and a `subarray` view passed to `drawBitmap`/`drawJpg` is drawn from the start of its buffer, so the app copies each band into its own array first.
- **Power.** Power the camera from its own USB supply. Don't run it off the Stick's Grove 5V: the camera plus WiFi draws a few hundred mA and the Stick has a 200 mAh battery.

`/jpg` (a whole-picture JPEG) and `/stream` (MJPEG on port 81) remain for browsers and VLC.

## Testing without hardware

```bash
tools/run_tests.sh
```

Needs g++, Python 3 with Pillow, Node and curl. It runs:

- **`tools/test_scaler.cpp`**, under AddressSanitizer: the averaging scaler, the dither (colour channels, brightness, band seams) and the change detection (noise ignored, small objects and drift caught).
- **`tools/test_delta.cpp`**, under AddressSanitizer: the band protocol (first picture, deltas, up to date, reboot, strips not yet encoded, buffer overrun) and it writes "golden" replies in the camera's exact byte format.
- **`tools/test_app.js`**: the real `MiniCCTV.js` with mocked Bruce modules, driven through the menu with scripted button presses. It checks the Stick's screen against the camera's picture, parses the golden replies with the app's actual parser, and covers an unreachable camera, a failed WiFi join, a config mismatch, an outage mid-stream, truncated replies and a camera reboot. The mocks enforce what Bruce really does, for example `drawBitmap` rejects a wrong-size array and array views with an offset are rejected.

`tools/fake_cam.py` is a stand-in camera that speaks the same protocol. You can point a real Stick at it from a laptop on the same WiFi: set `CAM_HOST` to the laptop's address and `JOIN_CAM_WIFI = false`. That tests the Stick without the S3.

## Status

- **Verified here:**
  - The Bruce API contract, from `pr3y/Bruce` at `a59213f` and its mquickjs fork: `httpFetch` binary, `drawBitmap` 8-bit through the real TFT_eSPI code, the `drawJpg` renderer's handling of strips (including the last 7-row one), typed-array copying.
  - The camera and app logic with the test suite above.
  - The firmware compiles on Arduino-ESP32 core 2.0.17 (via PlatformIO) for the `s3cam`, `s3cam_qspi` and `xiao_s3` envs.
- **Not verified:**
  - The camera hasn't run on real hardware with this version, and the app hasn't run on a real Stick. The mock harness isn't mquickjs.
  - A core 3.x build. I couldn't download it in my sandbox. The code uses only calls the stock CameraWebServer example uses.
  - The speed. The numbers I'd expect depend on your WiFi link; use the `net` / `draw` readout to see them.
- **Needs a current Bruce.** It must be a build with the mquickjs interpreter (`drawJpg` and `drawBitmap` taking a `Uint8Array`, `httpFetch` with `responseType: 'binary'`). An older Bruce won't work.
