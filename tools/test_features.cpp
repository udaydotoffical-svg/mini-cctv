// Host tests (AddressSanitizer) for the camera's feature logic: zoom/pan, filters, motion
// detection, the DVR history ring and the recording rules.
//   g++ -std=c++17 -O1 -g -fsanitize=address,undefined -I firmware/mini_cctv tools/test_features.cpp -o /tmp/tf && /tmp/tf
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

#include "box.h"
#include "filters.h"
#include "history.h"
#include "jpegtools.h"
#include "modes.h"
#include "motion.h"
#include "rec_policy.h"
#include "scaler.h"
#include "view.h"

static int failed = 0;
#define CHECK(name, cond)                                \
    do {                                                 \
        bool ok_ = (cond);                               \
        printf("%s %s\n", ok_ ? "PASS" : "FAIL", name);  \
        if (!ok_) failed++;                              \
    } while (0)

static std::vector<uint8_t> solid(int w, int h, uint16_t px) {
    std::vector<uint8_t> v((size_t)w * h * 2);
    for (size_t i = 0; i < (size_t)w * h; i++) pix_put(&v[i * 2], px);
    return v;
}
static uint16_t at(const std::vector<uint8_t> &v, int w, int x, int y) { return pix_get(&v[((size_t)y * w + x) * 2]); }

// ------------------------------------------------------------------------------------------ view
static void testView() {
    int x0, y0, cw, ch;
    View v = {10, 50, 50};
    viewCropRect(v, 640, 480, 240, 135, &x0, &y0, &cw, &ch);
    CHECK("1x centred: full width, 16:9 window in the middle", x0 == 0 && y0 == 60 && cw == 640 && ch == 360);
    v = {20, 50, 50};
    viewCropRect(v, 640, 480, 240, 135, &x0, &y0, &cw, &ch);
    CHECK("2x centred: half the width and height, in the middle", cw == 320 && ch == 180 && x0 == 160 && y0 == 150);
    v = {20, 0, 0};
    viewCropRect(v, 640, 480, 240, 135, &x0, &y0, &cw, &ch);
    CHECK("pan 0,0 = top-left corner", x0 == 0 && y0 == 0);
    v = {20, 100, 100};
    viewCropRect(v, 640, 480, 240, 135, &x0, &y0, &cw, &ch);
    CHECK("pan 100,100 = bottom-right corner, window stays inside", x0 + cw == 640 && y0 + ch == 480);
    v = {999, -5, 500};
    viewCropRect(v, 640, 480, 240, 135, &x0, &y0, &cw, &ch);
    CHECK("out-of-range zoom/pan are clamped", cw == 160 && x0 == 0 && y0 + ch == 480);

    // left half red, right half blue
    std::vector<uint8_t> src((size_t)640 * 480 * 2);
    for (int y = 0; y < 480; y++)
        for (int x = 0; x < 640; x++) pix_put(&src[((size_t)y * 640 + x) * 2], x < 320 ? 0xF800 : 0x001F);
    std::vector<uint8_t> out((size_t)240 * 135 * 2);
    auto render = [&](View vw) {
        viewCropRect(vw, 640, 480, 240, 135, &x0, &y0, &cw, &ch);
        scaleBoxRect565(src.data(), 640, 480, x0, y0, cw, ch, out.data(), 240, 135);
    };
    render({20, 0, 50});
    CHECK("zoomed into the left: all red", at(out, 240, 0, 0) == 0xF800 && at(out, 240, 239, 134) == 0xF800);
    render({20, 100, 50});
    CHECK("zoomed into the right: all blue", at(out, 240, 0, 0) == 0x001F && at(out, 240, 239, 134) == 0x001F);
    render({20, 50, 50});
    CHECK("zoomed to the middle: red on the left, blue on the right", at(out, 240, 5, 60) == 0xF800 && at(out, 240, 235, 60) == 0x001F);

    // never reads outside the source, for odd sizes and every zoom/pan
    bool ok = true;
    const int sizes[][2] = {{640, 480}, {320, 240}, {160, 120}, {1, 1}, {7, 5}};
    for (auto &s : sizes) {
        auto in = solid(s[0], s[1], 0x1234);
        for (int z = 10; z <= 40; z += 5)
            for (int p = 0; p <= 100; p += 25) {
                std::vector<uint8_t> o((size_t)240 * 135 * 2);
                View vw = {z, p, 100 - p};
                viewCropRect(vw, s[0], s[1], 240, 135, &x0, &y0, &cw, &ch);
                if (x0 < 0 || y0 < 0 || x0 + cw > s[0] || y0 + ch > s[1]) ok = false;
                scaleBoxRect565(in.data(), s[0], s[1], x0, y0, cw, ch, o.data(), 240, 135);
                if (at(o, 240, 100, 60) != 0x1234) ok = false;
            }
    }
    CHECK("every zoom/pan on odd source sizes stays in bounds and keeps colour", ok);
}

