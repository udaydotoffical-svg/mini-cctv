#pragma once
#include <stddef.h>
#include <stdint.h>

// Box-filter (area average) downscale of a big-endian RGB565 frame, centre-cropped
// to the dw:dh aspect ratio. Big-endian = high byte first, which is what the
// esp32-camera driver delivers and what fmt2jpg() expects by default, so input
// and output can be fed straight through. Pure C++, no ESP headers, so it can be
// unit-tested on a PC (tools/test_scaler.cpp).
//
// Averaging every source pixel under each destination pixel is much cleaner
// than skipping pixels: no jaggies, and sensor noise gets averaged away.
static inline void scaleBox565(const uint8_t *src, int sw, int sh, uint8_t *dst, int dw, int dh) {
    int ch = (int)(((int64_t)sw * dh) / dw); // source rows that match the target aspect
    if (ch > sh) ch = sh;
    if (ch < 1) ch = 1;
    const int yoff = (sh - ch) / 2;

    for (int y = 0; y < dh; y++) {
        int ys0 = yoff + (y * ch) / dh;
        int ys1 = yoff + ((y + 1) * ch + dh - 1) / dh;
        if (ys1 <= ys0) ys1 = ys0 + 1;
        if (ys1 > sh) ys1 = sh;

        for (int x = 0; x < dw; x++) {
            int xs0 = (x * sw) / dw;
            int xs1 = ((x + 1) * sw + dw - 1) / dw;
            if (xs1 <= xs0) xs1 = xs0 + 1;
            if (xs1 > sw) xs1 = sw;

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
            uint8_t *d = dst + ((size_t)y * dw + x) * 2;
            d[0] = (uint8_t)(o >> 8);
            d[1] = (uint8_t)(o & 0xFF);
        }
    }
}
