#pragma once
#include <stddef.h>
#include <stdint.h>

// Tiny pixel helpers for big-endian RGB565 (high byte first), the layout the camera driver
// delivers. Pure C++, shared by filters.h and motion.h.

static inline uint16_t pix_get(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }
static inline void pix_put(uint8_t *p, uint16_t v) {
    p[0] = (uint8_t)(v >> 8);
    p[1] = (uint8_t)(v & 0xFF);
}
static inline uint16_t pix_pack(uint32_t r, uint32_t g, uint32_t b) { // 8-bit channels
    return (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3));
}
static inline uint8_t pix_luma(uint16_t v) { // 0..255, Rec.601 weights
    uint32_t r = (v >> 11) & 0x1F, g = (v >> 5) & 0x3F, b = v & 0x1F;
    r = (r << 3) | (r >> 2);
    g = (g << 2) | (g >> 4);
    b = (b << 3) | (b >> 2);
    return (uint8_t)((r * 77 + g * 150 + b * 29) >> 8);
}
