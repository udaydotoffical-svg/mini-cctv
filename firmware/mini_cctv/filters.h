#pragma once
#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "pix.h"

// Picture filters, applied in place to a big-endian RGB565 picture before it is compared,
// dithered or encoded, so every viewer (and every mode) gets them for free.
// Pure C++, tested on a PC by tools/test_features.cpp.
//
//   NIGHT    auto-levels + gamma lift + green tint (night-vision look): dark scenes become readable
//   GREY     greyscale
//   THERMAL  false colour: luminance mapped to black-blue-purple-red-orange-yellow-white
//   EDGE     Sobel edges, white on black

#define FILTER_NONE    0
#define FILTER_NIGHT   1
#define FILTER_GREY    2
#define FILTER_THERMAL 3
#define FILTER_EDGE    4
#define FILTER_COUNT   5

static inline const char *filterName(int f) {
    static const char *n[FILTER_COUNT] = {"Normal", "Night", "Grey", "Thermal", "Edge"};
    return (f >= 0 && f < FILTER_COUNT) ? n[f] : "?";
}

// Smoothed brightness range of the scene so the auto-levels don't pump from frame to frame.
struct FilterState {
    int lo16; // low end of the scene's luminance, x16
    int hi16; // high end, x16
};
static inline void filterStateInit(FilterState *s) {
    s->lo16 = 0;
    s->hi16 = 255 * 16;
}

static inline int filterPercentile(const uint32_t *hist, size_t n, int pct) {
    const size_t target = n * (size_t)pct / 100;
    size_t acc = 0;
    for (int i = 0; i < 256; i++) {
        acc += hist[i];
        if (acc > target) return i;
    }
    return 255;
}

struct FilterTables {
    uint8_t gamma[256];
    uint8_t pal[256][3];
    bool ready;
};

static inline FilterTables *filterTables() {
    static FilterTables t;
    if (!t.ready) {
        for (int i = 0; i < 256; i++) t.gamma[i] = (uint8_t)(255.0f * powf(i / 255.0f, 0.6f) + 0.5f);
        static const int stops[][4] = {
            {0, 0, 0, 0},    {40, 20, 0, 90},  {90, 120, 0, 140},   {140, 220, 30, 60},
            {190, 255, 140, 0}, {230, 255, 230, 60}, {255, 255, 255, 255},
        };
        const int ns = (int)(sizeof(stops) / sizeof(stops[0]));
        for (int i = 0; i < 256; i++) {
            int s = 0;
            while (s < ns - 2 && i > stops[s + 1][0]) s++;
            const int a = stops[s][0], b = stops[s + 1][0];
            for (int c = 0; c < 3; c++) {
                const int va = stops[s][1 + c], vb = stops[s + 1][1 + c];
                t.pal[i][c] = (uint8_t)(va + (vb - va) * (i - a) / (b - a));
            }
        }
        t.ready = true;
    }
    return &t;
}

// scratch: w*h bytes (luma plane). st may be shared across calls (it is the smoothing state).
static inline void filterApply(int f, uint8_t *rgb, int w, int h, uint8_t *scratch, FilterState *st) {
    if (f <= FILTER_NONE || f >= FILTER_COUNT) return;
    const size_t n = (size_t)w * h;

    if (f == FILTER_GREY) {
        for (size_t i = 0; i < n; i++) {
            const uint32_t y = pix_luma(pix_get(rgb + i * 2));
            pix_put(rgb + i * 2, pix_pack(y, y, y));
        }
        return;
    }

    for (size_t i = 0; i < n; i++) scratch[i] = pix_luma(pix_get(rgb + i * 2));

    if (f == FILTER_EDGE) {
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                uint32_t m = 0;
                if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
                    const uint8_t *p = scratch + (size_t)y * w + x;
                    const int gx = -p[-w - 1] + p[-w + 1] - 2 * p[-1] + 2 * p[1] - p[w - 1] + p[w + 1];
                    const int gy = -p[-w - 1] - 2 * p[-w] - p[-w + 1] + p[w - 1] + 2 * p[w] + p[w + 1];
                    m = (uint32_t)((gx < 0 ? -gx : gx) + (gy < 0 ? -gy : gy));
                    m = m > 127 ? 255 : m * 2;
                }
                pix_put(rgb + ((size_t)y * w + x) * 2, pix_pack(m, m, m));
            }
        }
        return;
    }

    // NIGHT / THERMAL: stretch the scene's own brightness range to full scale
    uint32_t hist[256];
    memset(hist, 0, sizeof(hist));
    for (size_t i = 0; i < n; i++) hist[scratch[i]]++;
    st->lo16 += (filterPercentile(hist, n, 2) * 16 - st->lo16) / 8;
    st->hi16 += (filterPercentile(hist, n, 98) * 16 - st->hi16) / 8;
    const int lo = st->lo16 / 16;
    int span = st->hi16 / 16 - lo;
    if (span < 40) span = 40; // don't amplify a flat, dark scene into pure noise

    const FilterTables *t = filterTables();
    for (size_t i = 0; i < n; i++) {
        int s = ((int)scratch[i] - lo) * 255 / span;
        s = s < 0 ? 0 : (s > 255 ? 255 : s);
        uint32_t r, g, b;
        if (f == FILTER_NIGHT) {
            const uint32_t v = t->gamma[s];
            r = v * 35 >> 8;
            g = v;
            b = v * 60 >> 8;
        } else {
            r = t->pal[s][0];
            g = t->pal[s][1];
            b = t->pal[s][2];
        }
        pix_put(rgb + i * 2, pix_pack(r, g, b));
    }
}
