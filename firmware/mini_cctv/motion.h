#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#include "pix.h"

// Motion detection on a coarse brightness grid. Pure C++, tested on a PC by
// tools/test_features.cpp.
//
// The camera picture is reduced to an 80x60 grid of average brightness (independent of zoom
// and filters, so a zoomed-in view still guards the whole scene). Each cell is compared with a
// slowly adapting background; cells that differ by more than a threshold count as "moving".
//
//   level   0..100, how much of the scene is moving
//   big     the moving area is person-sized rather than a cat, insect or flickering light
//   active  motion has been seen on two frames in a row and not yet been quiet for `holdMs`
//   global  most of the picture changed at once (lights switched, auto-exposure): not motion
//
// This is a size heuristic, not person recognition: it can't tell a person from a big dog.

#define MOTION_GW 80
#define MOTION_GH 60
#define MOTION_CELLS (MOTION_GW * MOTION_GH)

struct MotionParams {
    int lumaThresh;  // cell counts as moving when its brightness differs by more than this (0..255)
    int minCells;    // at least this many moving cells to count as motion at all
    int bigTenths;   // moving area (in tenths of a percent of the picture) that counts as "big"
    int globalPct;   // more than this percent of cells changing = lighting change, ignore
    uint32_t holdMs; // keep `active` this long after the last motion
};

struct MotionResult {
    int changed;
    int level;
    bool big;
    bool active;
    bool global;
    // Where the movement is, in grid cells (inclusive), when this frame counts as motion. Stray
    // single cells (sensor noise) are ignored: a column or row needs 2+ moving cells to count.
    bool hasBox;
    int bx0, by0, bx1, by1;
};

// Average brightness of each grid cell of a big-endian RGB565 picture (2x2 samples per cell).
static inline void motionGrid(const uint8_t *rgb, int sw, int sh, uint8_t *grid) {
    for (int gy = 0; gy < MOTION_GH; gy++) {
        const int ya = gy * sh / MOTION_GH, yb = (gy + 1) * sh / MOTION_GH;
        const int y1 = ya + (yb - ya) / 4, y2 = ya + (yb - ya) * 3 / 4;
        for (int gx = 0; gx < MOTION_GW; gx++) {
            const int xa = gx * sw / MOTION_GW, xb = (gx + 1) * sw / MOTION_GW;
            const int x1 = xa + (xb - xa) / 4, x2 = xa + (xb - xa) * 3 / 4;
            const uint32_t s = pix_luma(pix_get(rgb + ((size_t)y1 * sw + x1) * 2)) +
                               pix_luma(pix_get(rgb + ((size_t)y1 * sw + x2) * 2)) +
                               pix_luma(pix_get(rgb + ((size_t)y2 * sw + x1) * 2)) +
                               pix_luma(pix_get(rgb + ((size_t)y2 * sw + x2) * 2));
            grid[gy * MOTION_GW + gx] = (uint8_t)(s >> 2);
        }
    }
}

struct MotionDetector {
    int16_t bg[MOTION_CELLS]; // background brightness x16
    bool init;
    int streak;
    bool active;
    uint32_t lastMs;

    void reset() {
        init = false;
        streak = 0;
        active = false;
        lastMs = 0;
    }

    MotionResult update(const uint8_t *grid, uint32_t nowMs, const MotionParams &p) {
        MotionResult r = {0, 0, false, active, false, false, 0, 0, 0, 0};
        if (!init) {
            for (int i = 0; i < MOTION_CELLS; i++) bg[i] = (int16_t)(grid[i] * 16);
            init = true;
            return r;
        }
        const int thr16 = p.lumaThresh * 16;
        int changed = 0;
        bool moved[MOTION_CELLS];
        for (int i = 0; i < MOTION_CELLS; i++) {
            const int d = grid[i] * 16 - bg[i];
            moved[i] = (d > thr16) || (-d > thr16);
            changed += moved[i];
        }
        r.changed = changed;

        if (changed * 100 > p.globalPct * MOTION_CELLS) { // lights / exposure: relearn the background
            for (int i = 0; i < MOTION_CELLS; i++) bg[i] = (int16_t)(grid[i] * 16);
            streak = 0;
            r.global = true;
            r.active = active = (active && nowMs - lastMs <= p.holdMs);
            return r;
        }

        for (int i = 0; i < MOTION_CELLS; i++) { // follow slow drift quickly, moving things slowly
            const int target = grid[i] * 16;
            bg[i] = (int16_t)(bg[i] + (target - bg[i]) / (moved[i] ? 32 : 4));
        }

        const bool candidate = changed >= p.minCells;
        streak = candidate ? streak + 1 : 0;
        if (streak >= 2) {
            lastMs = nowMs;
            active = true;
        } else if (active && nowMs - lastMs > p.holdMs) {
            active = false;
        }
        r.active = active;
        r.big = candidate && changed * 1000 >= p.bigTenths * MOTION_CELLS;
        const int lv = changed * 100 * 6 / MOTION_CELLS; // 16% of the picture moving = 100
        r.level = candidate ? (lv > 100 ? 100 : (lv < 1 ? 1 : lv)) : 0;
        if (candidate) {
            int cols[MOTION_GW] = {0}, rows[MOTION_GH] = {0};
            for (int y = 0; y < MOTION_GH; y++)
                for (int x = 0; x < MOTION_GW; x++)
                    if (moved[y * MOTION_GW + x]) { cols[x]++; rows[y]++; }
            int x0 = -1, x1 = -1, y0 = -1, y1 = -1;
            for (int x = 0; x < MOTION_GW; x++) if (cols[x] >= 2) { if (x0 < 0) x0 = x; x1 = x; }
            for (int y = 0; y < MOTION_GH; y++) if (rows[y] >= 2) { if (y0 < 0) y0 = y; y1 = y; }
            if (x0 >= 0 && y0 >= 0) { r.hasBox = true; r.bx0 = x0; r.by0 = y0; r.bx1 = x1; r.by1 = y1; }
        }
        return r;
    }
};
