// Host test for firmware/mini_cctv/delta.h (the band-delta protocol), run under ASan.
//   g++ -std=c++17 -O1 -g -fsanitize=address,undefined -I firmware/mini_cctv tools/test_delta.cpp -o /tmp/test_delta
//   /tmp/test_delta [golden_dir]
//
// With a directory it also writes "golden" responses (raw bytes exactly as the camera would send them)
// that tools/test_app.js feeds to the real Bruce app, so the C++ encoder and the JS parser are checked
// against each other.
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "delta.h"
#include "filters.h"
#include "modes.h"

static int failed = 0;
#define CHECK(name, cond)                                \
    do {                                                 \
        bool ok_ = (cond);                               \
        printf("%s %s\n", ok_ ? "PASS" : "FAIL", name);  \
        if (!ok_) failed++;                              \
    } while (0)

static const int W = 240, H = 135, BH = 16, NB = 9;

struct Parsed {
    uint32_t mask, seq;
    int motion, flags;
    std::vector<std::pair<int, std::vector<uint8_t>>> bands; // band index, payload
    bool ok;
};

// Independent reference parser (mirrors what the JS app does).
static Parsed parse(const std::vector<uint8_t> &b) {
    Parsed p{0, 0, 0, 0, {}, false};
    if (b.size() < DELTA_HEADER) return p;
    p.mask = b[0] | (b[1] << 8);
    p.seq = b[2] | (b[3] << 8) | (b[4] << 16) | ((uint32_t)b[5] << 24);
    p.motion = b[6];
    p.flags = b[7];
    size_t off = DELTA_HEADER;
    for (int i = 0; i < NB; i++) {
        if (!(p.mask & (1u << i))) continue;
        if (off + 2 > b.size()) return p;
        size_t len = b[off] | (b[off + 1] << 8);
        off += 2;
        if (off + len > b.size()) return p;
        p.bands.push_back({i, std::vector<uint8_t>(b.begin() + off, b.begin() + off + len)});
        off += len;
    }
    p.ok = (off == b.size());
    return p;
}

static std::vector<uint8_t> build(const DeltaState &s, uint32_t since, bool jpg, const std::vector<uint8_t> &raw,
                                  const std::vector<std::vector<uint8_t>> &strips, uint32_t *maskOut = nullptr,
                                  bool *waitOut = nullptr, uint8_t motion = 37, uint8_t flags = DF_SD | DF_MOTION) {
    uint32_t seq;
    bool waiting;
    uint32_t mask = deltaPlan(s, since, jpg, NB, &seq, &waiting);
    std::vector<const uint8_t *> ptrs(NB);
    for (int i = 0; i < NB; i++) ptrs[i] = strips[i].data();
    std::vector<uint8_t> out(DELTA_HEADER + NB * (2 + 12288));
    size_t n = deltaBuild(out.data(), out.size(), s, mask, seq, motion, flags, jpg, NB, BH, W, H, raw.data(), ptrs.data());
    out.resize(n);
    if (maskOut) *maskOut = mask;
    if (waitOut) *waitOut = waiting;
    return out;
}

static void writeFile(const std::string &path, const std::vector<uint8_t> &v) {
    FILE *f = fopen(path.c_str(), "wb");
    if (!f) { perror(path.c_str()); exit(2); }
    fwrite(v.data(), 1, v.size(), f);
    fclose(f);
}

