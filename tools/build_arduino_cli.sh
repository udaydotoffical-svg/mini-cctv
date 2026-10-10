#!/usr/bin/env bash
# Compiles the camera sketch with arduino-cli, the same toolchain the Arduino IDE uses, with the
# OceanLabz board settings (ESP32S3 Dev Module, OPI PSRAM, 16 MB flash, 3 MB app partition).
#
#   tools/build_arduino_cli.sh
#
# It uses whichever esp32 core is installed (Arduino IDE 2 and arduino-cli share ~/.arduino15) and
# prints which one, because the camera driver changed between core 2.x and 3.x. It installs nothing.
# Checked: core 2.0.17 (also via PlatformIO) and core 3.3.12.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v arduino-cli >/dev/null || { echo "arduino-cli not found: https://arduino.github.io/arduino-cli/"; exit 2; }
core=$(arduino-cli core list | awk '$1 == "esp32:esp32" {print $2}')
[ -n "$core" ] || { echo "the esp32:esp32 core is not installed (arduino-cli core install esp32:esp32)"; exit 2; }
echo "esp32 core $core"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
arduino-cli compile --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,FlashMode=qio" \
  --build-path "$out" firmware/mini_cctv 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "error|warning: |Sketch uses|Global variables"
echo "build OK on core $core"
