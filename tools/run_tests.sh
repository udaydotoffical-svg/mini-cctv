#!/usr/bin/env bash
# Runs every host-side test, no hardware needed:
#   - C++ tests under AddressSanitizer: image scaling, dither, change detection, zoom/pan, filters, motion
#     detection, DVR ring buffer, recording rules, operating modes, the band protocol, the AVI writer/reader
#   - AVI files checked by ffprobe / ffmpeg (if installed)
#   - the Bruce app, on Node AND on the real mquickjs engine (built by tools/get_mqjs.sh if possible)
# Needs g++, python3 with Pillow (for AVI test frames), node. Optional: ffmpeg, git+gcc+make (for mquickjs).
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
CXX="g++ -std=c++17 -O1 -g -fsanitize=address,undefined -Wall -I firmware/mini_cctv"

echo "== scaler / dither / change detection"
$CXX tools/test_scaler.cpp -o "$tmp/test_scaler"
"$tmp/test_scaler" | grep -v "^PASS solid" | grep -E "FAIL|passed" || true
"$tmp/test_scaler" >/dev/null

echo "== zoom/pan, filters, motion, DVR ring, recording rules, modes"
$CXX tools/test_features.cpp -o "$tmp/test_features"
"$tmp/test_features" | grep -E "FAIL|passed" || true
"$tmp/test_features" >/dev/null

echo "== band protocol (and golden replies for the app test)"
mkdir "$tmp/golden"
$CXX tools/test_delta.cpp -o "$tmp/test_delta"
"$tmp/test_delta" "$tmp/golden" | grep -E "FAIL|passed" || true
"$tmp/test_delta" "$tmp/golden" >/dev/null

echo "== AVI writer and reader"
mkdir "$tmp/avi"
python3 -I - "$tmp/avi" <<'PY'
import sys
from PIL import Image, ImageDraw
d = sys.argv[1]
for i in range(12):
    im = Image.new("RGB", (320, 240), (10 * i, 80, 200 - 10 * i))
    ImageDraw.Draw(im).rectangle([10 + 20 * i, 60, 70 + 20 * i, 140], fill=(250, 40, 40))
    im.save(f"{d}/frame_{i}.jpg", "JPEG", quality=80 + (i % 3) * 3)
PY
$CXX tools/test_avi.cpp -o "$tmp/test_avi"
"$tmp/test_avi" "$tmp/avi" 12 | grep -E "FAIL|passed" || true
"$tmp/test_avi" "$tmp/avi" 12 >/dev/null
if command -v ffprobe >/dev/null && command -v ffmpeg >/dev/null; then
  info=$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=codec_name,width,height,nb_read_frames -of csv=p=0 "$tmp/avi/out.avi")
  [ "$info" = "mjpeg,320,240,12" ] || { echo "FAIL ffprobe says: $info"; exit 1; }
  ffmpeg -v error -i "$tmp/avi/out.avi" -f null - || { echo "FAIL ffmpeg cannot decode the clip"; exit 1; }
  ffmpeg -v error -ss 0.5 -i "$tmp/avi/out.avi" -frames:v 1 -f null - || { echo "FAIL ffmpeg cannot seek in the clip"; exit 1; }
  echo "PASS ffprobe/ffmpeg: a valid 12-frame MJPEG clip that decodes and seeks"
else
  echo "(ffmpeg not installed: skipping the independent AVI check)"
fi

echo "== Bruce app: Node and the real mquickjs engine"
mq=""
if [ -n "${MQJS:-}" ] && [ -x "$MQJS" ]; then mq="$MQJS"; else mq=$(tools/get_mqjs.sh 2>/dev/null || true); fi
[ -n "$mq" ] || echo "(could not build mquickjs: testing on Node only. Needs git, gcc, make and network.)"
node tools/test_app.js "$tmp/golden" $mq

echo "== Do the app tests notice when the app is broken? (mutation check)"
node tools/mutate.js "$tmp/golden"

echo "== Every screen renders (and nothing is drawn off-screen)"
node tools/ui_preview.js "$tmp/screens"
echo "all test suites passed"
