#pragma once
#include <stdint.h>

#include "pix.h"

// The box drawn around whatever is moving. Pure C++, tested on a PC by tools/test_features.cpp.
//
// The motion detector reports a box in cells of its 80x60 grid, which covers the whole sensor
// picture. The Stick's picture shows a crop of that (zoom and pan), so the box is mapped through the
// same crop and clipped to it. The camera draws the box into the picture it sends, so it moves and
// disappears through the normal "which bands changed" path and needs nothing extra on the Stick.

struct BoxRect {
    bool ok;
    int x0, y0, x1, y1; // inclusive, in output pixels
};

static inline BoxRect motionBoxToView(
    int gx0, int gy0, int gx1, int gy1, int gridW, int gridH, int sw, int sh, int cx, int cy, int cw, int ch, int dw, int dh, int pad
) {
    BoxRect b = {false, 0, 0, 0, 0};
    if (cw < 1 || ch < 1) return b;
    const int sx0 = gx0 * sw / gridW, sx1 = (gx1 + 1) * sw / gridW;
    const int sy0 = gy0 * sh / gridH, sy1 = (gy1 + 1) * sh / gridH;
    int x0 = (int)((int64_t)(sx0 - cx) * dw / cw) - pad, x1 = (int)((int64_t)(sx1 - cx) * dw / cw) - 1 + pad;
    int y0 = (int)((int64_t)(sy0 - cy) * dh / ch) - pad, y1 = (int)((int64_t)(sy1 - cy) * dh / ch) - 1 + pad;
    if (x1 < 0 || y1 < 0 || x0 > dw - 1 || y0 > dh - 1) return b; // entirely outside the view
    b.x0 = x0 < 0 ? 0 : x0;
    b.y0 = y0 < 0 ? 0 : y0;
    b.x1 = x1 > dw - 1 ? dw - 1 : x1;
    b.y1 = y1 > dh - 1 ? dh - 1 : y1;
    b.ok = b.x1 > b.x0 && b.y1 > b.y0;
    return b;
}

// Outline of `thick` pixels, inside the box, on a big-endian RGB565 picture.
static inline void drawBox565(uint8_t *rgb, int w, int h, const BoxRect &b, uint16_t color, int thick) {
    if (!b.ok) return;
    for (int t = 0; t < thick; t++) {
        const int xa = b.x0 + t, xb = b.x1 - t, ya = b.y0 + t, yb = b.y1 - t;
        if (xa >= xb || ya >= yb) break;
        for (int x = xa; x <= xb; x++) {
            pix_put(rgb + ((size_t)ya * w + x) * 2, color);
            pix_put(rgb + ((size_t)yb * w + x) * 2, color);
        }
        for (int y = ya; y <= yb; y++) {
            pix_put(rgb + ((size_t)y * w + xa) * 2, color);
            pix_put(rgb + ((size_t)y * w + xb) * 2, color);
        }
    }
    (void)h;
}