static void testFit() {
    int ox, oy, fw, fh;
    viewFitRect(320, 240, 240, 135, &ox, &oy, &fw, &fh);
    CHECK("fit 4:3 into 16:9: pillarboxed, full height, centred", fh == 135 && fw == 180 && oy == 0 && ox == 30);
    viewFitRect(240, 135, 240, 135, &ox, &oy, &fw, &fh);
    CHECK("fit 16:9 into 16:9: fills the picture", fw == 240 && fh == 135 && ox == 0 && oy == 0);
    viewFitRect(100, 400, 240, 135, &ox, &oy, &fw, &fh);
    CHECK("fit a tall picture: fits the height", fh == 135 && fw == 33);

    // fitted picture lands only inside its rectangle; the black margins stay black
    auto src = solid(320, 240, 0xFFFF);
    std::vector<uint8_t> canvas((size_t)240 * 135 * 2, 0);
    viewFitRect(320, 240, 240, 135, &ox, &oy, &fw, &fh);
    scaleBoxRectInto565(src.data(), 320, 240, 0, 0, 320, 240, canvas.data() + ((size_t)oy * 240 + ox) * 2, 240, fw, fh);
    CHECK("fitted picture: white inside, black margins untouched",
          at(canvas, 240, 120, 67) == 0xFFFF && at(canvas, 240, ox + 2, 5) == 0xFFFF && at(canvas, 240, 5, 67) == 0 && at(canvas, 240, 235, 67) == 0);
}

// -------------------------------------------------------------------------------------- filters
static void testFilters() {
    const int W = 240, H = 135;
    std::vector<uint8_t> scratch((size_t)W * H);
    FilterState st;

    // greyscale: channels equal
    {
        auto f = solid(W, H, pix_pack(200, 100, 50));
        filterStateInit(&st);
        filterApply(FILTER_GREY, f.data(), W, H, scratch.data(), &st);
        uint16_t p = at(f, W, 10, 10);
        int r = (p >> 11) & 31, g = (p >> 5) & 63, b = p & 31;
        CHECK("grey: red, green and blue levels agree", std::abs((r << 3) - (g << 2)) <= 8 && std::abs((b << 3) - (g << 2)) <= 8);
    }
    // night: dark gradient becomes brighter, and green dominates
    {
        std::vector<uint8_t> f((size_t)W * H * 2);
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++) { int v = 8 + x / 8; pix_put(&f[((size_t)y * W + x) * 2], pix_pack(v, v, v)); }
        double before = 0, after = 0;
        for (size_t i = 0; i < (size_t)W * H; i++) before += pix_luma(pix_get(&f[i * 2]));
        filterStateInit(&st);
        for (int k = 0; k < 40; k++) { // settle the smoothing
            for (int y = 0; y < H; y++)
                for (int x = 0; x < W; x++) { int v = 8 + x / 8; pix_put(&f[((size_t)y * W + x) * 2], pix_pack(v, v, v)); }
            filterApply(FILTER_NIGHT, f.data(), W, H, scratch.data(), &st);
        }
        for (size_t i = 0; i < (size_t)W * H; i++) after += pix_luma(pix_get(&f[i * 2]));
        uint16_t p = at(f, W, W - 5, 10);
        int r = ((p >> 11) & 31) << 3, g = ((p >> 5) & 63) << 2, b = (p & 31) << 3;
        CHECK("night: a dark scene gets much brighter", after > before * 2.5);
        CHECK("night: green phosphor tint (green > blue > red)", g > b && b > r);
    }
    // thermal: dark end is dark, bright end is near white, middle is warm
    {
        std::vector<uint8_t> f((size_t)W * H * 2);
        auto ramp = [&]() {
            for (int y = 0; y < H; y++)
                for (int x = 0; x < W; x++) { int v = x * 255 / (W - 1); pix_put(&f[((size_t)y * W + x) * 2], pix_pack(v, v, v)); }
        };
        filterStateInit(&st);
        for (int k = 0; k < 60; k++) { ramp(); filterApply(FILTER_THERMAL, f.data(), W, H, scratch.data(), &st); }
        auto rgb = [&](int x) { uint16_t p = at(f, W, x, 5); return std::array<int, 3>{{((p >> 11) & 31) << 3, ((p >> 5) & 63) << 2, (p & 31) << 3}}; };
        auto dark = rgb(2), mid = rgb(W * 55 / 100), bright = rgb(W - 3);
        CHECK("thermal: coldest end is almost black", dark[0] + dark[1] + dark[2] < 150);
        CHECK("thermal: warm middle is red/orange (red high, blue low)", mid[0] > 180 && mid[2] < 120);
        CHECK("thermal: hottest end is near white", bright[0] > 220 && bright[1] > 200 && bright[2] > 150);
    }
    // edge: flat picture stays black, a vertical step lights up only at the step
    {
        std::vector<uint8_t> f((size_t)W * H * 2);
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++) pix_put(&f[((size_t)y * W + x) * 2], x < 120 ? pix_pack(30, 30, 30) : pix_pack(220, 220, 220));
        filterApply(FILTER_EDGE, f.data(), W, H, scratch.data(), &st);
        CHECK("edge: bright line exactly at the step", pix_luma(at(f, W, 119, 60)) > 200 && pix_luma(at(f, W, 120, 60)) > 200);
        CHECK("edge: flat areas are black", pix_luma(at(f, W, 40, 60)) == 0 && pix_luma(at(f, W, 200, 60)) == 0);
        CHECK("edge: border rows/columns are black (no out-of-bounds reads)", pix_luma(at(f, W, 119, 0)) == 0 && pix_luma(at(f, W, 0, 60)) == 0);
    }
    // all filters on tiny and odd sizes under ASan, and an all-black picture does not blow up
    {
        bool ok = true;
        for (int fl = 0; fl < FILTER_COUNT; fl++)
            for (int wh : {1, 2, 3, 17}) {
                auto f = solid(wh, wh, 0);
                std::vector<uint8_t> sc((size_t)wh * wh);
                filterStateInit(&st);
                filterApply(fl, f.data(), wh, wh, sc.data(), &st);
            }
        CHECK("every filter survives tiny and all-black pictures", ok);
    }
}

