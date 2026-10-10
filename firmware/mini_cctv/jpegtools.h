#pragma once
#include <stddef.h>
#include <stdint.h>

// Small JPEG helpers (pure C++, tested on a PC by tools/test_avi.cpp and tools/test_features.cpp).

// Reads the picture size from a JPEG's start-of-frame marker. Returns false if it isn't a JPEG
// or the marker isn't found. Lets the camera pick a decode scale and size its buffer before
// decoding a file it didn't just make.
static inline bool jpegSize(const uint8_t *d, size_t n, int *w, int *h) {
    if (n < 4 || d[0] != 0xFF || d[1] != 0xD8) return false;
    size_t i = 2;
    while (i + 4 < n) {
        if (d[i] != 0xFF) { i++; continue; }
        const uint8_t m = d[i + 1];
        if (m == 0xFF) { i++; continue; }           // fill bytes
        if (m == 0xD8 || m == 0x01 || (m >= 0xD0 && m <= 0xD7)) { i += 2; continue; } // no length
        const size_t len = ((size_t)d[i + 2] << 8) | d[i + 3];
        if ((m >= 0xC0 && m <= 0xCF) && m != 0xC4 && m != 0xC8 && m != 0xCC) { // SOFn
            if (i + 9 >= n) return false;
            *h = (d[i + 5] << 8) | d[i + 6];
            *w = (d[i + 7] << 8) | d[i + 8];
            return *w > 0 && *h > 0;
        }
        if (m == 0xDA) return false; // start of scan reached with no SOF
        i += 2 + len;
    }
    return false;
}

// The JPEG decoder in the camera driver hands back RGB565 in whatever byte order / channel order
// its version uses. The camera decodes a known pure-red test picture once at boot and uses this
// to work out which layout it is, then normalises every decoded picture to big-endian RGB565
// (high byte first), which is what the rest of the pipeline expects.
//
// layout: bit0 = bytes are little-endian (low byte first), bit1 = red and blue are swapped.
// Returns -1 if the sample doesn't look like red in any layout.
static inline int decoderLayoutFromRed(uint8_t b0, uint8_t b1) {
    for (int layout = 0; layout < 4; layout++) {
        const uint16_t v = (layout & 1) ? (uint16_t)((b1 << 8) | b0) : (uint16_t)((b0 << 8) | b1);
        const int r5 = (v >> 11) & 31, b5 = v & 31;
        const int red = (layout & 2) ? b5 : r5;
        const int blue = (layout & 2) ? r5 : b5;
        if (red >= 26 && blue <= 5 && ((v >> 5) & 63) <= 10) return layout;
    }
    return -1;
}

static inline void decoderNormalize(uint8_t *buf, size_t pixels, int layout) {
    if (layout <= 0) return;
    for (size_t i = 0; i < pixels; i++) {
        uint8_t *p = buf + i * 2;
        uint16_t v = (layout & 1) ? (uint16_t)((p[1] << 8) | p[0]) : (uint16_t)((p[0] << 8) | p[1]);
        if (layout & 2) v = (uint16_t)(((v & 0x1F) << 11) | (v & 0x07E0) | ((v >> 11) & 0x1F));
        p[0] = (uint8_t)(v >> 8);
        p[1] = (uint8_t)(v & 0xFF);
    }
}
