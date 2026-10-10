#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>

// Band-delta protocol shared by the camera and the Bruce app.
//
// The picture is cut into horizontal bands (16 rows, the JPEG MCU height). The
// camera numbers every picture update with `seq`, and remembers in `bandSeq[i]`
// the update at which band i last changed. A viewer asks "what changed since
// seq S?" and gets only those bands. Because the answer depends only on S, it
// is stateless: a lost response is fixed by simply asking again, and any number
// of viewers can ask independently.
//
//   GET /d?f=8&s=<since>   bands as raw RGB332 (8-bit, dithered, no decode)
//   GET /d?f=j&s=<since>   bands as small standalone JPEGs (16-bit colour)
//
// Response body (all little-endian):
//   u16 mask      bit i set = band i is included
//   u32 seq       the viewer should pass this as `s` next time
//   u8  motion    0..100, how much of the scene is moving right now
//   u8  flags     DF_* bits below
//   then, for each set bit in ascending order:  u16 len, then len bytes
//
// If a viewer sends s greater than the camera's seq, the camera has rebooted;
// the response carries the (smaller) seq so the viewer knows to restart at 0.
//
// Pure C++ (no RTOS), so tools/test_delta.cpp can test it on a PC. Callers hold
// their own lock around the DeltaState.

#define DELTA_MAX_BANDS 16
#define DELTA_HEADER    8

// flags in the reply header
#define DF_REC      0x01 // the camera is recording a clip
#define DF_SD       0x02 // an SD card is working
#define DF_BIG      0x04 // the moving area is person-sized
#define DF_MOTION   0x08 // motion is active (held for a few seconds after it stops)
#define DF_OVERRIDE 0x10 // the picture is a rewind / photo / clip, not the live view

struct DeltaState {
    uint32_t seq;                      // latest picture update (0 = no picture yet)
    uint32_t bandSeq[DELTA_MAX_BANDS]; // update at which each band last changed
    uint32_t jpgSeq[DELTA_MAX_BANDS];  // update the stored strip JPEG corresponds to (0 = none)
    uint16_t jpgLen[DELTA_MAX_BANDS];  // size of the stored strip JPEG
};

// Which bands does a viewer at `since` need? `*seqOut` is what to tell the
// viewer to use next time. In JPEG mode a changed band whose strip isn't
// encoded yet is left out and `*waiting` is set; the reported seq is then held
// just below that band so the viewer asks for it again.
static inline uint32_t deltaPlan(const DeltaState &s, uint32_t since, bool jpg, int nb, uint32_t *seqOut, bool *waiting) {
    uint32_t mask = 0, limit = s.seq;
    bool wait = false;
    for (int i = 0; i < nb; i++) {
        if (s.bandSeq[i] <= since) continue;
        if (jpg && s.jpgSeq[i] != s.bandSeq[i]) {
            wait = true;
            if (s.bandSeq[i] - 1 < limit) limit = s.bandSeq[i] - 1;
            continue;
        }
        mask |= 1u << i;
    }
    *seqOut = limit;
    *waiting = wait;
    return mask;
}

static inline int deltaBandRows(int i, int nb, int bandH, int h) { return (i == nb - 1) ? (h - i * bandH) : bandH; }

// Serialise the response. Returns its length, or 0 if `cap` is too small.
//   raw      full RGB332 frame (w*h bytes), used when !jpg
//   jpgBufs  one strip JPEG per band, used when jpg (length from s.jpgLen)
static inline size_t deltaBuild(
    uint8_t *out, size_t cap, const DeltaState &s, uint32_t mask, uint32_t seq, uint8_t motion, uint8_t flags, bool jpg,
    int nb, int bandH, int w, int h, const uint8_t *raw, const uint8_t *const *jpgBufs
) {
    if (cap < DELTA_HEADER) return 0;
    size_t o = 0;
    out[o++] = (uint8_t)(mask & 0xFF);
    out[o++] = (uint8_t)((mask >> 8) & 0xFF);
    out[o++] = (uint8_t)(seq & 0xFF);
    out[o++] = (uint8_t)((seq >> 8) & 0xFF);
    out[o++] = (uint8_t)((seq >> 16) & 0xFF);
    out[o++] = (uint8_t)((seq >> 24) & 0xFF);
    out[o++] = motion;
    out[o++] = flags;
    for (int i = 0; i < nb; i++) {
        if (!(mask & (1u << i))) continue;
        const uint8_t *src;
        size_t len;
        if (jpg) {
            src = jpgBufs[i];
            len = s.jpgLen[i];
        } else {
            src = raw + (size_t)i * bandH * w;
            len = (size_t)deltaBandRows(i, nb, bandH, h) * w;
        }
        if (o + 2 + len > cap) return 0;
        out[o++] = (uint8_t)(len & 0xFF);
        out[o++] = (uint8_t)((len >> 8) & 0xFF);
        if (len) memcpy(out + o, src, len);
        o += len;
    }
    return o;
}
