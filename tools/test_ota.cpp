// Host tests (AddressSanitizer) for the over-the-air update helpers.
//   g++ -std=c++17 -O1 -g -fsanitize=address,undefined -I firmware/mini_cctv tools/test_ota.cpp -o /tmp/to && /tmp/to
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "config.h"
#include "ota.h"

static int failed = 0;
#define CHECK(name, cond)                                \
    do {                                                 \
        bool ok_ = (cond);                               \
        printf("%s %s\n", ok_ ? "PASS" : "FAIL", name);  \
        if (!ok_) failed++;                              \
    } while (0)

static std::string dec(const std::string &in, size_t cap = 64, int *rc = nullptr) {
    std::string buf(cap, '\0');
    const int n = otaUrlDecode(in.data(), in.size(), &buf[0], cap);
    if (rc) *rc = n;
    return n < 0 ? std::string("<err>") : std::string(buf.c_str());
}

static void testVersions() {
    CHECK("version: parses major.minor.patch", otaVersion("2.1.0") == 2001000L && otaVersion("10.20.30") == 10020030L);
    CHECK("version: rejects anything else", otaVersion("") == -1 && otaVersion("2.1") == -1 && otaVersion("2.1.0.1") == -1 && otaVersion("v2.1.0") == -1 && otaVersion("2.1.x") == -1 && otaVersion("2..1") == -1 && otaVersion("2.1.0 ") == -1 && otaVersion(nullptr) == -1);
    CHECK("version: parts are limited to three digits", otaVersion("1000.0.0") == -1 && otaVersion("999.999.999") == 999999999L);
    CHECK("compare: newer, equal, older", otaCompare("2.2.0", "2.1.9") == 1 && otaCompare("2.1.0", "2.1.0") == 0 && otaCompare("2.0.9", "2.1.0") == -1);
    CHECK("compare: 2.10.0 is newer than 2.9.0 (numbers, not text)", otaCompare("2.10.0", "2.9.0") == 1 && otaCompare("2.9.0", "2.10.0") == -1);
    CHECK("compare: an unreadable version is older than any readable one", otaCompare("garbage", "0.0.1") == -1 && otaCompare("0.0.1", "garbage") == 1);
    CHECK("compare: two unreadable versions are equal (nothing is newer than garbage)", otaCompare("x", "y") == 0 && otaCompare("", nullptr) == 0);
}

static void testUrlDecode() {
    int rc;
    CHECK("urldecode: plain text is unchanged", dec("HomeWiFi") == "HomeWiFi");
    CHECK("urldecode: + is a space, %XX is a byte", dec("My+Home%20WiFi%21") == "My Home WiFi!");
    CHECK("urldecode: upper and lower case hex", dec("%e2%82%AC") == "\xE2\x82\xAC");
    CHECK("urldecode: a lone % at the end is invalid", dec("abc%", 64, &rc) == "<err>" && rc == -1);
    CHECK("urldecode: % with one digit is invalid", dec("abc%4", 64, &rc) == "<err>" && rc == -1);
    CHECK("urldecode: non-hex after % is invalid", dec("%zz", 64, &rc) == "<err>" && rc == -1);
    CHECK("urldecode: output that does not fit is refused, not truncated", dec("abcdefgh", 8, &rc) == "<err>" && rc == -1 && dec("abcdefg", 8, &rc) == "abcdefg" && rc == 7);
    CHECK("urldecode: empty input is an empty string", dec("", 4, &rc) == "" && rc == 0);
    CHECK("urldecode: a zero-size output buffer is refused", otaUrlDecode("a", 1, nullptr, 0) == -1);
    // exact-size heap buffers with no terminator: reading even one byte past the end is caught by ASan
    {
        char *a = (char *)malloc(2); a[0] = '%'; a[1] = '4';
        char *b = (char *)malloc(3); b[0] = '%'; b[1] = '4'; b[2] = '1';
        char out[8];
        const int ra = otaUrlDecode(a, 2, out, sizeof out);
        const int rb = otaUrlDecode(b, 3, out, sizeof out);
        CHECK("urldecode: a truncated %X at the very end of an unterminated buffer is refused without over-reading", ra == -1 && rb == 1 && out[0] == 'A');
        free(a);
        free(b);
    }
    CHECK("urldecode: a password with every special character survives", dec("p%40ss%26w%3Dr%2Bd%25+%2F", 64) == "p@ss&w=r+d% /");
}