// ---------------------------------------------------------------------------------------- motion
static void testMotion() {
    MotionParams p = {18, 6, 30, 50, 3000};
    auto gridOf = [](int v) { return std::vector<uint8_t>(MOTION_CELLS, (uint8_t)v); };
    auto addBlob = [](std::vector<uint8_t> &g, int cells, int delta) {
        for (int i = 0; i < cells; i++) g[1000 + i] = (uint8_t)std::min(255, g[1000 + i] + delta);
    };

    // still scene with sensor noise: never motion
    {
        MotionDetector d; d.reset();
        bool any = false; uint32_t t = 0;
        for (int k = 0; k < 100; k++) {
            auto g = gridOf(100);
            for (int i = 0; i < MOTION_CELLS; i += 7) g[i] = (uint8_t)(100 + ((k + i) % 5) - 2);
            auto r = d.update(g.data(), t += 66, p);
            any = any || r.active || r.level > 0;
        }
        CHECK("still scene with noise: no motion, ever", !any);
    }
    // small object: motion, but not "big"
    {
        MotionDetector d; d.reset();
        uint32_t t = 0;
        for (int k = 0; k < 5; k++) d.update(gridOf(100).data(), t += 66, p);
        MotionResult r{};
        for (int k = 0; k < 4; k++) { auto g = gridOf(100); addBlob(g, 12, 60); r = d.update(g.data(), t += 66, p); }
        CHECK("small mover (12 cells): motion, level>0, not big", r.active && r.level > 0 && !r.big);
    }
    // person-sized: big
    {
        MotionDetector d; d.reset();
        uint32_t t = 0;
        for (int k = 0; k < 5; k++) d.update(gridOf(100).data(), t += 66, p);
        MotionResult r{};
        for (int k = 0; k < 4; k++) { auto g = gridOf(100); addBlob(g, 400, 70); r = d.update(g.data(), t += 66, p); }
        CHECK("person-sized mover (400 cells = 8%): big", r.active && r.big && r.level > 20);
    }
    // a single-frame blip is not motion
    {
        MotionDetector d; d.reset();
        uint32_t t = 0;
        for (int k = 0; k < 5; k++) d.update(gridOf(100).data(), t += 66, p);
        auto g = gridOf(100); addBlob(g, 30, 80);
        auto r1 = d.update(g.data(), t += 66, p);
        auto r2 = d.update(gridOf(100).data(), t += 66, p);
        CHECK("one-frame blip: not active", !r1.active && !r2.active);
    }
    // lights switched on: global change, ignored, background relearned
    {
        MotionDetector d; d.reset();
        uint32_t t = 0;
        for (int k = 0; k < 5; k++) d.update(gridOf(60).data(), t += 66, p);
        auto r = d.update(gridOf(140).data(), t += 66, p);
        CHECK("lights on (whole picture changes): flagged global, not motion", r.global && !r.active);
        MotionResult r2{};
        for (int k = 0; k < 5; k++) r2 = d.update(gridOf(140).data(), t += 66, p);
        CHECK("after the lights change it settles: no motion", !r2.active && r2.level == 0);
    }
    // hold: active lingers, then clears
    {
        MotionDetector d; d.reset();
        uint32_t t = 0;
        for (int k = 0; k < 5; k++) d.update(gridOf(100).data(), t += 66, p);
        for (int k = 0; k < 4; k++) { auto g = gridOf(100); addBlob(g, 40, 70); d.update(g.data(), t += 66, p); }
        auto soon = d.update(gridOf(100).data(), t += 500, p);
        CHECK("motion stops: still active within the hold time", soon.active);
        MotionResult later{};
        for (int k = 0; k < 6; k++) later = d.update(gridOf(100).data(), t += 600, p);
        CHECK("motion stops: cleared after the hold time", !later.active);
    }
    // grid sampling: a bright square in a dark VGA frame lights up the right cells
    {
        std::vector<uint8_t> f((size_t)640 * 480 * 2);
        for (size_t i = 0; i < (size_t)640 * 480; i++) pix_put(&f[i * 2], pix_pack(20, 20, 20));
        for (int y = 200; y < 240; y++)
            for (int x = 320; x < 360; x++) pix_put(&f[((size_t)y * 640 + x) * 2], pix_pack(240, 240, 240));
        std::vector<uint8_t> g(MOTION_CELLS);
        motionGrid(f.data(), 640, 480, g.data());
        // 640/80 = 8 px per cell horizontally, 480/60 = 8 vertically: cell (40..44, 25..29)
        CHECK("motionGrid: bright square lands on the right cells", g[27 * MOTION_GW + 42] > 200 && g[5 * MOTION_GW + 5] < 40);
    }
}

