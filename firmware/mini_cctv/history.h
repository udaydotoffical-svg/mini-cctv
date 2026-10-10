#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>

// DVR history: a ring of whole-picture JPEGs in one byte buffer (PSRAM on the camera), newest
// replacing oldest. Frames are never split across the wrap point. Pure C++, tested on a PC by
// tools/test_features.cpp.
//
// The camera stores a frame whenever the picture is moving (a few per second) and only
// occasionally when it is still, so a quiet scene costs almost nothing and minutes of history fit.

struct HistEntry {
    uint32_t t;   // time the frame was taken, ms
    uint32_t off; // where its bytes start in the buffer
    uint32_t len;
};

struct History {
    uint8_t *buf;
    size_t cap;
    HistEntry *ents;
    int maxEnts;
    size_t wpos;
    int head;  // index of the oldest entry in ents
    int count; // entries held

    void init(uint8_t *b, size_t c, HistEntry *e, int m) {
        buf = b;
        cap = c;
        ents = e;
        maxEnts = m;
        wpos = 0;
        head = 0;
        count = 0;
    }

    void dropOldest() {
        head = (head + 1) % maxEnts;
        count--;
    }

    bool push(const uint8_t *jpg, size_t len, uint32_t t) {
        if (len == 0 || len > cap) return false;
        if (wpos + len > cap) wpos = 0; // doesn't fit before the end: start again at the front
        // Drop every frame the new one would overwrite. After a wrap an old frame can still sit
        // at the end of the buffer while a newer one at the front is being overwritten, so the
        // overlapped frame isn't necessarily the oldest: drop from the oldest up to and
        // including the last overlapped one (the ring must stay in time order).
        int last = -1;
        for (int i = 0; i < count; i++) {
            const HistEntry &o = *at(i);
            if ((size_t)o.off < wpos + len && wpos < (size_t)o.off + o.len) last = i;
        }
        for (int i = 0; i <= last; i++) dropOldest();
        if (count >= maxEnts) dropOldest();
        memcpy(buf + wpos, jpg, len);
        ents[(head + count) % maxEnts] = {t, (uint32_t)wpos, (uint32_t)len};
        count++;
        wpos += len;
        return true;
    }

    // i = 0 is the oldest entry
    const HistEntry *at(int i) const { return (i >= 0 && i < count) ? &ents[(head + i) % maxEnts] : nullptr; }
    const uint8_t *data(const HistEntry *e) const { return buf + e->off; }
    uint32_t oldestT() const { return count ? at(0)->t : 0; }
    uint32_t newestT() const { return count ? at(count - 1)->t : 0; }

    // Index of the entry taken at or just before time t (the oldest one if t is older than all).
    int indexAtOrBefore(uint32_t t) const {
        int best = -1;
        for (int i = 0; i < count; i++) {
            if (at(i)->t <= t) best = i;
            else break;
        }
        return count ? (best < 0 ? 0 : best) : -1;
    }
};
