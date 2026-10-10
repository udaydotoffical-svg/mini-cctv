# mini-cctv

Live camera feed from an **ESP32-S3 camera board** to a **JS app running inside Bruce** on an **M5StickC Plus2**.

```
 ESP32-S3 CAM                                          M5StickC Plus2 (Bruce, full build)
┌────────────────────────┐   WiFi (S3 is the AP)     ┌─────────────────────────────────┐
│ OV sensor → RGB565     │   GET http://192.168.4.1  │ bruce/MiniCCTV.js               │
│ crop+scale 240x128     │ ────────── /jpg ─────────▶│  wifi.httpFetch(url,            │
│ JPEG encode (baseline) │ ◀──── ~4-9 KB JPEG ────── │     {responseType:'binary'})    │
│ firmware/              │                           │  display.drawJpg(bytes, x, y)   │
└────────────────────────┘                           └─────────────────────────────────┘
```

## Why not USB OTG?

The Stick Plus2 is built around a plain ESP32 (ESP32-PICO-V3-02). That chip has no USB peripheral at all, so it can't be a USB host or device. Its USB-C port goes to a CH9102 USB-to-serial chip, used for charging and flashing. An S3 camera can act as a USB device, but nothing on the Stick can host it.

The Grove port (G32/G33) isn't an option either. Bruce's JS `serial` module only talks to the USB serial port, and there is no JS API for a UART on the Grove pins.

That leaves **WiFi**. Bruce's JS has exactly the two calls this needs: `wifi.httpFetch(..., {responseType:'binary'})` returns a `Uint8Array`, and `display.drawJpg(Uint8Array, x, y)` decodes it straight from memory. No SD card, no files.

## Layout

| Path | What |
|---|---|
| `firmware/mini_cctv/` | Arduino sketch for the S3 camera node (AP + `/jpg`, `/stream`, `/status`); `firmware/platformio.ini` builds it too |
| `bruce/MiniCCTV.js` | The Bruce app |
| `tools/fake_cam.py` | Fake camera server, to test the Stick without the S3 |
| `tools/test_app.js` | Host-side test of `MiniCCTV.js` against the fake camera |

## Setup

### 1. Flash the camera (Arduino IDE)

Open `firmware/mini_cctv/mini_cctv.ino` (the three files in that folder go together). No extra libraries: the camera driver ships with the ESP32 board package.

| Tools menu | Setting |
|---|---|
| Board | `XIAO_ESP32S3` (or `ESP32S3 Dev Module` for a generic S3 CAM board) |
| **PSRAM** | **`OPI PSRAM`**. Required: with PSRAM disabled the sketch stops at boot |
| USB CDC On Boot | `Enabled` (so the Serial Monitor works on native-USB boards like the XIAO) |
| Flash Size / Partition / CPU | 8MB or more / default / 240MHz |

Camera pins: at the top of `mini_cctv.ino`, choose `CAMERA_MODEL_ESP32S3_EYE` (default; Freenove WROOM CAM and most S3 CAM clones), `CAMERA_MODEL_XIAO_ESP32S3` (XIAO ESP32S3 Sense) or `CAMERA_MODEL_ESP32S3_CAM_LCD`. For another board, add a pin block to `camera_pins.h`. `CAM_VFLIP` is on by default (the S3-EYE sensor is mounted upside down); if the picture is still wrong, change `CAM_VFLIP` / `CAM_HMIRROR` in `config.h`.

PlatformIO also works: `cd firmware && pio run -e s3cam -t upload`, with envs `s3cam`, `s3cam_qspi`, `s3cam_lcd` and `xiao_s3`. It builds the same sketch folder.

On boot the camera starts a WiFi network **`ESP32-CAM-S3`** (password `12345678`, same as your CameraWebServer sketch; change both in `config.h`). Join it from a phone and open `http://192.168.4.1/` to see the feed and check the camera works before involving the Stick.

### 2. Put the app on the Stick