// --------------------------------------------------------------------------------------- history
static void testHistory() {
    std::vector<uint8_t> buf(10000);
    std::vector<HistEntry> ents(200);
    History h;
    h.init(buf.data(), buf.size(), ents.data(), (int)ents.size());

    auto frame = [](uint32_t t, size_t len) { std::vector<uint8_t> f(len); for (size_t i = 0; i < len; i++) f[i] = (uint8_t)(t * 7 + i); return f; };
    srand(1);
    bool intact = true, ordered = true;
    uint32_t t = 1000;
    for (int i = 0; i < 3000; i++) {
        size_t len = 200 + rand() % 1800;
        t += 100 + rand() % 300;
        auto f = frame(t, len);
        if (!h.push(f.data(), len, t)) intact = false;
        if (i % 50 == 49) {
            uint32_t last = 0;
            for (int k = 0; k < h.count; k++) {
                const HistEntry *e = h.at(k);
                if (e->t < last) ordered = false;
                last = e->t;
                auto exp = frame(e->t, e->len);
                if (memcmp(h.data(e), exp.data(), e->len) != 0) intact = false;
                if ((size_t)e->off + e->len > buf.size()) intact = false;
            }
        }
    }
    CHECK("history: 3000 pushes into a 10 KB ring, every surviving frame intact", intact);
    CHECK("history: frames stay in time order", ordered);
    CHECK("history: holds a useful number of frames (>=5)", h.count >= 5);
    CHECK("history: oldest < newest, newest = last push", h.oldestT() < h.newestT() && h.newestT() == t);
    int i = h.indexAtOrBefore(h.newestT() - 1);
    CHECK("history: lookup at-or-before returns an older frame", i >= 0 && h.at(i)->t <= h.newestT() - 1);
    CHECK("history: lookup before everything returns the oldest", h.indexAtOrBefore(0) == 0);
    std::vector<uint8_t> huge(20000);
    CHECK("history: a frame bigger than the ring is refused", !h.push(huge.data(), huge.size(), t + 1));

    // entry-table limit
    std::vector<uint8_t> big(100000);
    std::vector<HistEntry> e3(4);
    History h2;
    h2.init(big.data(), big.size(), e3.data(), 4);
    for (int k = 0; k < 10; k++) { std::vector<uint8_t> f(100, (uint8_t)k); h2.push(f.data(), f.size(), 1000 + k); }
    CHECK("history: entry table is a ring too (keeps the newest 4)", h2.count == 4 && h2.at(0)->t == 1006 && h2.at(3)->t == 1009);
}

