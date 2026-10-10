#pragma once
#include <stddef.h>
#include <stdint.h>

// Digital pan / zoom. Pure C++ (no ESP headers) so tools/test_view.cpp can test it on a PC.
//
// The sensor captures 640x480 but the Stick shows 240x135, so zooming in is not just
// enlarging pixels: at 2x the camera still has about 1.3 source pixels per screen pixel.
// Beyond ~2.6x it starts to upscale, which is fine but no longer adds detail.

struct View {
    int zoom10; // 10..40  (1.0x .. 4.0x)
    int px;     // 0..100  pan: position along the available travel (0 = edge, 50 = centred, 100 = other edge)
    int py;
};

#define VIEW_ZOOM_MIN 10
#define VIEW_ZOOM_MAX 40

static inline int viewClamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

// Which rectangle of the sw x sh source is shown, for a dw x dh picture.
static inline void viewCropRect(const View &v, int sw, int sh, int dw, int dh, int *x0, int *y0, int *cw, int *ch) {
    // 1x: the largest dw:dh window that fits the source
    int bw = sw;
    int bh = (int)(((int64_t)sw * dh) / dw);
    if (bh > sh) {
        bh = sh;
        bw = (int)(((int64_t)sh * dw) / dh);
    }
    const int z = viewClamp(v.zoom10, VIEW_ZOOM_MIN, VIEW_ZOOM_MAX);
    int w = bw * 10 / z, h = bh * 10 / z;
    if (w < 1) w = 1;
    if (h < 1) h = 1;
    *cw = w;
    *ch = h;
    *x0 = (sw - w) * viewClamp(v.px, 0, 100) / 100;
    *y0 = (sh - h) * viewClamp(v.py, 0, 100) / 100;
}

// Box-filter (area average) downscale of the rectangle (x0,y0,cw,ch) of a big-endian RGB565
// source into a dw x dh picture. Averaging every source pixel under each output pixel is much
// cleaner than skipping pixels: no jaggies, and sensor noise gets averaged away.
static inline void scaleBoxRectInto565(
    const uint8_t *src, int sw, int sh, int x0, int y0, int cw, int ch, uint8_t *dst, int dstStride, int dw, int dh
) {
    for (int y = 0; y < dh; y++) {
        int ys0 = y0 + (y * ch) / dh;
        int ys1 = y0 + ((y + 1) * ch + dh - 1) / dh;
        if (ys1 <= ys0) ys1 = ys0 + 1;
        if (ys1 > sh) ys1 = sh;
        if (ys0 >= sh) ys0 = sh - 1;

        for (int x = 0; x < dw; x++) {
            int xs0 = x0 + (x * cw) / dw;
            int xs1 = x0 + ((x + 1) * cw + dw - 1) / dw;
            if (xs1 <= xs0) xs1 = xs0 + 1;
            if (xs1 > sw) xs1 = sw;
            if (xs0 >= sw) xs0 = sw - 1;

            uint32_t r = 0, g = 0, b = 0, n = 0;
            for (int yy = ys0; yy < ys1; yy++) {
                const uint8_t *p = src + ((size_t)yy * sw + xs0) * 2;
                for (int xx = xs0; xx < xs1; xx++, p += 2) {
                    const uint16_t v = (uint16_t)((p[0] << 8) | p[1]);
                    r += v >> 11;
                    g += (v >> 5) & 0x3F;
                    b += v & 0x1F;
                    n++;
                }
            }
            r = (r + n / 2) / n;
            g = (g + n / 2) / n;
            b = (b + n / 2) / n;
            const uint16_t o = (uint16_t)((r << 11) | (g << 5) | b);
            uint8_t *d = dst + ((size_t)y * dstStride + x) * 2;
            d[0] = (uint8_t)(o >> 8);
            d[1] = (uint8_t)(o & 0xFF);
        }
    }
}

// Same, writing a dw x dh picture into a buffer that is exactly dw pixels wide.
static inline void scaleBoxRect565(
    const uint8_t *src, int sw, int sh, int x0, int y0, int cw, int ch, uint8_t *dst, int dw, int dh
) {
    scaleBoxRectInto565(src, sw, sh, x0, y0, cw, ch, dst, dw, dw, dh);
}

// Where a whole sw x sh picture lands when it is fitted inside dw x dh without stretching
// (black bars on the sides or top and bottom). Used for photos and clips, which are 4:3.
static inline void viewFitRect(int sw, int sh, int dw, int dh, int *ox, int *oy, int *fw, int *fh) {
    if ((int64_t)sw * dh >= (int64_t)sh * dw) {
        *fw = dw;
        *fh = (int)((int64_t)sh * dw / sw);
    } else {
        *fh = dh;
        *fw = (int)((int64_t)sw * dh / sh);
    }
    if (*fw < 1) *fw = 1;
    if (*fh < 1) *fh = 1;
    *ox = (dw - *fw) / 2;
    *oy = (dh - *fh) / 2;
}
