#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>

// Pure helpers for the camera's over-the-air update. Tested on a PC by tools/test_ota.cpp.
//
// The update flow, in short: the Stick sends the home WiFi name and password to the camera (POST
// /ota). The camera drops its own network, joins the home WiFi, downloads a small manifest from a
// fixed GitHub address (it never takes a URL from the Stick), and only if the manifest's firmware is
// newer than its own does it download that image, check its size and MD5 against the manifest, and
// switch to it.

// "2.10.3" -> 2*1000000 + 10*1000 + 3. Returns -1 for anything that is not major.minor.patch (each
// part 0..999).
static inline long otaVersion(const char *s) {
    if (!s || !*s) return -1;
    long parts[3] = {0, 0, 0};
    int n = 0;
    const char *p = s;
    while (n < 3) {
        if (*p < '0' || *p > '9') return -1;
        long v = 0;
        int digits = 0;
        while (*p >= '0' && *p <= '9') {
            v = v * 10 + (*p - '0');
            if (++digits > 3) return -1;
            p++;
        }
        parts[n++] = v;
        if (*p == '.') {
            p++;
            continue;
        }
        break;
    }
    if (n != 3 || *p != 0) return -1;
    return parts[0] * 1000000L + parts[1] * 1000L + parts[2];
}

// +1 if a is newer than b, 0 if equal, -1 if older. An unreadable version counts as older than any
// readable one, and two unreadable ones as equal (so nothing is ever "newer" than garbage).
static inline int otaCompare(const char *a, const char *b) {
    const long va = otaVersion(a), vb = otaVersion(b);
    if (va < 0 && vb < 0) return 0;
    if (va < 0) return -1;
    if (vb < 0) return 1;
    return va > vb ? 1 : (va < vb ? -1 : 0);
}

static inline int otaHexVal(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

// application/x-www-form-urlencoded decoding of one value (%XX and +). Writes at most cap-1 bytes and
// a terminating 0. Returns the length, or -1 if the input is not valid (bad %XX, or it does not fit).
static inline int otaUrlDecode(const char *in, size_t inLen, char *out, size_t cap) {
    if (cap == 0) return -1;
    size_t o = 0;
    for (size_t i = 0; i < inLen; i++) {
        char c = in[i];
        if (c == '+') c = ' ';
        else if (c == '%') {
            if (i + 2 >= inLen) return -1; // needs two hex digits after it
            const int h = otaHexVal(in[i + 1]), l = otaHexVal(in[i + 2]);
            if (h < 0 || l < 0) return -1;
            c = (char)((h << 4) | l);
            i += 2;
        }
        if (o + 1 >= cap) return -1;
        out[o++] = c;
    }
    out[o] = 0;
    return (int)o;
}

// Finds `"key":"value"` in a small JSON text and copies value (no escapes are interpreted: the
// manifest only holds plain version strings, URLs and hex digests). Returns the length or -1.
static inline int otaJsonString(const char *json, const char *key, char *out, size_t cap) {
    if (!json || !key || cap == 0) return -1;
    char pat[48];
    const size_t kl = strlen(key);
    if (kl + 4 >= sizeof pat) return -1;
    pat[0] = '"';
    memcpy(pat + 1, key, kl);
    pat[kl + 1] = '"';
    pat[kl + 2] = 0;
    const char *p = strstr(json, pat);
    if (!p) return -1;
    p += kl + 2;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (*p != ':') return -1;
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (*p != '"') return -1;
    p++;
    size_t o = 0;
    while (*p && *p != '"') {
        if (*p == '\\') return -1; // escapes are not supported
        if (o + 1 >= cap) return -1;
        out[o++] = *p++;
    }
    if (*p != '"') return -1;
    out[o] = 0;
    return (int)o;
}

// Finds `"key": 123` and returns the number, or -1.
static inline long otaJsonInt(const char *json, const char *key) {
    if (!json || !key) return -1;
    char pat[48];
    const size_t kl = strlen(key);
    if (kl + 4 >= sizeof pat) return -1;
    pat[0] = '"';
    memcpy(pat + 1, key, kl);
    pat[kl + 1] = '"';
    pat[kl + 2] = 0;
    const char *p = strstr(json, pat);
    if (!p) return -1;
    p += kl + 2;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (*p != ':') return -1;
    p++;
    while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++;
    if (*p < '0' || *p > '9') return -1;
    long v = 0;
    int digits = 0;
    while (*p >= '0' && *p <= '9') {
        v = v * 10 + (*p - '0');
        if (++digits > 9) return -1;
        p++;
    }
    return v;
}

// 32 lowercase hex digits?
static inline bool otaIsMd5(const char *s) {
    if (!s || strlen(s) != 32) return false;
    for (int i = 0; i < 32; i++)
        if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false;
    return true;
}

// The pieces of a manifest the camera needs.
struct OtaManifest {
    bool ok;
    char fw[16];
    char url[160];
    char md5[40];
    long size;
};

// Reads the manifest and checks every field is sane: a version, an https URL on the allowed prefix, a
// 32-digit MD5 and a plausible image size (64 KB .. maxSize).
static inline OtaManifest otaParseManifest(const char *json, const char *allowedPrefix, long maxSize) {
    OtaManifest m;
    memset(&m, 0, sizeof m);
    if (otaJsonString(json, "fw", m.fw, sizeof m.fw) < 0 || otaVersion(m.fw) < 0) return m;
    if (otaJsonString(json, "fw_url", m.url, sizeof m.url) < 0) return m;
    if (strncmp(m.url, allowedPrefix, strlen(allowedPrefix)) != 0) return m;
    if (strncmp(m.url, "https://", 8) != 0) return m;
    if (otaJsonString(json, "fw_md5", m.md5, sizeof m.md5) < 0 || !otaIsMd5(m.md5)) return m;
    m.size = otaJsonInt(json, "fw_size");
    if (m.size < 65536 || m.size > maxSize) return m;
    m.ok = true;
    return m;
}
