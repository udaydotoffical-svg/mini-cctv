#!/usr/bin/env python3
"""Stand-in for the ESP32-S3 camera node, for testing the Bruce app without hardware.

Speaks the same band-delta protocol as firmware/mini_cctv (see delta.h):
  GET /status                 JSON
  GET /d?f=8|j&s=<since>      changed 16-row bands since update <since>
                              (f=8 raw RGB332, f=j standalone JPEG strips)
  GET /frame8?n=<update>      the whole picture at an update, raw RGB332 (for test checks)
  GET /jpg                    whole picture as one JPEG

Every /d request advances the simulated camera by one update, and the picture is a
deterministic function of the update number (a box sweeping across bands 2-4 over
a still background), so a client can be checked against /frame8.

Usage:  python3 tools/fake_cam.py [port]      (default 8080)
To point a real Stick at it, set CAM_HOST in bruce/MiniCCTV.js to http://<this-machine>:8080
and JOIN_CAM_WIFI = false, with the Stick on the same WiFi network as this machine.
"""
import io
import json
import struct
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from PIL import Image, ImageDraw

W, H, BAND_H = 240, 135, 16
NBANDS = (H + BAND_H - 1) // BAND_H
STRIP_Q = 92

lock = threading.Lock()
cur = 0  # current update number


def render(n):
    """The picture at update n (RGB image)."""
    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        for x in range(W):
            px[x, y] = (x * 255 // (W - 1), y * 255 // (H - 1), 96)
    d = ImageDraw.Draw(img)
    for x in range(0, W, 24):
        d.line([(x, 0), (x, H)], fill=(30, 30, 50))
    box_x = (n * 9) % (W - 40)
    d.rectangle([box_x, 36, box_x + 40, 74], fill=(230, 60, 60))
    d.text((6, 6), "FAKE CAM", fill=(255, 255, 255))
    return img


def band_rows(i):
    y0 = i * BAND_H
    return y0, min(BAND_H, H - y0)


def band_img(img, i):
    y0, rows = band_rows(i)
    return img.crop((0, y0, W, y0 + rows))


def rgb332(img):
    """RRRGGGBB bytes, plain truncation (the firmware dithers; this only needs to be deterministic)."""
    out = bytearray()
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b = px[x, y]
            out.append((r & 0xE0) | ((g & 0xE0) >> 3) | (b >> 6))
    return bytes(out)


def jpeg(img):
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=STRIP_Q, progressive=False, optimize=False)
    return buf.getvalue()


def delta(since, fmt):
    """Build a /d reply: header + bands that differ between update `since` and now."""
    global cur
    with lock:
        cur += 1
        now = cur
    if since > now:  # viewer is ahead of us: pretend we rebooted
        return struct.pack("<HI", 0, now)
    new = render(now)
    old = render(since) if since > 0 else None
    mask, body = 0, b""
    for i in range(NBANDS):
        nb = band_img(new, i)
        if old is not None and list(band_img(old, i).getdata()) == list(nb.getdata()):
            continue
        mask |= 1 << i
        data = jpeg(nb) if fmt == "j" else rgb332(nb)
        body += struct.pack("<H", len(data)) + data
    return struct.pack("<HI", mask, now) + body


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, body, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/d":
            fmt = q.get("f", ["8"])[0]
            since = int(q.get("s", ["0"])[0])
            self._send(delta(since, "j" if fmt == "j" else "8"), "application/octet-stream")
        elif u.path == "/status":
            body = json.dumps({"fps": 0, "seq": cur, "w": W, "h": H, "bands": NBANDS, "band_h": BAND_H}).encode()
            self._send(body, "application/json")
        elif u.path == "/frame8":
            self._send(rgb332(render(int(q.get("n", ["1"])[0]))), "application/octet-stream")
        elif u.path == "/jpg":
            self._send(jpeg(render(max(cur, 1))), "image/jpeg")
        else:
            self.send_error(404)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print("fake cam on http://0.0.0.0:%d" % port)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