// ------------------------------------------------------------------------------------ rec policy
static void testRecPolicy() {
    RecConfig c = {true, 8000, 120000, 2000};
    {
        RecPolicy r; r.init();
        auto a = r.update(1000, true, true, c);
        CHECK("auto: motion starts a clip", a == REC_START && r.recording);
        for (uint32_t t = 2000; t < 6000; t += 500) r.update(t, true, true, c);
        CHECK("auto: keeps recording while there's motion", r.recording);
        CHECK("auto: quiet but inside the tail: still recording", r.update(10000, false, true, c) == REC_NONE && r.recording);
        CHECK("auto: stops once quiet for the tail", r.update(14500, false, true, c) == REC_STOP && !r.recording);
        CHECK("auto: cooldown stops an instant restart", r.update(15000, true, true, c) == REC_NONE);
        CHECK("auto: restarts after the cooldown", r.update(17000, true, true, c) == REC_START);
    }
    {
        RecPolicy r; r.init();
        CHECK("no SD card: motion does not start anything", r.update(1000, true, false, c) == REC_NONE && !r.recording);
        r.requestStart();
        CHECK("no SD card: a manual start is refused", r.update(2000, false, false, c) == REC_NONE && !r.recording);
    }
    {
        RecPolicy r; r.init();
        r.requestStart();
        CHECK("manual start works without motion", r.update(1000, false, true, c) == REC_START);
        CHECK("manual clip ignores the quiet tail", r.update(60000, false, true, c) == REC_NONE && r.recording);
        r.requestStop();
        CHECK("manual stop", r.update(61000, false, true, c) == REC_STOP && !r.recording);
    }
    {
        RecPolicy r; r.init();
        r.update(0, true, true, c);
        for (uint32_t t = 1000; t < 120000; t += 1000) r.update(t, true, true, c);
        CHECK("a clip is capped at the maximum length", r.update(120000, true, true, c) == REC_STOP);
        CHECK("...and a new one follows after the cooldown while motion continues", r.update(122500, true, true, c) == REC_START);
    }
    {
        RecPolicy r; r.init();
        r.update(0, true, true, c);
        CHECK("SD card pulled mid-clip: recording stops", r.update(1000, true, false, c) == REC_STOP);
    }
    {
        RecPolicy r; r.init();
        RecConfig off = c; off.autoOnMotion = false;
        CHECK("auto-record disabled: motion alone starts nothing", r.update(1000, true, true, off) == REC_NONE);
    }
}

static void testJpegTools() {
    // all four ways a decoder might hand back a pure-red pixel
    CHECK("decoder layout: big-endian RGB", decoderLayoutFromRed(0xF8, 0x00) == 0);
    CHECK("decoder layout: little-endian RGB", decoderLayoutFromRed(0x00, 0xF8) == 1);
    CHECK("decoder layout: big-endian BGR", decoderLayoutFromRed(0x00, 0x1F) == 2);
    CHECK("decoder layout: little-endian BGR", decoderLayoutFromRed(0x1F, 0x00) == 3);
    CHECK("decoder layout: JPEG-rounded red (r=30, g=1, b=1) still recognised", decoderLayoutFromRed(0xF0, 0x21) == 0);
    CHECK("decoder layout: not red at all is rejected", decoderLayoutFromRed(0x07, 0xE0) == -1 && decoderLayoutFromRed(0x00, 0x00) == -1);

    // normalising each layout must give the same big-endian RGB565 picture
    const uint16_t want[3] = {0xF800, 0x07E0, 0x1234};
    bool ok = true;
    for (int layout = 0; layout < 4; layout++) {
        uint8_t buf[6];
        for (int i = 0; i < 3; i++) {
            uint16_t v = want[i];
            if (layout & 2) v = (uint16_t)(((v & 0x1F) << 11) | (v & 0x07E0) | ((v >> 11) & 0x1F));
            if (layout & 1) { buf[i * 2] = v & 0xFF; buf[i * 2 + 1] = v >> 8; }
            else { buf[i * 2] = v >> 8; buf[i * 2 + 1] = v & 0xFF; }
        }
        decoderNormalize(buf, 3, layout);
        for (int i = 0; i < 3; i++) if (pix_get(buf + i * 2) != want[i]) ok = false;
    }
    CHECK("normalising all four decoder layouts gives the same big-endian picture", ok);

    // JPEG size parser: handcrafted header with an APP0 segment before the SOF
    const uint8_t hdr[] = {0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 'J', 'F', 'I', 'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
                           0xFF, 0xC0, 0x00, 0x11, 8, 0x00, 0x87, 0x00, 0xF0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1};
    int w = 0, h = 0;
    CHECK("jpegSize reads width and height past an APP0 segment", jpegSize(hdr, sizeof hdr, &w, &h) && w == 240 && h == 135);
    const uint8_t notjpg[] = {0x89, 'P', 'N', 'G', 0, 0, 0, 0};
    CHECK("jpegSize rejects non-JPEG and truncated data", !jpegSize(notjpg, sizeof notjpg, &w, &h) && !jpegSize(hdr, 12, &w, &h));
}

