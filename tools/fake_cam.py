#!/usr/bin/env python3
"""Stand-in for the ESP32-S3 camera node, for testing the Bruce app without hardware.

Serves the same endpoints as firmware/src/main.cpp:
  GET /jpg     one 240x128 baseline JPEG with Content-Length (animated test pattern)
  GET /status  JSON

Usage:  python3 tools/fake_cam.py [port]      (default 8080)
Then set CAM_URL in bruce/MiniCCTV.js to http://<this-machine>:8080/jpg and
JOIN_CAM_WIFI = false, with the Stick on the same WiFi network as this machine.
"""
import io
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image, ImageDraw

W, H, QUALITY = 240, 128, 60
seq = 0


def make_frame(n):
    img = Image.new("RGB", (W, H), (20, 20, 30))
    d = ImageDraw.Draw(img)
    for x in range(0, W, 16):
        d.line([(x, 0), (x, H)], fill=(40, 40, 60))
    for y in range(0, H, 16):
        d.line([(0, y), (W, y)], fill=(40, 40, 60))
    bx = (n * 6) % (W - 30)
    d.rectangle([bx, 40, bx + 30, 80], fill=(220, 60, 60))
    d.text((6, 6), "FAKE CAM #%d" % n, fill=(255, 255, 255))
    d.text((6, H - 14), time.strftime("%H:%M:%S"), fill=(120, 255, 120))
    buf = io.BytesIO()
    # baseline (non-progressive), like the firmware's fmt2jpg output
    img.save(buf, "JPEG", quality=QUALITY, progressive=False, optimize=False)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        global seq
        if self.path.startswith("/jpg"):
            seq += 1
            body = make_frame(seq)
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Frame-Seq", str(seq))
            self.end_headers()
            self.wfile.write(body)
        elif self.path.startswith("/status"):
            body = json.dumps({"fps": 0, "seq": seq, "w": W, "h": H}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_error(404)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print("fake cam on http://0.0.0.0:%d/jpg" % port)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
