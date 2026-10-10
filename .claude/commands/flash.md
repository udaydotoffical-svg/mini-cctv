---
description: Pull the latest mini-cctv from GitHub, flash the camera, and put the app on the Stick
argument-hint: [optional: serial port, e.g. /dev/ttyACM0 or COM5]
---

You are flashing my mini-cctv project on this computer: the ESP32-S3 camera (an OceanLabz ESP32-S3-WROOM N16R8 CAM) and the app for my M5StickC Plus2 running Bruce. Work step by step, show me what you see, and stop on the first real error with its exact message. Ask before installing anything. Do not edit repo files, commit, or push, and do not change pins, WiFi names or passwords on your own.

Serial port, if I gave one: $ARGUMENTS

## 1. Get the latest code

- If the current folder is not this repo, `git clone https://github.com/udaydotoffical-svg/mini-cctv.git` and `cd` into it. Use my existing GitHub login (credential helper, ssh or gh). If it asks for credentials you do not have, stop and tell me.
- If it is the repo: run `git status --short`. If I have local changes, stop and ask. Otherwise `git checkout main && git pull --ff-only origin main`.
- Show `git log --oneline -5` and the short hash you are about to flash.

## 2. Flash the camera

Settings that matter: ESP32S3 Dev Module, **OPI PSRAM** (the sketch stops at boot without it), 16 MB flash. The verified toolchain is Arduino-ESP32 **core 2.0.17**; the sketch has not been compiled on core 3.x.

1. Find the board's serial port. It has two USB-C ports: use the one that shows up as a serial device (`pio device list`, `arduino-cli board list`, `ls /dev/tty.usb* /dev/ttyACM* /dev/ttyUSB*`, or Device Manager on Windows). If there are several candidates, ask me which. Close any Arduino IDE Serial Monitor first, it holds the port.
2. Build and upload. Prefer PlatformIO, because it brings its own pinned core and will not disturb the Arduino IDE:
   `cd firmware && pio run -e oceanlabz -t upload --upload-port <port>`
   If `pio` is missing, offer to install it (`pip install platformio`). If I do not want that, use `arduino-cli` with `esp32:esp32@2.0.17`, FQBN `esp32:esp32:esp32s3`, PSRAM set to OPI and flash size 16 MB (run `arduino-cli board details -b esp32:esp32:esp32s3` to get the exact option names), compiling the folder `firmware/mini_cctv`. Use the `oceanlabz` env only; ask me before using any other.
3. If the upload cannot connect: hold the BOOT button, tap RESET (EN), release BOOT, then try again. After a good upload, press RESET.
4. Read the camera's serial output at 115200 baud for about 15 seconds (a bounded read, for example `timeout 15 pio device monitor -b 115200 --port <port>`), and report these lines back to me word for word:
   - the SD line: `SD: ok, ... MB free` is good. `SD: init failed ... CLK=39 CMD=38 D0=40` means the SD pins for this board differ: tell me the exact line and stop there, do not change pins;
   - any `WARNING` lines, the mode it started in, and the WiFi network name (`ESP32-CAM-S3`);
   - a repeating `fps=` line.
   If the monitor shows nothing, the board's other USB port may be its serial one (or USB CDC On Boot is needed): say so instead of guessing.

## 3. Put the app on the Stick

The file is `bruce/MiniCCTV.js` and it goes to `/BruceJS/MiniCCTV.js` on the Stick's SD card. It replaces any older copy: the old app does not work with this camera.

- Ask me: is the Stick's SD card mounted on this computer? If yes, ask for the mount path (do not guess it), `mkdir -p <mount>/BruceJS`, copy the file, check it with `cmp bruce/MiniCCTV.js <mount>/BruceJS/MiniCCTV.js`, run `sync`, and tell me to eject the card properly.
- If not, give me the Bruce WebUI route: on the Stick open the Bruce menu, start the Web UI, open the address it shows in a browser on this computer, and upload `bruce/MiniCCTV.js` into `/BruceJS/` there. Tell me where the file is on this computer (full path).

## 4. Finish with a short report

Say what is now on the camera and on the Stick (git short hash), paste the key serial lines, and list what is left for me to do by hand. Then give me this smoke test for the Stick: open JS Interpreter and run MiniCCTV.js (it joins the camera's WiFi by itself), open Settings and check the rows, then Watch live and check the picture and the info line at the top.