static void testModes() {
    ModeCaps live = modeCaps(MODE_LIVE), guard = modeCaps(MODE_GUARD), sec = modeCaps(MODE_SECURITY);
    ModeCaps cont = modeCaps(MODE_CONTINUOUS), tl = modeCaps(MODE_TIMELAPSE);
    CHECK("Live: nothing runs in the background (lightest)", !live.motion && !live.history && !live.autoRec && !live.continuous && !live.timelapse && !live.eventPhoto && !live.alerts && !live.needsSd);
    CHECK("Guard: motion, rewind and alerts, but stores nothing", guard.motion && guard.history && guard.alerts && !guard.autoRec && !guard.continuous && !guard.timelapse && !guard.needsSd);
    CHECK("Security: the full service", sec.motion && sec.history && sec.autoRec && sec.eventPhoto && sec.alerts && sec.needsSd && !sec.continuous);
    CHECK("Continuous: records all the time, with alerts and rewind", cont.continuous && cont.motion && cont.history && cont.alerts && !cont.autoRec);
    CHECK("Timelapse: only the timer", tl.timelapse && !tl.motion && !tl.history && !tl.alerts && tl.needsSd);
    bool names = true;
    for (int m = 0; m < MODE_COUNT; m++) names = names && modeName(m)[0] && modeBlurb(m)[0] && strlen(modeBlurb(m)) <= 40;
    CHECK("every mode has a name and a menu blurb that fits the Stick's screen", names);
    CHECK("an unknown mode is treated as Live", !modeCaps(99).motion && !modeCaps(-1).autoRec);

    // Continuous recording: clips follow each other with no gap
    RecPolicy r; r.init();
    RecConfig c = {true, 1000000000u, 300000, 0};
    CHECK("continuous: starts straight away", r.update(0, true, true, c) == REC_START);
    bool steady = true;
    for (uint32_t t = 1000; t < 300000; t += 1000) if (r.update(t, true, true, c) != REC_NONE) steady = false;
    CHECK("continuous: keeps going without stopping", steady && r.recording);
    CHECK("continuous: a clip is cut at the maximum length", r.update(300000, true, true, c) == REC_STOP);
    CHECK("continuous: the next clip starts at once (no cooldown gap)", r.update(300040, true, true, c) == REC_START);
    CHECK("continuous: an SD card pulled out stops it, and it won't restart without one", r.update(310000, true, false, c) == REC_STOP && r.update(311000, true, false, c) == REC_NONE);
    CHECK("continuous: ...but resumes when a card comes back", r.update(312000, true, true, c) == REC_START);
}