static void testJson() {
    const char *j = "{ \"app\": \"2.1.0\",\n  \"fw\":\"2.2.0\", \"fw_size\" : 1079294,\"fw_md5\":\"0123456789abcdef0123456789abcdef\" }";
    char b[64];
    CHECK("json: reads a string value", otaJsonString(j, "fw", b, sizeof b) == 5 && !strcmp(b, "2.2.0"));
    CHECK("json: tolerates spaces and newlines around : and values", otaJsonString(j, "app", b, sizeof b) == 5 && !strcmp(b, "2.1.0"));
    CHECK("json: a missing key is -1", otaJsonString(j, "nope", b, sizeof b) == -1 && otaJsonInt(j, "nope") == -1);
    CHECK("json: reads an integer", otaJsonInt(j, "fw_size") == 1079294);
    CHECK("json: a string where a number is wanted is -1", otaJsonInt(j, "fw") == -1);
    CHECK("json: a value that does not fit is refused", otaJsonString(j, "fw_md5", b, 10) == -1);
    CHECK("json: escapes are refused", otaJsonString("{\"fw\":\"a\\\"b\"}", "fw", b, sizeof b) == -1);
    CHECK("json: an unterminated string is -1", otaJsonString("{\"fw\":\"2.1", "fw", b, sizeof b) == -1);
    CHECK("json: a key must match whole (fw does not match fw_url)", otaJsonString("{\"fw_url\":\"x\"}", "fw", b, sizeof b) == -1);
    CHECK("json: absurdly long numbers are refused", otaJsonInt("{\"n\":12345678901234}", "n") == -1);
}

static void testManifest() {
    const char *pre = "https://raw.githubusercontent.com/udaydotoffical-svg/mini-cctv/main/dist/";
    std::string good = std::string("{\"app\":\"2.1.0\",\"fw\":\"2.2.0\",\"fw_url\":\"") + pre + "firmware.bin\",\"fw_size\":1079294,\"fw_md5\":\"0123456789abcdef0123456789abcdef\"}";
    OtaManifest m = otaParseManifest(good.c_str(), pre, 3000000);
    CHECK("manifest: a good one is accepted with every field", m.ok && !strcmp(m.fw, "2.2.0") && m.size == 1079294 && !strcmp(m.md5, "0123456789abcdef0123456789abcdef") && !strncmp(m.url, pre, strlen(pre)));

    auto bad = [&](const std::string &s) { return !otaParseManifest(s.c_str(), pre, 3000000).ok; };
    auto with = [&](const char *from, const char *to) { std::string s = good; s.replace(s.find(from), strlen(from), to); return s; };
    CHECK("manifest: a URL outside the allowed prefix is refused", bad(with("raw.githubusercontent.com", "evil.example.com")));
    CHECK("manifest: a plain http URL is refused even on the allowed host", bad(std::string("{\"fw\":\"2.2.0\",\"fw_url\":\"http://raw.githubusercontent.com/udaydotoffical-svg/mini-cctv/main/dist/f.bin\",\"fw_size\":1079294,\"fw_md5\":\"0123456789abcdef0123456789abcdef\"}")));
    CHECK("manifest: a bad MD5 is refused (short, upper case, non-hex)", bad(with("0123456789abcdef0123456789abcdef", "0123")) && bad(with("0123456789abcdef0123456789abcdef", "0123456789ABCDEF0123456789ABCDEF")) && bad(with("0123456789abcdef0123456789abcdef", "zz23456789abcdef0123456789abcdef")));
    CHECK("manifest: a silly size is refused (too small, too big, missing)", bad(with("1079294", "100")) && bad(with("1079294", "9999999")) && bad(with("\"fw_size\":1079294,", "")));
    CHECK("manifest: a bad version is refused", bad(with("\"2.2.0\"", "\"two\"")));
    CHECK("manifest: an empty or garbage document is refused", bad("") && bad("not json") && bad("{}"));
    CHECK("manifest: a URL too long for the buffer is refused", bad(with("firmware.bin", std::string(300, 'a').c_str())));
}

// The manifest that is actually published must be one the camera accepts, with the camera's own limits.
static void testPublished(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) { CHECK("published manifest: dist/version.json can be read", false); return; }
    std::string text;
    char buf[512];
    size_t n;
    while ((n = fread(buf, 1, sizeof buf, f)) > 0) text.append(buf, n);
    fclose(f);
    const OtaManifest m = otaParseManifest(text.c_str(), OTA_URL_PREFIX, OTA_MAX_IMAGE);
    CHECK("published manifest: the camera's own parser accepts dist/version.json", m.ok);
    CHECK("published manifest: its firmware is not older than the firmware being built", otaCompare(m.fw, FW_VERSION) == 0);
}

int main(int argc, char **argv) {
    if (argc > 1) testPublished(argv[1]);
    testVersions();
    testUrlDecode();
    testJson();
    testManifest();
    printf(failed ? "\n%d FAILED\n" : "\nall passed\n", failed);
    return failed ? 1 : 0;
}
