#!/usr/bin/env bash
# Runs every host-side test: C++ image/protocol tests (AddressSanitizer) and the Bruce app tests.
# Needs g++, python3 with Pillow, node, curl. No hardware.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'kill "${cam:-0}" 2>/dev/null || true; rm -rf "$tmp"' EXIT

echo "== scaler / dither / change detection"
g++ -std=c++17 -O1 -g -fsanitize=address,undefined -Wall -I firmware/mini_cctv tools/test_scaler.cpp -o "$tmp/test_scaler"
"$tmp/test_scaler" | grep -v "^PASS solid"

echo "== band protocol (and golden files for the app test)"
mkdir "$tmp/golden"
g++ -std=c++17 -O1 -g -fsanitize=address,undefined -Wall -I firmware/mini_cctv tools/test_delta.cpp -o "$tmp/test_delta"
"$tmp/test_delta" "$tmp/golden"

echo "== Bruce app against the fake camera and the golden files"
port=$((20000 + RANDOM % 20000))
python3 -I tools/fake_cam.py "$port" >/dev/null 2>&1 &
cam=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$port/status" && break; sleep 0.1; done
node tools/test_app.js "$port" "$tmp/golden"
echo "all test suites passed"