// ------------------------------------------------------------------------------------------ box
static void testBox() {
    const MotionParams p = {18, 6, 30, 50, 3000};
    auto flat = [](uint8_t v) { std::vector<uint8_t> g(MOTION_CELLS, v); return g; };

    // the detector reports where the movement is
    MotionDetector d; d.reset();
    d.update(flat(100).data(), 0, p);
    auto g = flat(100);
    for (int y = 20; y <= 34; y++) for (int x = 30; x <= 39; x++) g[y * MOTION_GW + x] = 200;
    g[5 * MOTION_GW + 70] = 220; // a lone noisy cell far away
    MotionResult r = d.update(g.data(), 100, p);
    CHECK("box: the bounding box covers the moving block", r.hasBox && r.bx0 == 30 && r.bx1 == 39 && r.by0 == 20 && r.by1 == 34);
    CHECK("box: one stray noisy cell does not stretch it", r.bx1 < 70 && r.by0 > 5);
    MotionDetector q; q.reset();
    q.update(flat(100).data(), 0, p);
    MotionResult none = q.update(flat(100).data(), 100, p);
    CHECK("box: nothing moving, no box", !none.hasBox);
    auto few = flat(100);
    few[10 * MOTION_GW + 10] = 220; few[40 * MOTION_GW + 60] = 220;
    CHECK("box: too few moving cells to count as motion, no box", !q.update(few.data(), 200, p).hasBox);

    // mapping through the view: 1x centred (the whole width, the middle 16:9 slice)
    int cx, cy, cw, ch;
    View v1 = {10, 50, 50};
    viewCropRect(v1, 640, 480, 240, 135, &cx, &cy, &cw, &ch);
    BoxRect b = motionBoxToView(30, 20, 39, 34, MOTION_GW, MOTION_GH, 640, 480, cx, cy, cw, ch, 240, 135, 0);
    CHECK("box: maps into the 1x picture", b.ok && b.x0 == 90 && b.x1 == 119 && b.y0 == 37 && b.y1 == 81);
    BoxRect bp = motionBoxToView(30, 20, 39, 34, MOTION_GW, MOTION_GH, 640, 480, cx, cy, cw, ch, 240, 135, 2);
    CHECK("box: padding grows it on every side", bp.x0 == 88 && bp.x1 == 121 && bp.y0 == 35 && bp.y1 == 83);
    BoxRect above = motionBoxToView(30, 0, 39, 5, MOTION_GW, MOTION_GH, 640, 480, cx, cy, cw, ch, 240, 135, 0);
    CHECK("box: movement above the 16:9 slice is not shown", !above.ok);

    // zoomed in 2x: the same movement is twice as big, and movement outside the view is dropped
    View v2 = {20, 50, 50};
    viewCropRect(v2, 640, 480, 240, 135, &cx, &cy, &cw, &ch);
    BoxRect z = motionBoxToView(30, 20, 39, 34, MOTION_GW, MOTION_GH, 640, 480, cx, cy, cw, ch, 240, 135, 0);
    BoxRect zc = motionBoxToView(30, 20, 39, 34, MOTION_GW, MOTION_GH, 640, 480, 160, 120, 320, 180, 240, 135, 0);
    CHECK("box: zoomed in, mapping uses the crop", z.ok && z.x1 - z.x0 > 2 * (119 - 90) - 3 && z.x1 - z.x0 < 2 * (119 - 90) + 3);
    CHECK("box: crop maths agrees with a hand-worked case", zc.ok && zc.x0 == 60 && zc.y0 == (160 - 120) * 135 / 180);
    BoxRect out = motionBoxToView(0, 0, 5, 5, MOTION_GW, MOTION_GH, 640, 480, cx, cy, cw, ch, 240, 135, 0);
    CHECK("box: movement outside the zoomed view is dropped", !out.ok);
    BoxRect edge = motionBoxToView(20, 20, 45, 30, MOTION_GW, MOTION_GH, 640, 480, cx, cy, cw, ch, 240, 135, 0);
    CHECK("box: movement half in view is clipped to the picture", edge.ok && edge.x0 >= 0 && edge.x1 <= 239 && edge.y0 >= 0 && edge.y1 <= 134);

    // drawing: an outline of the right colour and width, nothing inside, nothing outside
    auto img = solid(40, 30, 0x1234);
    BoxRect rect = {true, 5, 4, 20, 15};
    drawBox565(img.data(), 40, 30, rect, 0xF800, 2);
    int outline = 0, inside = 0, outside = 0;
    for (int y = 0; y < 30; y++) for (int x = 0; x < 40; x++) {
        const bool red = at(img, 40, x, y) == 0xF800;
        const bool inBox = x >= 5 && x <= 20 && y >= 4 && y <= 15;
        const bool band = inBox && (x < 7 || x > 18 || y < 6 || y > 13);
        if (red && band) outline++;
        else if (red && inBox) inside++;
        else if (red) outside++;
        else if (band) outline = -100000; // an outline pixel that is missing
    }
    CHECK("box: a 2 px outline, nothing painted inside or outside", outline == (16 * 12 - 12 * 8) && inside == 0 && outside == 0);
    auto edgeImg = solid(40, 30, 0);
    BoxRect full = {true, 0, 0, 39, 29};
    drawBox565(edgeImg.data(), 40, 30, full, 0xFFFF, 3);
    CHECK("box: a box on the picture edge stays inside the buffer", at(edgeImg, 40, 0, 0) == 0xFFFF && at(edgeImg, 40, 39, 29) == 0xFFFF && at(edgeImg, 40, 20, 15) == 0);
    BoxRect bad = {false, 0, 0, 0, 0};
    auto untouched = solid(10, 10, 0x1111);
    drawBox565(untouched.data(), 10, 10, bad, 0xF800, 2);
    CHECK("box: an invalid box draws nothing", at(untouched, 10, 5, 5) == 0x1111 && at(untouched, 10, 0, 0) == 0x1111);
}

