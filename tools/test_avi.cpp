// Host test for firmware/mini_cctv/avi.h. Takes a directory of frame_*.jpg files (made by
// tools/run_tests.sh with Pillow), writes an AVI, reads it back with the reader, and leaves the
// AVI at <dir>/out.avi so ffprobe / ffmpeg can independently validate it.
//   g++ -std=c++17 -O1 -g -fsanitize=address,undefined -I firmware/mini_cctv tools/test_avi.cpp -o /tmp/ta && /tmp/ta <dir> <nframes>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "avi.h"
#include "jpegtools.h"

static int failed = 0;
#define CHECK(name, cond)                                \
    do {                                                 \
        bool ok_ = (cond);                               \
        printf("%s %s\n", ok_ ? "PASS" : "FAIL", name);  \
        if (!ok_) failed++;                              \
    } while (0)

static size_t fwrite_cb(void *c, const void *d, size_t n) { return fwrite(d, 1, n, (FILE *)c); }
static bool fseek_cb(void *c, uint32_t p) { return fseek((FILE *)c, (long)p, SEEK_SET) == 0; }
static size_t fread_cb(void *c, void *b, size_t n) { return fread(b, 1, n, (FILE *)c); }

static std::vector<uint8_t> slurp(const std::string &path) {
    std::vector<uint8_t> v;
    FILE *f = fopen(path.c_str(), "rb");
    if (!f) return v;
    uint8_t buf[4096];
    size_t n;
    while ((n = fread(buf, 1, sizeof buf, f)) > 0) v.insert(v.end(), buf, buf + n);
    fclose(f);
    return v;
}

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: test_avi <dir> <nframes>\n"); return 2; }
    const std::string dir = argv[1];
    const int n = atoi(argv[2]);
    std::vector<std::vector<uint8_t>> jpgs;
    for (int i = 0; i < n; i++) jpgs.push_back(slurp(dir + "/frame_" + std::to_string(i) + ".jpg"));
    bool anyOdd = false, anyEven = false;
    for (auto &j : jpgs) { (j.size() & 1 ? anyOdd : anyEven) = true; }
    CHECK("test frames include both odd and even sizes (exercises padding)", anyOdd && anyEven);

    {
        int jw = 0, jh = 0;
        CHECK("jpegSize on real Pillow JPEGs gives 320x240", jpegSize(jpgs[0].data(), jpgs[0].size(), &jw, &jh) && jw == 320 && jh == 240);
    }

    const std::string path = dir + "/out.avi";
    FILE *f = fopen(path.c_str(), "wb+");
    AviIO wio = {f, fwrite_cb, fseek_cb};
    std::vector<uint32_t> offs(100), sizes(100);
    AviWriter w;
    bool ok = w.begin(wio, 320, 240, offs.data(), sizes.data(), 100);
    for (auto &j : jpgs) ok = ok && w.addFrame(j.data(), (uint32_t)j.size());
    ok = ok && w.finish(100000); // 10 fps
    fclose(f);
    CHECK("writer: begin, frames and finish all succeed", ok && w.frames == (uint32_t)n);
    bool tinyOk;
    {
        AviWriter w2;
        FILE *g = fopen((dir + "/tiny.avi").c_str(), "wb+");
        AviIO io = {g, fwrite_cb, fseek_cb};
        uint32_t o[1], sz[1];
        w2.begin(io, 320, 240, o, sz, 1);
        bool a1 = w2.addFrame(jpgs[0].data(), (uint32_t)jpgs[0].size());
        bool a2 = w2.addFrame(jpgs[0].data(), (uint32_t)jpgs[0].size());
        fclose(g);
        tinyOk = a1 && !a2;
    }
    CHECK("writer: refuses more frames than the index has room for", tinyOk);

    // read it back
    FILE *r = fopen(path.c_str(), "rb");
    fseek(r, 0, SEEK_END);
    uint32_t size = (uint32_t)ftell(r);
    AviReadIO rio = {r, fread_cb, fseek_cb, size};
    AviInfo info;
    CHECK("reader: opens the file and finds the index", aviOpen(rio, &info));
    CHECK("reader: size, rate and frame count", info.w == 320 && info.h == 240 && info.usPerFrame == 100000 && info.frames == (uint32_t)n);
    std::vector<uint32_t> ro(100), rs(100);
    uint32_t got = aviReadIndex(rio, info, ro.data(), rs.data(), 100);
    CHECK("reader: index has every frame", got == (uint32_t)n);
    bool same = true;
    std::vector<uint8_t> buf(100000);
    for (int i = n - 1; i >= 0; i--) { // backwards: proves random access works
        uint32_t len = aviReadFrame(rio, ro[i], rs[i], buf.data(), (uint32_t)buf.size());
        if (len != jpgs[i].size() || memcmp(buf.data(), jpgs[i].data(), len)) same = false;
    }
    CHECK("reader: every frame comes back byte for byte, in any order", same);
    CHECK("reader: a buffer that is too small is refused", aviReadFrame(rio, ro[0], rs[0], buf.data(), 10) == 0);
    CHECK("reader: a wrong offset is refused", aviReadFrame(rio, ro[0] + 3, rs[0], buf.data(), (uint32_t)buf.size()) == 0);
    fclose(r);

    // a truncated file (power cut mid-clip: header never patched, no index) must not be accepted as valid
    {
        std::vector<uint8_t> all = slurp(path);
        all.resize(all.size() / 2);
        struct Mem { std::vector<uint8_t> d; size_t pos; } m = {all, 0};
        AviReadIO mio = {&m, [](void *c, void *b, size_t n) -> size_t { Mem *m = (Mem *)c; size_t k = std::min(n, m->d.size() - m->pos); memcpy(b, m->d.data() + m->pos, k); m->pos += k; return k; },
                         [](void *c, uint32_t p) -> bool { ((Mem *)c)->pos = p; return true; }, (uint32_t)all.size()};
        AviInfo bad;
        CHECK("reader: a truncated file is rejected, not misread", !aviOpen(mio, &bad));
    }

    printf(failed ? "\n%d FAILED\n" : "\nall passed\n", failed);
    return failed ? 1 : 0;
}