Copy `bruce/MiniCCTV.js` to `/BruceJS/` on the Stick's SD card, or upload it through the Bruce WebUI. Run it from **JS Interpreter → MiniCCTV.js**. It joins the `ESP32-CAM-S3` network by itself, so you don't need to connect WiFi in Bruce first.

SEL toggles the status bar. Quit with ESC. On the Stick that is the combo Bruce's own example script uses, "Sel + Next".

The config block at the top of `MiniCCTV.js` holds the SSID, password and URL. It must agree with `config.h` (SSID, password, `OUT_W`/`OUT_H`).

### Using your router instead

Set `USE_STA 1` and your SSID and password in `config.h`. Read the IP from the serial monitor. In `MiniCCTV.js` set `CAM_URL` to `http://<that ip>/jpg` and `JOIN_CAM_WIFI = false`, then connect the Stick to the same network from Bruce's WiFi menu.

## Design notes

- **Why the camera re-encodes the picture.** Bruce decodes with picojpeg, which handles only baseline JPEGs, and it can't scale. The panel is 240x135 and the sensor's smallest useful JPEG size is wider than that. So the S3 grabs RGB565 at QVGA, centre-crops to 240x128 and software-encodes a baseline JPEG. 240x128 is exactly 15x8 JPEG blocks, so there are no ragged edges. It leaves 7 px at the bottom for the status bar.
- **Why single frames, not MJPEG.** `httpFetch` buffers the whole body and returns it, so there is no streaming API on the Stick. It also needs a `Content-Length` header and can't use chunked encoding, which is why `/jpg` uses `httpd_resp_send`. Each frame is a new HTTP request, which is fine on a direct AP link. `/stream` (MJPEG on port 81) exists for browsers and VLC.
- **Memory on the Stick.** Plus2 builds enable its 2 MB PSRAM. Bruce then gives the JS engine a 256 KB heap and `httpFetch` buffers in PSRAM, so 4-9 KB frames are no problem. Without PSRAM the JS heap shrinks to about 64-100 KB, which is still enough.
- **Speed.** Expect roughly 5-10 fps. Bruce's `httpFetch` reads in 512-byte slices with a 1 ms wait, so smaller frames mean higher fps. Lower `JPEG_QUALITY` in `config.h` if you want more speed.
- **Power.** Power the camera from its own USB supply. Don't run it off the Stick's Grove 5V: the camera plus WiFi draws a few hundred mA and the Stick has a 200 mAh battery.

## Testing without hardware

```bash
python3 tools/fake_cam.py 8099 &
node tools/test_app.js 8099
```

This runs the real `MiniCCTV.js` against mocked Bruce modules. `wifi.httpFetch` is backed by `curl` against the fake camera and returns the same `{status, body: Uint8Array, length}` shape as Bruce's native one. It checks that frames are drawn, that the JPEG header is valid, that the status bar draws, and that the app reconnects when the camera disappears.

You can also point a real Stick at the fake camera: run it on a laptop, set `CAM_URL` to the laptop's IP and `JOIN_CAM_WIFI = false`. That tests the Bruce half on its own.

## Status

- **Verified:**
  - The Bruce API contract, read from `pr3y/Bruce` at `a59213f`: `httpFetch` binary, `drawJpg(Uint8Array)`, memory sizing, and `Content-Length` handling.
  - `MiniCCTV.js` against the mock harness above.
- **Not verified:**
  - The firmware has not been run on a real camera. It compiles on Arduino-ESP32 core 2.0.17 (via PlatformIO). I couldn't fetch core 3.x in my sandbox, so a 3.x build is unchecked, though it only uses APIs from the stock CameraWebServer example.
  - `MiniCCTV.js` has not been run on a real Stick. The mock harness is not mquickjs, so check the first run on the device.
- **Needs a current Bruce.** It must be a build with the mquickjs interpreter, where `drawJpg` accepts a `Uint8Array` and `httpFetch` accepts `responseType: 'binary'`. An older Bruce won't work, so update from the Bruce web flasher if the script errors on those calls.