// ------------------------------------------------------------------------------------------ sharpen
static void testSharpen() {
    auto flat = solid(20, 12, pix_pack(120, 130, 140));
    auto ref = flat;
    sharpen565(flat.data(), 20, 12);
    CHECK("sharpen: a flat picture is unchanged", flat == ref);

    // a vertical edge: dark | light. The dark side gets darker and the light side lighter next to it.
    std::vector<uint8_t> e(20 * 12 * 2);
    for (int y = 0; y < 12; y++) for (int x = 0; x < 20; x++) pix_put(&e[((size_t)y * 20 + x) * 2], x < 10 ? pix_pack(80, 80, 80) : pix_pack(180, 180, 180));
    auto before = e;
    sharpen565(e.data(), 20, 12);
    CHECK("sharpen: the dark side of an edge gets darker", pix_luma(at(e, 20, 9, 6)) < pix_luma(at(before, 20, 9, 6)));
    CHECK("sharpen: the light side of an edge gets lighter", pix_luma(at(e, 20, 10, 6)) > pix_luma(at(before, 20, 10, 6)));
    CHECK("sharpen: away from the edge nothing changes", at(e, 20, 4, 6) == at(before, 20, 4, 6) && at(e, 20, 15, 6) == at(before, 20, 15, 6));
    CHECK("sharpen: the border rows and columns are left alone", at(e, 20, 9, 0) == at(before, 20, 9, 0) && at(e, 20, 0, 6) == at(before, 20, 0, 6) && at(e, 20, 19, 11) == at(before, 20, 19, 11));

    // clamping: pure white next to pure black must not wrap around
    std::vector<uint8_t> w2(20 * 12 * 2);
    for (int y = 0; y < 12; y++) for (int x = 0; x < 20; x++) pix_put(&w2[((size_t)y * 20 + x) * 2], x < 10 ? 0x0000 : 0xFFFF);
    sharpen565(w2.data(), 20, 12);
    CHECK("sharpen: black and white saturate instead of wrapping", at(w2, 20, 9, 6) == 0x0000 && at(w2, 20, 10, 6) == 0xFFFF);

    // it reads the ORIGINAL neighbours, not pixels it has already changed (so the result does not
    // depend on the scan direction): a one-pixel dot gets the same boost whichever way it is scanned
    std::vector<uint8_t> d(9 * 9 * 2);
    for (int i = 0; i < 81; i++) pix_put(&d[(size_t)i * 2], pix_pack(100, 100, 100));
    pix_put(&d[(4 * 9 + 4) * 2], pix_pack(160, 160, 160));
    sharpen565(d.data(), 9, 9);
    const int up = pix_luma(at(d, 9, 4, 3)), dn = pix_luma(at(d, 9, 4, 5)), lf = pix_luma(at(d, 9, 3, 4)), rt = pix_luma(at(d, 9, 5, 4));
    CHECK("sharpen: the four neighbours of a dot are treated alike", up == dn && lf == rt && std::abs(up - lf) <= 1 && up < 100);
    CHECK("sharpen: the dot itself is boosted", pix_luma(at(d, 9, 4, 4)) > 160);
    std::vector<uint8_t> tiny(2 * 2 * 2, 0x55);
    sharpen565(tiny.data(), 2, 2);
    CHECK("sharpen: a picture too small to have an interior is untouched", tiny[0] == 0x55 && tiny[7] == 0x55);
}

int main() {
    testModes();
    testJpegTools();
    testView();
    testFit();
    testFilters();
    testMotion();
    testHistory();
    testRecPolicy();
    testBox();
    testSharpen();
    printf(failed ? "\n%d FAILED\n" : "\nall passed\n", failed);
    return failed ? 1 : 0;
}
