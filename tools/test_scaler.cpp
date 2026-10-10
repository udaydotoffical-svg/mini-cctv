// Host test for firmware/mini_cctv/scaler.h  (run under ASan to catch out-of-bounds)
//   g++ -std=c++17 -O1 -g -fsanitize=address,undefined -I firmware/mini_cctv tools/test_scaler.cpp -o /tmp/test_scaler && /tmp/test_scaler
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

#include "scaler.h"

static int failed = 0;
#define CHECK(name, cond)                                         \
    do {                                                          \
        bool ok_ = (cond);                                        \
        printf("%s %s\n", ok_ ? "PASS" : "FAIL", name);           \
        if (!ok_) failed++;                                       \
    } while (0)

static std::vector<uint8_t> solid(int w, int h, uint16_t px) {
    std::vector<uint8_t> v((size_t)w * h * 2);
    for (size_t i = 0; i < (size_t)w * h; i++) { v[i * 2] = px >> 8; v[i * 2 + 1] = px & 0xFF; }
    return v;
}
static uint16_t at(const std::vector<uint8_t> &v, int w, int x, int y) {
    size_t i = ((size_t)y * w + x) * 2;
    return (uint16_t)((v[i] << 8) | v[i + 1]);
}

int main() {
    const int DW = 240, DH = 128;
    const int sizes[][2] = {{640, 480}, {320, 240}, {160, 120}, {240, 240}, {800, 600}, {240, 128}, {300, 100}};

    // 1. solid colours survive exactly (also proves R/G/B stay in their channels)
    const uint16_t colours[] = {0xF800 /*red*/, 0x07E0 /*green*/, 0x001F /*blue*/, 0xFFFF, 0x0000, 0x8410};
    for (auto &s : sizes) {
        for (uint16_t c : colours) {
            auto in = solid(s[0], s[1], c);
            std::vector<uint8_t> out((size_t)DW * DH * 2, 0xAA);
            scaleBox565(in.data(), s[0], s[1], out.data(), DW, DH);
            bool ok = true;
            for (int y = 0; y < DH && ok; y++)
                for (int x = 0; x < DW; x++)
                    if (at(out, DW, x, y) != c) { ok = false; break; }
            char name[64];
            snprintf(name, sizeof name, "solid 0x%04X %dx%d -> %dx%d", c, s[0], s[1], DW, DH);
            CHECK(name, ok);
        }
    }

    // 2. horizontal gradient stays monotonic and spans the range
    {
        int sw = 640, sh = 480;
        std::vector<uint8_t> in((size_t)sw * sh * 2);
        for (int y = 0; y < sh; y++)
            for (int x = 0; x < sw; x++) {
                uint16_t g = (uint16_t)((x * 63) / (sw - 1));  // green ramp
                size_t i = ((size_t)y * sw + x) * 2;
                uint16_t v = g << 5;
                in[i] = v >> 8; in[i + 1] = v & 0xFF;
            }
        std::vector<uint8_t> out((size_t)DW * DH * 2);
        scaleBox565(in.data(), sw, sh, out.data(), DW, DH);
        bool mono = true;
        for (int x = 1; x < DW; x++)
            if (((at(out, DW, x, 10) >> 5) & 0x3F) < ((at(out, DW, x - 1, 10) >> 5) & 0x3F)) mono = false;
        CHECK("gradient monotonic", mono);
        CHECK("gradient spans range", ((at(out, DW, 0, 10) >> 5) & 0x3F) <= 1 && ((at(out, DW, DW - 1, 10) >> 5) & 0x3F) >= 62);
    }

    // 3. vertical crop is centred: top and bottom source bands must not leak in
    {
        int sw = 640, sh = 480;  // crop = 640*128/240 = 341 rows, yoff = 69
        std::vector<uint8_t> in = solid(sw, sh, 0x07E0);
        for (int y = 0; y < 69; y++)
            for (int x = 0; x < sw; x++) { size_t i = ((size_t)y * sw + x) * 2; in[i] = 0xF8; in[i + 1] = 0x00; }
        for (int y = 69 + 341; y < sh; y++)
            for (int x = 0; x < sw; x++) { size_t i = ((size_t)y * sw + x) * 2; in[i] = 0xF8; in[i + 1] = 0x00; }
        std::vector<uint8_t> out((size_t)DW * DH * 2);
        scaleBox565(in.data(), sw, sh, out.data(), DW, DH);
        bool allGreen = true;
        for (int y = 0; y < DH; y++)
            for (int x = 0; x < DW; x++)
                if (at(out, DW, x, y) != 0x07E0) allGreen = false;
        CHECK("crop excludes the top/bottom bands", allGreen);
    }

    // 4. RGB565 -> RGB332 dither
    {
        auto one = [&](uint16_t px) {
            auto in = solid(8, 8, px);
            std::vector<uint8_t> out(64);
            rgb565ToRgb332Dither(in.data(), out.data(), 8, 8, 0);
            return out;
        };
        auto all = [&](const std::vector<uint8_t> &v, int expect) {
            for (uint8_t b : v) if (b != expect) return false;
            return true;
        };
        CHECK("dither black -> 0x00", all(one(0x0000), 0x00));
        CHECK("dither white -> 0xFF", all(one(0xFFFF), 0xFF));
        CHECK("dither red   -> 0xE0 (RRRGGGBB)", all(one(0xF800), 0xE0));
        CHECK("dither green -> 0x1C", all(one(0x07E0), 0x1C));
        CHECK("dither blue  -> 0x03", all(one(0x001F), 0x03));

        // Brightness is preserved on average. Every RGB565 colour on a grey ramp, 8x8 tile;
        // compared with the 8-bit value the colour actually expands to.
        bool ok = true;
        double worst = 0;
        for (int g6 = 0; g6 < 64; g6++) {
            int r5 = g6 >> 1;
            uint16_t px = (uint16_t)((r5 << 11) | (g6 << 5) | r5);
            int er = (r5 << 3) | (r5 >> 2), eg = (g6 << 2) | (g6 >> 4);
            auto out = one(px);
            double r = 0, g = 0, b = 0;
            for (uint8_t o : out) { r += (o >> 5) * 255.0 / 7; g += ((o >> 2) & 7) * 255.0 / 7; b += (o & 3) * 255.0 / 3; }
            r /= 64; g /= 64; b /= 64;
            double e = std::max({std::abs(r - er), std::abs(g - eg), std::abs(b - er)});
            if (e > worst) worst = e;
            // with 64 thresholds the tile average is within half a level step of the target
            if (std::abs(r - er) > 4.6 || std::abs(g - eg) > 4.6 || std::abs(b - er) > 22) ok = false;
        }
        char name[96];
        snprintf(name, sizeof name, "dither keeps average brightness (worst %.1f of 255)", worst);
        CHECK(name, ok);

        // A band dithers exactly like the same rows of a whole frame (no seams).
        std::vector<uint8_t> frame((size_t)240 * 135 * 2);
        for (size_t i = 0; i < (size_t)240 * 135; i++) {
            uint16_t v = (uint16_t)((i * 2654435761u) >> 16);
            frame[i * 2] = v >> 8; frame[i * 2 + 1] = v & 0xFF;
        }
        std::vector<uint8_t> whole(240 * 135), banded(240 * 135);
        rgb565ToRgb332Dither(frame.data(), whole.data(), 240, 135, 0);
        for (int i = 0; i < 9; i++) {
            int rows = (i == 8) ? 135 - 128 : 16;
            rgb565ToRgb332Dither(frame.data() + (size_t)i * 16 * 240 * 2, banded.data() + (size_t)i * 16 * 240, 240, rows, i * 16);
        }
        CHECK("dithered bands == dithered whole frame", whole == banded);
    }

    // 5. change detection
    {
        const size_t px = 240 * 16;
        auto a = solid(240, 16, 0x8410);
        auto b = a;
        CHECK("identical band: unchanged", !bandChanged(a.data(), b.data(), px, 48, 8, 3));
        // sensor-noise-sized wobble: 1 pixel in 10 flips by one colour step per channel
        for (size_t i = 0; i < px; i++) { uint16_t v = 0x8410 + ((i % 10 == 0) ? 0x0821 : 0); b[i * 2] = v >> 8; b[i * 2 + 1] = v & 0xFF; }
        CHECK("noise-level wobble: unchanged", !bandChanged(a.data(), b.data(), px, 48, 8, 3));
        // a small object: 12 pixels turn white
        b = a;
        for (size_t i = 100; i < 112; i++) { b[i * 2] = 0xFF; b[i * 2 + 1] = 0xFF; }
        CHECK("small object (12 px): changed", bandChanged(a.data(), b.data(), px, 48, 8, 3));
        // slow drift: whole band 4 levels brighter (red/blue 5-bit steps)
        auto c = solid(240, 16, 0x8410 + 0x0000);
        uint16_t brighter = (uint16_t)((((0x8410 >> 11) + 2) << 11) | (0x8410 & 0x07E0) | ((0x8410 & 0x1F) + 2));
        auto d = solid(240, 16, brighter);
        CHECK("global drift: changed", bandChanged(c.data(), d.data(), px, 48, 8, 3));
        // 5 pixels is below the count threshold
        b = a;
        for (size_t i = 100; i < 105; i++) { b[i * 2] = 0xFF; b[i * 2 + 1] = 0xFF; }
        CHECK("5 stray pixels: unchanged", !bandChanged(a.data(), b.data(), px, 48, 8, 3));
    }

    printf(failed ? "\n%d FAILED\n" : "\nall passed\n", failed);
    return failed ? 1 : 0;
}