int main(int argc, char **argv) {
    std::vector<uint8_t> raw((size_t)W * H);
    for (size_t i = 0; i < raw.size(); i++) raw[i] = (uint8_t)(i * 7 + (i / W) * 13);
    std::vector<std::vector<uint8_t>> strips(NB);
    for (int i = 0; i < NB; i++) {
        strips[i].assign(300 + i * 40, (uint8_t)(0x10 + i));
        strips[i][0] = 0xFF; strips[i][1] = 0xD8; // looks like a JPEG start
    }

    DeltaState s;
    memset(&s, 0, sizeof s);

    // no picture yet
    {
        uint32_t m; auto r = build(s, 0, false, raw, strips, &m);
        auto p = parse(r);
        CHECK("no picture yet: empty reply, seq 0", p.ok && m == 0 && p.seq == 0 && r.size() == DELTA_HEADER);
    }

    // first picture: every band at seq 1
    s.seq = 1;
    for (int i = 0; i < NB; i++) s.bandSeq[i] = 1;
    std::vector<uint8_t> full8 = build(s, 0, false, raw, strips);
    {
        auto p = parse(full8);
        bool rowsOk = p.ok && p.mask == 0x1FF && p.seq == 1 && p.bands.size() == 9;
        for (auto &b : p.bands) {
            size_t rows = (b.first == 8) ? 7 : 16;
            rowsOk = rowsOk && b.second.size() == rows * W &&
                     std::equal(b.second.begin(), b.second.end(), raw.begin() + (size_t)b.first * BH * W);
        }
        CHECK("raw8 full frame: 9 bands, last band 7 rows, content intact", rowsOk);
        CHECK("raw8 full frame size = 8 + 2*9 + 240*135", full8.size() == DELTA_HEADER + 18 + (size_t)W * H);
        CHECK("header carries the motion level and flags", p.motion == 37 && p.flags == (DF_SD | DF_MOTION));
    }

    // viewer is up to date
    {
        uint32_t m; auto r = build(s, 1, false, raw, strips, &m);
        CHECK("up to date: empty reply, seq echoed", m == 0 && parse(r).ok && parse(r).seq == 1);
    }

    // bands 2 and 3 change at seq 2
    s.seq = 2; s.bandSeq[2] = 2; s.bandSeq[3] = 2;
    {
        uint32_t m; auto r = build(s, 1, false, raw, strips, &m);
        auto p = parse(r);
        CHECK("delta: only bands 2,3", p.ok && m == ((1u << 2) | (1u << 3)) && p.seq == 2 && p.bands.size() == 2);
        uint32_t m0; build(s, 0, false, raw, strips, &m0);
        CHECK("since=0 still returns everything", m0 == 0x1FF);
        uint32_t m2; build(s, 2, false, raw, strips, &m2);
        CHECK("since=latest: nothing", m2 == 0);
    }

    // camera rebooted: viewer is ahead of the camera
    {
        uint32_t m; auto r = build(s, 500, false, raw, strips, &m);
        auto p = parse(r);
        CHECK("viewer ahead of camera (reboot): empty reply with smaller seq", m == 0 && p.ok && p.seq == 2 && p.seq < 500);
    }

    // JPEG mode: band 4 changed at seq 3 but its strip isn't encoded yet
    s.seq = 3; s.bandSeq[4] = 3;
    for (int i = 0; i < NB; i++) { s.jpgSeq[i] = s.bandSeq[i]; s.jpgLen[i] = (uint16_t)strips[i].size(); }
    s.jpgSeq[4] = 2; // stale
    {
        uint32_t m; bool w; auto r = build(s, 2, true, raw, strips, &m, &w);
        auto p = parse(r);
        CHECK("jpg: unencoded band is held back and flagged waiting", w && m == 0 && p.ok && p.seq == 2);
        s.jpgSeq[4] = 3;
        r = build(s, 2, true, raw, strips, &m, &w);
        p = parse(r);
        CHECK("jpg: once encoded it is sent", !w && m == (1u << 4) && p.ok && p.seq == 3 && p.bands.size() == 1 &&
                                                  p.bands[0].second == strips[4]);
    }

    // jpg partial hold-back: bands 2 (ready, seq 2) and 4 (not ready, seq 4)
    {
        DeltaState t;
        memset(&t, 0, sizeof t);
        t.seq = 4;
        for (int i = 0; i < NB; i++) { t.bandSeq[i] = 1; t.jpgSeq[i] = 1; t.jpgLen[i] = (uint16_t)strips[i].size(); }
        t.bandSeq[2] = 2; t.jpgSeq[2] = 2;
        t.bandSeq[4] = 4; t.jpgSeq[4] = 1;
        uint32_t m; bool w; auto r = build(t, 1, true, raw, strips, &m, &w);
        auto p = parse(r);
        CHECK("jpg: ready band sent, reported seq stays below the held-back band", w && m == (1u << 2) && p.seq == 3);
    }

    // capacity
    {
        std::vector<uint8_t> tiny(100);
        std::vector<const uint8_t *> ptrs(NB);
        for (int i = 0; i < NB; i++) ptrs[i] = strips[i].data();
        size_t n = deltaBuild(tiny.data(), tiny.size(), s, 0x1FF, 3, 0, 0, false, NB, BH, W, H, raw.data(), ptrs.data());
        CHECK("too-small buffer is refused, not overrun", n == 0);
    }

    if (argc > 1) {
        std::string dir = argv[1];
        writeFile(dir + "/d8_full.bin", full8);
        writeFile(dir + "/d8_full_fb.bin", raw);
        // golden JPEG-mode response: bands 2 and 4 at since=1 (state t above, but all ready)
        DeltaState t;
        memset(&t, 0, sizeof t);
        t.seq = 4;
        for (int i = 0; i < NB; i++) { t.bandSeq[i] = 1; t.jpgSeq[i] = 1; t.jpgLen[i] = (uint16_t)strips[i].size(); }
        t.bandSeq[2] = 2; t.jpgSeq[2] = 2;
        t.bandSeq[8] = 4; t.jpgSeq[8] = 4;
        writeFile(dir + "/dj_partial.bin", build(t, 1, true, raw, strips));
        // sidecar so the JS test knows what to expect: "band len firstByte secondByte" lines
        FILE *f = fopen((dir + "/dj_partial.txt").c_str(), "w");
        fprintf(f, "2 %zu %d %d\n8 %zu %d %d\n", strips[2].size(), strips[2][0], strips[2][1], strips[8].size(), strips[8][0], strips[8][1]);
        fclose(f);
        // the firmware's own mode and filter tables, so the Bruce app can be checked against them
        FILE *m = fopen((dir + "/modes.txt").c_str(), "w");
        for (int i = 0; i < MODE_COUNT; i++)
            fprintf(m, "%s|%s|%d|%d\n", modeName(i), modeBlurb(i), modeCaps(i).alerts ? 1 : 0, modeCaps(i).needsSd ? 1 : 0);
        fprintf(m, "filters");
        for (int i = 0; i < FILTER_COUNT; i++) fprintf(m, "|%s", filterName(i));
        fprintf(m, "\n");
        fclose(m);
        printf("wrote golden files to %s\n", dir.c_str());
    }

    printf(failed ? "\n%d FAILED\n" : "\nall passed\n", failed);
    return failed ? 1 : 0;
}
