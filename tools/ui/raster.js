// A tiny software model of Bruce's `display` module, used by tools/ui_preview.js to draw what the
// Stick's screen would show as a PNG. The shapes use the same maths as TFT_eSPI (round rects, circles,
// the 5x7 text font with its 6x8 cell), so layouts, overlaps and clipping are what you would see on
// the device. It does not model the panel itself (gamma, colour response), so treat colours as close
// but not exact.
'use strict';
const zlib = require('zlib');
const FONT = require('./font5x7');

function c565to888(c) {
  const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  return [(r << 3) | (r >> 2), (g << 2) | (g >> 4), (b << 3) | (b >> 2)];
}

class Screen {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Uint16Array(w * h);
    this.size = 1;
    this.fg = 0xffff;
    this.bg = -1;
    this.outside = 0; // draws that fell (partly) outside the screen, to catch layout bugs
  }
  pixel(x, y, c) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) { this.outside++; return; }
    this.px[y * this.w + x] = c;
  }
  fillRect(x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.pixel(x + i, y + j, c);
  }
  hline(x, y, w, c) { this.fillRect(x, y, w, 1, c); }
  vline(x, y, h, c) { this.fillRect(x, y, 1, h, c); }
  line(x0, y0, x1, y1, c) {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.pixel(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  // --- ports of TFT_eSPI's helpers ---
  fillCircleHelper(x0, y0, r, corner, delta, c) {
    let f = 1 - r, ddFx = 1, ddFy = -r - r, y = 0;
    delta++;
    while (y < r) {
      if (f >= 0) {
        if (corner & 1) this.hline(x0 - y, y0 + r, y + y + delta, c);
        if (corner & 2) this.hline(x0 - y, y0 - r, y + y + delta, c);
        r--; ddFy += 2; f += ddFy;
      }
      y++; ddFx += 2; f += ddFx;
      if (corner & 1) this.hline(x0 - r, y0 + y, r + r + delta, c);
      if (corner & 2) this.hline(x0 - r, y0 - y, r + r + delta, c);
    }
  }
  fillCircle(x0, y0, r, c) {
    // the same algorithm as Bruce's TFT_eSPI::fillCircle
    let x = 0, dx = 1, dy = r + r, p = -(r >> 1);
    this.hline(x0 - r, y0, dy + 1, c);
    while (x < r) {
      if (p >= 0) {
        this.hline(x0 - x, y0 + r, dx, c);
        this.hline(x0 - x, y0 - r, dx, c);
        dy -= 2; p -= dy; r--;
      }
      dx += 2; p += dx; x++;
      this.hline(x0 - r, y0 + x, dy + 1, c);
      this.hline(x0 - r, y0 - x, dy + 1, c);
    }
  }
  circleHelper(x0, y0, rr, corner, c) {
    if (rr <= 0) return;
    let f = 1 - rr, ddFx = 1, ddFy = -2 * rr, xe = 0, xs = 0, len = 0;
    do {
      while (f < 0) { ++xe; f += (ddFx += 2); }
      f += (ddFy += 2);
      if (xe - xs === 1) {
        if (corner & 1) { this.pixel(x0 - xe, y0 - rr, c); this.pixel(x0 - rr, y0 - xe, c); }
        if (corner & 2) { this.pixel(x0 + xs + 1, y0 - rr, c); this.pixel(x0 + rr, y0 - xe, c); }
        if (corner & 8) { this.pixel(x0 - xe, y0 + rr, c); this.pixel(x0 - rr, y0 + xe, c); }
        if (corner & 4) { this.pixel(x0 + xs + 1, y0 + rr, c); this.pixel(x0 + rr, y0 + xe, c); }
      } else {
        if (corner & 1) { this.hline(x0 - xe, y0 - rr, len + 1, c); this.vline(x0 - rr, y0 - xe, len + 1, c); }
        if (corner & 2) { this.hline(x0 + xs + 1, y0 - rr, len + 1, c); this.vline(x0 + rr, y0 - xe, len + 1, c); }
        if (corner & 8) { this.hline(x0 - xe, y0 + rr, len + 1, c); this.vline(x0 - rr, y0 + xs + 1, len + 1, c); }
        if (corner & 4) { this.hline(x0 + xs + 1, y0 + rr, len + 1, c); this.vline(x0 + rr, y0 + xs + 1, len + 1, c); }
      }
      xs = xe; len = xe - xs;
    } while (xe < --rr);
  }
  drawCircle(x0, y0, r, c) {
    let f = 1 - r, ddFx = 1, ddFy = -2 * r, x = 0, y = r;
    this.pixel(x0, y0 + r, c); this.pixel(x0, y0 - r, c); this.pixel(x0 + r, y0, c); this.pixel(x0 - r, y0, c);
    while (x < y) {
      if (f >= 0) { y--; ddFy += 2; f += ddFy; }
      x++; ddFx += 2; f += ddFx;
      this.pixel(x0 + x, y0 + y, c); this.pixel(x0 - x, y0 + y, c);
      this.pixel(x0 + x, y0 - y, c); this.pixel(x0 - x, y0 - y, c);
      this.pixel(x0 + y, y0 + x, c); this.pixel(x0 - y, y0 + x, c);
      this.pixel(x0 + y, y0 - x, c); this.pixel(x0 - y, y0 - x, c);
    }
  }
  fillRoundRect(x, y, w, h, r, c) {
    this.fillRect(x, y + r, w, h - r - r, c);
    this.fillCircleHelper(x + r, y + h - r - 1, r, 1, w - r - r - 1, c);
    this.fillCircleHelper(x + r, y + r, r, 2, w - r - r - 1, c);
  }
  drawRoundRect(x, y, w, h, r, c) {
    this.hline(x + r, y, w - r - r, c);
    this.hline(x + r, y + h - 1, w - r - r, c);
    this.vline(x, y + r, h - r - r, c);
    this.vline(x + w - 1, y + r, h - r - r, c);
    this.circleHelper(x + r, y + r, r, 1, c);
    this.circleHelper(x + w - r - 1, y + r, r, 2, c);
    this.circleHelper(x + w - r - 1, y + h - r - 1, r, 4, c);
    this.circleHelper(x + r, y + h - r - 1, r, 8, c);
  }
  gradient(x, y, w, h, c1, c2, vertical) {
    const a = c565to888(c1), b = c565to888(c2);
    const n = vertical ? h : w;
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0;
      const rgb = [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * t));
      const col = ((rgb[0] & 0xf8) << 8) | ((rgb[1] & 0xfc) << 3) | (rgb[2] >> 3);
      if (vertical) this.hline(x, y + i, w, col); else this.vline(x + i, y, h, col);
    }
  }
  xbitmap(x, y, data, w, h, fg, bg) {
    const bpr = (w + 7) >> 3;
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const on = (data[j * bpr + (i >> 3)] >> (i & 7)) & 1;
        if (on) this.pixel(x + i, y + j, fg); else if (bg >= 0) this.pixel(x + i, y + j, bg);
      }
    }
  }
  bitmap332(x, y, data, w, h) {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const v = data[j * w + i];
        const r = (v >> 5) & 7, g = (v >> 2) & 7, b = v & 3;
        const r8 = (r << 5) | (r << 2) | (r >> 1), g8 = (g << 5) | (g << 2) | (g >> 1), b8 = (b << 6) | (b << 4) | (b << 2) | b;
        this.pixel(x + i, y + j, ((r8 & 0xf8) << 8) | ((g8 & 0xfc) << 3) | (b8 >> 3));
      }
    }
  }
  text(s, x, y) {
    const sz = this.size;
    for (let k = 0; k < s.length; k++) {
      const code = s.charCodeAt(k) & 255;
      const cx = x + k * 6 * sz;
      for (let col = 0; col < 6; col++) {
        const bits = col < 5 ? FONT[code * 5 + col] : 0;
        for (let row = 0; row < 8; row++) {
          const on = (bits >> row) & 1; // rows 0-7: row 7 carries the descenders of g, p, q, y
          const fillbg = this.bg >= 0 && this.bg !== this.fg;
          if (on) this.fillRect(cx + col * sz, y + row * sz, sz, sz, this.fg);
          else if (fillbg) this.fillRect(cx + col * sz, y + row * sz, sz, sz, this.bg);
        }
      }
    }
  }
  toPng(scale) {
    scale = scale || 1;
    const W = this.w * scale, H = this.h * scale;
    const raw = Buffer.alloc((W * 3 + 1) * H);
    for (let y = 0; y < H; y++) {
      raw[y * (W * 3 + 1)] = 0;
      for (let x = 0; x < W; x++) {
        const rgb = c565to888(this.px[Math.floor(y / scale) * this.w + Math.floor(x / scale)]);
        const o = y * (W * 3 + 1) + 1 + x * 3;
        raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2];
      }
    }
    const crcT = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
    const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type), data]);
      const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td));
      return Buffer.concat([len, td, cr]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  }
}

