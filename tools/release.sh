#!/usr/bin/env bash
# Publishes a new version for over-the-air updates:
#   tools/release.sh 2.2.0
#
# 1. sets the version in bruce/MiniCCTV.js (APP_VERSION) and firmware/mini_cctv/config.h (FW_VERSION)
# 2. runs the whole test suite
# 3. builds the camera firmware with arduino-cli (the Arduino IDE's toolchain, OceanLabz settings)
# 4. writes dist/firmware-oceanlabz.bin and dist/version.json (versions, sizes, MD5, source fingerprint)
# 5. checks the result with tools/check_release.js
#
# Then commit dist/, bruce/ and firmware/ together and push to main: the Stick and the camera fetch
# from there. Needs arduino-cli with the esp32 core installed (the core version is recorded).
set -euo pipefail
cd "$(dirname "$0")/.."
v="${1:-}"
[[ "$v" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || { echo "usage: tools/release.sh <major.minor.patch>   e.g. 2.2.0"; exit 2; }
command -v arduino-cli >/dev/null || { echo "arduino-cli not found: https://arduino.github.io/arduino-cli/"; exit 2; }
core=$(arduino-cli core list | awk '$1 == "esp32:esp32" {print $2}')
[ -n "$core" ] || { echo "the esp32:esp32 core is not installed"; exit 2; }

sed -i "s/^var APP_VERSION = '[0-9.]*';/var APP_VERSION = '$v';/" bruce/MiniCCTV.js
sed -i "s/^#define FW_VERSION .*/#define FW_VERSION         \"$v\"/" firmware/mini_cctv/config.h
echo "== versions set to $v"

echo "== tests"
SKIP_RELEASE_CHECK=1 tools/run_tests.sh >/dev/null 2>&1 || { echo "the tests failed: run tools/run_tests.sh to see why. Not releasing."; exit 1; }

echo "== building the camera firmware (esp32 core $core)"
out=$(mktemp -d); trap 'rm -rf "$out"' EXIT
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,FlashMode=qio" \
  --build-path "$out" firmware/mini_cctv >/dev/null
mkdir -p dist
cp "$out/mini_cctv.ino.bin" dist/firmware-oceanlabz.bin

node -e '
const fs = require("fs"), L = require("./tools/release_lib");
const bin = fs.readFileSync(L.files.bin), app = fs.readFileSync(L.files.app);
const m = {
  app: L.appVersion(), app_url: L.BASE + "bruce/MiniCCTV.js", app_size: app.length,
  fw: L.fwVersion(), fw_url: L.BASE + "dist/firmware-oceanlabz.bin", fw_size: bin.length, fw_md5: L.md5(bin),
  fw_src: L.sketchHash(), built_with: "esp32 core " + process.argv[1],
};
fs.writeFileSync(L.files.manifest, JSON.stringify(m, null, 2) + "\n");
' "$core"
node tools/check_release.js
echo "== done. Commit dist/ bruce/ firmware/ and push to main."
