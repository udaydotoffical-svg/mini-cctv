// Host test for firmware/mini_cctv/scaler.h  (run under ASan to catch out-of-bounds)
//   g++ -std=c++17 -O1 -g -fsanitize=address,undefined -I firmware/mini_cctv tools/test_scaler.cpp -o /tmp/test_scaler && /tmp/test_scaler
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

    printf(failed ? "\n%d FAILED\n" : "\nall passed\n", failed);
    return failed ? 1 : 0;
}
