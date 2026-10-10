#pragma once
#include <stddef.h>
#include <stdint.h>

// Pure image helpers, no ESP headers, so they can be unit-tested on a PC
// (tools/test_scaler.cpp). All RGB565 buffers are big-endian (high byte first),
// which is what the esp32-camera driver delivers and what fmt2jpg() expects.

// Box-filter (area average) downscale, centre-cropped to the dw:dh aspect
// ratio. Averaging every source pixel under each destination pixel is much
// cleaner than skipping pixels: no jaggies, and sensor noise gets averaged away.
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

// Convert big-endian RGB565 to RGB332 (RRRGGGBB) with 8x8 ordered (Bayer)
// dithering. This is the 8-bit format Bruce's display.drawBitmap(..., 8) takes;
// TFT_eSPI expands it back to RGB565 on the way to the panel.
//
// Thresholds are scaled to the real 8-bit level spacing (255/7 for red and
// green, 255/3 for blue), so brightness is preserved on average. The pattern is
// fixed in screen space, so it never shimmers between frames. y0 is the row of
// the first source row within the full frame, so a band dithers exactly like
// the same rows of a whole frame (no seams).
static inline void rgb565ToRgb332Dither(const uint8_t *src, uint8_t *dst, int w, int h, int y0) {
    static const uint8_t bayer[8][8] = {
        {0, 32, 8, 40, 2, 34, 10, 42},  {48, 16, 56, 24, 50, 18, 58, 26}, {12, 44, 4, 36, 14, 46, 6, 38},
        {60, 28, 52, 20, 62, 30, 54, 22}, {3, 35, 11, 43, 1, 33, 9, 41},   {51, 19, 59, 27, 49, 17, 57, 25},
        {15, 47, 7, 39, 13, 45, 5, 37}, {63, 31, 55, 23, 61, 29, 53, 21}};
    for (int y = 0; y < h; y++) {
        const uint8_t *row = bayer[(y0 + y) & 7];
        for (int x = 0; x < w; x++, src += 2) {
            const uint16_t v = (uint16_t)((src[0] << 8) | src[1]);
            uint32_t r = (v >> 11) & 0x1F, g = (v >> 5) & 0x3F, b = v & 0x1F;
            r = (r << 3) | (r >> 2); // expand to 8 bits
            g = (g << 2) | (g >> 4);
            b = (b << 3) | (b >> 2);
            const uint32_t t = row[x & 7];
            const uint32_t rq = (r * 448 / 255 + t) >> 6; // 0..7
            const uint32_t gq = (g * 448 / 255 + t) >> 6; // 0..7
            const uint32_t bq = (b * 192 / 255 + t) >> 6; // 0..3
            *dst++ = (uint8_t)((rq << 5) | (gq << 2) | bq);
        }
    }
}

// Has this band of the picture really changed? Compares two RGB565 buffers of
// `px` pixels. A band counts as changed when `pixCount` pixels moved by more
// than `pixThresh` (sum of |dR|+|dG|+|dB|, 0..765), or when the average
// per-channel change exceeds `meanThresh` (slow drift such as auto-exposure).
// Ignoring small differences keeps sensor noise from triggering resends and
// makes still areas of the picture rock steady.
static inline bool bandChanged(
    const uint8_t *a, const uint8_t *b, size_t px, int pixThresh, int pixCount, int meanThresh
) {
    uint32_t big = 0;
    uint64_t sum = 0;
    for (size_t i = 0; i < px; i++, a += 2, b += 2) {
        const int va = (a[0] << 8) | a[1], vb = (b[0] << 8) | b[1];
        int dr = ((va >> 11) & 0x1F) - ((vb >> 11) & 0x1F);
        int dg = ((va >> 5) & 0x3F) - ((vb >> 5) & 0x3F);
        int db = (va & 0x1F) - (vb & 0x1F);
        if (dr < 0) dr = -dr;
        if (dg < 0) dg = -dg;
        if (db < 0) db = -db;
        const int d = (dr << 3) + (dg << 2) + (db << 3);
        sum += (uint32_t)d;
        if (d > pixThresh && ++big >= (uint32_t)pixCount) return true;
    }
    return sum > (uint64_t)meanThresh * 3 * px;
}