// Bruce's `display` module on top of a Screen (the calls the app uses, with Bruce's argument order).
function makeDisplay(scr, hooks) {
  hooks = hooks || {};
  const d = {
    width: () => scr.w,
    height: () => scr.h,
    color: (r, g, b) => ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3),
    fill: (c) => scr.fillRect(0, 0, scr.w, scr.h, c),
    setTextSize: (s) => { scr.size = s; },
    setTextColor: (c, bg) => { scr.fg = c; scr.bg = bg === undefined ? -1 : bg; },
    setTextAlign: () => {},
    drawString: (s, x, y) => { if (hooks.text) hooks.text(String(s), x, y, scr); scr.text(String(s), x, y); },
    drawFillRect: (x, y, w, h, c) => scr.fillRect(x, y, w, h, c),
    drawRect: (x, y, w, h, c) => { scr.hline(x, y, w, c); scr.hline(x, y + h - 1, w, c); scr.vline(x, y, h, c); scr.vline(x + w - 1, y, h, c); },
    drawFillRoundRect: (x, y, w, h, r, c) => scr.fillRoundRect(x, y, w, h, r, c),
    drawRoundRect: (x, y, w, h, r, c) => scr.drawRoundRect(x, y, w, h, r, c),
    drawFastHLine: (x, y, w, c) => scr.hline(x, y, w, c),
    drawFastVLine: (x, y, h, c) => scr.vline(x, y, h, c),
    drawLine: (a, b, c2, d2, c) => scr.line(a, b, c2, d2, c),
    drawFillCircle: (x, y, r, c) => scr.fillCircle(x, y, r, c),
    drawCircle: (x, y, r, c) => scr.drawCircle(x, y, r, c),
    drawFillRectGradient: (x, y, w, h, c1, c2, mode) => scr.gradient(x, y, w, h, c1, c2, mode === 'v'),
    drawXBitmap: (x, y, data, w, h, fg, bg) => {
      if (!data || typeof data.length !== 'number' || data.length !== ((w + 7) >> 3) * h) throw new TypeError('Bitmap size mismatch');
      scr.xbitmap(x, y, data, w, h, fg, bg === undefined ? -1 : bg);
    },
    drawBitmap: (x, y, data, w, h, bpp) => scr.bitmap332(x, y, data, w, h),
    drawJpg: () => {},
    setBrightness: () => {},
    restoreBrightness: () => {},
  };
  return d;
}

module.exports = { Screen, makeDisplay, c565to888 };
