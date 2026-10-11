#pragma once
// Over-the-air update, hardware side. The pure logic (versions, decoding, manifest checks) is in ota.h
// and is tested on a PC. This part needs the board: WiFi, TLS and the flash.
//
// Sequence, started by the Stick's POST /ota with the home WiFi name and password:
//   1. answer the Stick, then drop our own network (the camera "disappears" from the Stick)
//   2. join the home WiFi with the typed credentials (they are kept in RAM only, never saved)
//   3. download the manifest from the fixed GitHub address and read the firmware version from it
//   4. if it is newer than ours: download the image, writing it to the spare app partition while
//      checking its size and MD5 against the manifest; only a matching image becomes the boot image
//   5. restart. Whatever happened, the camera always restarts, so its own network comes back, and a
//      one-line result is left in flash for the Stick to read.
#include <Arduino.h>
#include <Preferences.h>
#include <Update.h>
#include <WiFi.h>

#include "config.h"
#include "esp_http_client.h"
#include "ota.h"

// ESP-IDF's certificate-bundle callback (the full set of root certificates is built into both Arduino
// cores). Declared here because on core 2.x a library header of the same name hides the SDK's.
extern "C" esp_err_t esp_crt_bundle_attach(void *conf);

static volatile bool g_otaBusy = false; // the capture loop idles while this is set
static char g_otaSsid[40];
static char g_otaPass[72];

static void otaSetMsg(const char *m) {
    Preferences p;
    p.begin("cctvota", false);
    p.putString("m", m);
    p.end();
}

// Copies the saved result (empty if none) into out.
static void otaGetMsg(char *out, size_t cap) {
    Preferences p;
    p.begin("cctvota", true);
    const String s = p.getString("m", "");
    p.end();
    snprintf(out, cap, "%s", s.c_str());
    for (char *c = out; *c; c++)
        if (*c == '"' || *c == '\\' || (unsigned char)*c < 32) *c = ' '; // it goes into JSON
}

static void otaClearMsg() {
    Preferences p;
    p.begin("cctvota", false);
    p.remove("m");
    p.end();
}

struct OtaBuf {
    char *buf;
    size_t cap, len;
    bool overflow;
};

static esp_err_t otaManifestEvent(esp_http_client_event_t *e) {
    OtaBuf *b = (OtaBuf *)e->user_data;
    if (e->event_id == HTTP_EVENT_ON_DATA && e->data && e->data_len > 0) {
        if (b->len + (size_t)e->data_len > b->cap) {
            b->overflow = true;
        } else {
            memcpy(b->buf + b->len, e->data, (size_t)e->data_len);
            b->len += (size_t)e->data_len;
        }
    }
    return ESP_OK;
}

struct OtaFlash {
    bool ok;
    size_t written;
};

static esp_err_t otaImageEvent(esp_http_client_event_t *e) {
    OtaFlash *f = (OtaFlash *)e->user_data;
    if (e->event_id == HTTP_EVENT_ON_DATA && e->data && e->data_len > 0 && f->ok) {
        if (Update.write((uint8_t *)e->data, (size_t)e->data_len) != (size_t)e->data_len) f->ok = false;
        f->written += (size_t)e->data_len;
    }
    return ESP_OK;
}

static bool otaGet(const char *url, esp_err_t (*handler)(esp_http_client_event_t *), void *user, int timeoutMs) {
    esp_http_client_config_t c = {};
    c.url = url;
    c.crt_bundle_attach = esp_crt_bundle_attach; // checks the server against the built-in root certificates
    c.timeout_ms = timeoutMs;
    c.event_handler = handler;
    c.user_data = user;
    c.keep_alive_enable = false;
    esp_http_client_handle_t h = esp_http_client_init(&c);
    if (!h) return false;
    const esp_err_t err = esp_http_client_perform(h);
    const int status = esp_http_client_get_status_code(h);
    esp_http_client_cleanup(h);
    return err == ESP_OK && status == 200;
}

[[noreturn]] static void otaFinish(const char *msg) {
    Serial.printf("OTA: %s\n", msg);
    otaSetMsg(msg);
    delay(300);
    ESP.restart();
    for (;;) delay(1000);
}

static void otaTask(void *) {
    vTaskDelay(pdMS_TO_TICKS(700)); // let the reply to the Stick get out before the network goes
    Serial.printf("OTA: leaving our network, joining \"%s\"\n", g_otaSsid);
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);
    WiFi.begin(g_otaSsid, g_otaPass);
    const uint32_t t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < OTA_WIFI_TIMEOUT_MS) delay(250);
    memset(g_otaPass, 0, sizeof g_otaPass); // not needed any more
    if (WiFi.status() != WL_CONNECTED) otaFinish("home WiFi failed: check the name and password");

    char json[768];
    OtaBuf mb = {json, sizeof json - 1, 0, false};
    if (!otaGet(OTA_MANIFEST_URL, otaManifestEvent, &mb, 15000) || mb.overflow) otaFinish("no internet, or GitHub not reachable");
    json[mb.len] = 0;
    const OtaManifest m = otaParseManifest(json, OTA_URL_PREFIX, OTA_MAX_IMAGE);
    if (!m.ok) otaFinish("the update list is not valid");
    if (otaCompare(m.fw, FW_VERSION) <= 0) {
        char msg[64];
        snprintf(msg, sizeof msg, "already the latest (%s)", FW_VERSION);
        otaFinish(msg);
    }

    Serial.printf("OTA: %s -> %s, %ld bytes\n", FW_VERSION, m.fw, m.size);
    if (!Update.begin((size_t)m.size, U_FLASH)) otaFinish("no room for the update");
    Update.setMD5(m.md5);
    OtaFlash fl = {true, 0};
    const bool got = otaGet(m.url, otaImageEvent, &fl, 30000);
    if (!got || !fl.ok) {
        Update.abort();
        otaFinish("download failed");
    }
    if (fl.written != (size_t)m.size) {
        Update.abort();
        otaFinish("downloaded size does not match");
    }
    if (!Update.end(false)) otaFinish("the downloaded image failed its check"); // the MD5 is verified here
    char msg[64];
    snprintf(msg, sizeof msg, "updated to %s", m.fw);
    otaFinish(msg);
}

// Starts the update. Returns false if one is already running.
static bool otaStart(const char *ssid, const char *pass) {
    if (g_otaBusy) return false;
    snprintf(g_otaSsid, sizeof g_otaSsid, "%s", ssid);
    snprintf(g_otaPass, sizeof g_otaPass, "%s", pass);
    g_otaBusy = true;
    if (xTaskCreate(otaTask, "ota", 16384, nullptr, 3, nullptr) != pdPASS) {
        g_otaBusy = false;
        return false;
    }
    return true;
}
