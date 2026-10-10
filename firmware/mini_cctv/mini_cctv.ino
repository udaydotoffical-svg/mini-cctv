// mini-cctv camera node  (Arduino IDE sketch; also builds with PlatformIO, see ../platformio.ini)
//
// Arduino IDE > Tools settings:
//   Board:             XIAO_ESP32S3  (or "ESP32S3 Dev Module" for a generic S3 CAM board)
//   PSRAM:             "OPI PSRAM"   <- required, the sketch stops at boot without it
//   USB CDC On Boot:   "Enabled"     (XIAO / native-USB boards, so Serial Monitor works)
//   Flash Size 8MB+, Partition Scheme: default is fine, CPU 240MHz
//
// Camera pins: pick the model below (or in a build flag). Default is the
// ESP32-S3-EYE pinout (Freenove WROOM CAM and most S3 CAM clones). For a
// Seeed XIAO ESP32S3 Sense use CAMERA_MODEL_XIAO_ESP32S3.
#if !defined(CAMERA_MODEL_ESP32S3_EYE) && !defined(CAMERA_MODEL_XIAO_ESP32S3) && !defined(CAMERA_MODEL_ESP32S3_CAM_LCD)
#define CAMERA_MODEL_ESP32S3_EYE
//#define CAMERA_MODEL_XIAO_ESP32S3
//#define CAMERA_MODEL_ESP32S3_CAM_LCD
#endif

// Pipeline (captureTask, runs continuously):
//   sensor RGB565 (CAM_FRAMESIZE) -> crop + box-filter down to 240x135
//   -> compare with the picture the viewers already have, band by band
//   -> changed bands are copied in, dithered to 8-bit, and (when a viewer wants
//      them) encoded as small JPEG strips
//
// HTTP, port 80:  /d?f=8|j&s=N   changed bands since update N (see delta.h); this is
//                                what the Bruce app uses. Long-polls up to ~150 ms.
//                 /jpg            whole picture as one JPEG (browsers, curl)
//                 /status         JSON stats
//                 /               tiny viewer page (phone / laptop)
// HTTP, port 81:  /stream         MJPEG for browsers / VLC
//
// Why not just send frames? Bruce's drawJpg() blacks out the whole image area
// before decoding, so full-frame JPEGs flash. Bands that only touch what moved
// keep the flash local (JPEG mode) or remove it entirely (8-bit mode), and a
// still scene costs almost nothing to send.

#include <Arduino.h>
#include <WiFi.h>
#include "esp_camera.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "img_converters.h"

#include "camera_pins.h"
#include "config.h"
#include "delta.h"
#include "scaler.h"

#define BAND_H        16 // = JPEG MCU height, so every strip is a clean multiple of MCUs
#define NBANDS        ((OUT_H + BAND_H - 1) / BAND_H)
#define RGB_LEN       ((size_t)OUT_W * OUT_H * 2)
#define RAW_LEN       ((size_t)OUT_W * OUT_H)
#define STRIP_MAX     12288
#define FULL_JPG_MAX  49152
#define RESP_MAX      (6 + (size_t)NBANDS * (2 + STRIP_MAX))
#define LONGPOLL_MS   150
#define STRIP_WAIT_MS 500

static_assert(NBANDS <= DELTA_MAX_BANDS, "too many bands");
static_assert(OUT_H > BAND_H * (NBANDS - 1), "last band must have at least one row");

static SemaphoreHandle_t g_mtx;

// Shared state, guarded by g_mtx. Only captureTask ever writes it.
static DeltaState g_ds;
static uint8_t *g_raw;                 // RGB332 picture, RAW_LEN
static uint8_t *g_strip[NBANDS];       // strip JPEGs, STRIP_MAX each
static uint8_t *g_fullJpg;             // whole-picture JPEG, FULL_JPG_MAX
static size_t g_fullLen;
static uint32_t g_fullSeq;

// Private to captureTask.
static uint8_t *g_refRgb; // the picture viewers currently have (RGB565), RGB_LEN
static uint8_t *g_newRgb; // freshly scaled camera frame, RGB_LEN
static uint8_t *g_rawNew; // dither scratch, RAW_LEN
static uint8_t *g_tmp;    // JPEG scratch, FULL_JPG_MAX

// Private to the /d handler (one httpd task serves port 80, so no overlap).
static uint8_t *g_resp;

static volatile uint32_t g_stripWantedAt; // millis() of last /d?f=j request
static volatile uint32_t g_fullWantedAt;  // millis() of last /jpg or /stream request
static volatile float g_fps;
static volatile uint32_t g_updates;

static httpd_handle_t g_httpd = nullptr;
static httpd_handle_t g_stream = nullptr;

static inline bool recent(uint32_t t, uint32_t ms) { return t != 0 && (uint32_t)(millis() - t) < ms; }

// ---------------------------------------------------------------------------
static bool initCamera() {
    camera_config_t c = {};
    c.ledc_channel = LEDC_CHANNEL_0;
    c.ledc_timer = LEDC_TIMER_0;
    c.pin_d0 = Y2_GPIO_NUM;
    c.pin_d1 = Y3_GPIO_NUM;
    c.pin_d2 = Y4_GPIO_NUM;
    c.pin_d3 = Y5_GPIO_NUM;
    c.pin_d4 = Y6_GPIO_NUM;
    c.pin_d5 = Y7_GPIO_NUM;
    c.pin_d6 = Y8_GPIO_NUM;
    c.pin_d7 = Y9_GPIO_NUM;
    c.pin_xclk = XCLK_GPIO_NUM;
    c.pin_pclk = PCLK_GPIO_NUM;
    c.pin_vsync = VSYNC_GPIO_NUM;
    c.pin_href = HREF_GPIO_NUM;
    c.pin_sccb_sda = SIOD_GPIO_NUM;
    c.pin_sccb_scl = SIOC_GPIO_NUM;
    c.pin_pwdn = PWDN_GPIO_NUM;
    c.pin_reset = RESET_GPIO_NUM;
    c.xclk_freq_hz = 20000000;
    c.pixel_format = PIXFORMAT_RGB565; // works on OV2640/OV3660/OV5640 alike
    c.frame_size = CAM_FRAMESIZE;      // see config.h
    c.jpeg_quality = 12;               // unused for RGB565
    c.fb_count = 2;
    c.fb_location = CAMERA_FB_IN_PSRAM;
    c.grab_mode = CAMERA_GRAB_LATEST;

    esp_err_t err = esp_camera_init(&c);
    if (err != ESP_OK) {
        Serial.printf("camera init failed: 0x%x\n", err);
        return false;
    }
    sensor_t *s = esp_camera_sensor_get();
    if (s) {
        s->set_vflip(s, CAM_VFLIP);
        s->set_hmirror(s, CAM_HMIRROR);
        s->set_brightness(s, CAM_BRIGHTNESS);
        s->set_saturation(s, CAM_SATURATION);
    }
    return true;
}

// ---------------------------------------------------------------------------
// JPEG output sink for fmt2jpg_cb: appends into a fixed buffer, no big malloc.
struct JpgSink {
    uint8_t *buf;
    size_t cap;
    size_t len;
    bool overflow;
};
static size_t jpgSink(void *arg, size_t, const void *data, size_t len) {
    JpgSink *s = (JpgSink *)arg;
    if (len == 0) return 0;
    if (s->len + len > s->cap) {
        s->overflow = true;
        return 0;
    }
    memcpy(s->buf + s->len, data, len);
    s->len += len;
    return len;
}

static size_t encodeJpg(uint8_t *rgb, uint16_t w, uint16_t h, uint8_t quality, uint8_t *dst, size_t cap) {
    JpgSink sink = {dst, cap, 0, false};
    if (!fmt2jpg_cb(rgb, (size_t)w * h * 2, w, h, PIXFORMAT_RGB565, quality, jpgSink, &sink) || sink.overflow) return 0;
    return sink.len;
}

// ---------------------------------------------------------------------------
static void captureTask(void *) {
    int fails = 0;
    uint32_t winStart = millis(), winFrames = 0;
    for (;;) {
        camera_fb_t *fb = esp_camera_fb_get();
        if (!fb) {
            if (++fails > 30) {
                Serial.println("camera stalled, restarting");
                ESP.restart();
            }
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }
        fails = 0;
        scaleBox565(fb->buf, fb->width, fb->height, g_newRgb, OUT_W, OUT_H);
        esp_camera_fb_return(fb);

        // Which bands differ from what viewers already have?
        uint32_t changed = 0;
        if (g_ds.seq == 0) {
            changed = (1u << NBANDS) - 1; // first picture: everything
        } else {
            for (int i = 0; i < NBANDS; i++) {
                const size_t off = (size_t)i * BAND_H * OUT_W * 2;
                const size_t px = (size_t)deltaBandRows(i, NBANDS, BAND_H, OUT_H) * OUT_W;
                if (bandChanged(g_refRgb + off, g_newRgb + off, px, DELTA_PIX_THRESH, DELTA_PIX_COUNT, DELTA_MEAN_THRESH))
                    changed |= 1u << i;
            }
        }

        if (changed) {
            for (int i = 0; i < NBANDS; i++) { // heavy work outside the lock
                if (!(changed & (1u << i))) continue;
                const int rows = deltaBandRows(i, NBANDS, BAND_H, OUT_H);
                const size_t off = (size_t)i * BAND_H * OUT_W * 2;
                memcpy(g_refRgb + off, g_newRgb + off, (size_t)rows * OUT_W * 2);
                rgb565ToRgb332Dither(g_refRgb + off, g_rawNew + (size_t)i * BAND_H * OUT_W, OUT_W, rows, i * BAND_H);
            }
            xSemaphoreTake(g_mtx, portMAX_DELAY);
            const uint32_t seq = g_ds.seq + 1;
            for (int i = 0; i < NBANDS; i++) {
                if (!(changed & (1u << i))) continue;
                const int rows = deltaBandRows(i, NBANDS, BAND_H, OUT_H);
                const size_t o = (size_t)i * BAND_H * OUT_W;
                memcpy(g_raw + o, g_rawNew + o, (size_t)rows * OUT_W);
                g_ds.bandSeq[i] = seq;
            }
            g_ds.seq = seq;
            xSemaphoreGive(g_mtx);
            g_updates++;
        }

        // Strip JPEGs for viewers in Photo mode: only bands that are out of date.
        if (recent(g_stripWantedAt, 4000)) {
            for (int i = 0; i < NBANDS; i++) {
                if (g_ds.jpgSeq[i] == g_ds.bandSeq[i]) continue; // only this task writes these
                const int rows = deltaBandRows(i, NBANDS, BAND_H, OUT_H);
                const size_t off = (size_t)i * BAND_H * OUT_W * 2;
                const size_t n = encodeJpg(g_refRgb + off, OUT_W, rows, STRIP_JPEG_QUALITY, g_tmp, STRIP_MAX);
                xSemaphoreTake(g_mtx, portMAX_DELAY);
                if (n) memcpy(g_strip[i], g_tmp, n);
                g_ds.jpgLen[i] = (uint16_t)n; // 0 = could not encode; viewers skip it
                g_ds.jpgSeq[i] = g_ds.bandSeq[i];
                xSemaphoreGive(g_mtx);
            }
        }

        // Whole-picture JPEG for browsers.
        if (recent(g_fullWantedAt, 4000) && g_fullSeq != g_ds.seq && g_ds.seq != 0) {
            const size_t n = encodeJpg(g_refRgb, OUT_W, OUT_H, FULL_JPEG_QUALITY, g_tmp, FULL_JPG_MAX);
            xSemaphoreTake(g_mtx, portMAX_DELAY);
            if (n) {
                memcpy(g_fullJpg, g_tmp, n);
                g_fullLen = n;
            }
            g_fullSeq = g_ds.seq;
            xSemaphoreGive(g_mtx);
        }

        winFrames++;
        const uint32_t now = millis();
        if (now - winStart >= 2000) {
            g_fps = winFrames * 1000.0f / (now - winStart);
            winFrames = 0;
            winStart = now;
        }
        vTaskDelay(1); // let idle task / wifi breathe
    }
}

// ---------------------------------------------------------------------------
// Send a buffer, then close the connection. Bruce opens a fresh connection per
// request and reads until Content-Length, so an explicit close avoids any
// keep-alive confusion on either side.
static esp_err_t sendAndClose(httpd_req_t *req, const char *type, const uint8_t *buf, size_t len) {
    httpd_resp_set_type(req, type);
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_set_hdr(req, "Connection", "close");
    esp_err_t r = httpd_resp_send(req, (const char *)buf, len); // sets Content-Length
    httpd_sess_trigger_close(req->handle, httpd_req_to_sockfd(req));
    return r;
}

static esp_err_t deltaHandler(httpd_req_t *req) {
    uint32_t since = 0;
    bool jpg = false;
    char q[64];
    if (httpd_req_get_url_query_str(req, q, sizeof(q)) == ESP_OK) {
        char v[16];
        if (httpd_query_key_value(q, "s", v, sizeof(v)) == ESP_OK) since = (uint32_t)strtoul(v, nullptr, 10);
        if (httpd_query_key_value(q, "f", v, sizeof(v)) == ESP_OK) jpg = (v[0] == 'j');
    }
    const uint32_t t0 = millis();
    if (jpg) g_stripWantedAt = t0 | 1;

    size_t total = 0;
    for (;;) {
        xSemaphoreTake(g_mtx, portMAX_DELAY);
        uint32_t seq = 0;
        bool waiting = false;
        const uint32_t mask = deltaPlan(g_ds, since, jpg, NBANDS, &seq, &waiting);
        const uint32_t waited = millis() - t0;
        bool send;
        if (waiting) send = waited >= STRIP_WAIT_MS; // strips still being encoded
        else if (mask) send = true;                  // something to show
        else send = waited >= LONGPOLL_MS;           // nothing yet: hold the request open
        if (send) {
            total = deltaBuild(g_resp, RESP_MAX, g_ds, mask, seq, jpg, NBANDS, BAND_H, OUT_W, OUT_H, g_raw,
                               (const uint8_t *const *)g_strip);
        }
        xSemaphoreGive(g_mtx);
        if (send) break;
        vTaskDelay(pdMS_TO_TICKS(3));
    }
    if (!total) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "response too large");
        return ESP_FAIL;
    }
    return sendAndClose(req, "application/octet-stream", g_resp, total);
}

// Whole-picture JPEG, copied out so a slow client never stalls capture.
static bool grabFull(uint8_t **buf, size_t *len, uint32_t waitMs) {
    g_fullWantedAt = millis() | 1;
    const uint32_t t0 = millis();
    for (;;) {
        bool ready = false;
        xSemaphoreTake(g_mtx, portMAX_DELAY);
        if (g_fullLen && g_fullSeq == g_ds.seq) {
            *buf = (uint8_t *)malloc(g_fullLen);
            if (*buf) {
                memcpy(*buf, g_fullJpg, g_fullLen);
                *len = g_fullLen;
            }
            ready = true;
        }
        xSemaphoreGive(g_mtx);
        if (ready) return *buf != nullptr;
        if (millis() - t0 >= waitMs) return false;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

static esp_err_t jpgHandler(httpd_req_t *req) {
    uint8_t *buf = nullptr;
    size_t len = 0;
    if (!grabFull(&buf, &len, 800)) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "no frame yet");
        return ESP_FAIL;
    }
    esp_err_t r = sendAndClose(req, "image/jpeg", buf, len);
    free(buf);
    return r;
}

static esp_err_t statusHandler(httpd_req_t *req) {
    char json[240];
    xSemaphoreTake(g_mtx, portMAX_DELAY);
    const uint32_t seq = g_ds.seq;
    xSemaphoreGive(g_mtx);
    snprintf(json, sizeof(json),
             "{\"fps\":%.1f,\"seq\":%lu,\"updates\":%lu,\"w\":%d,\"h\":%d,\"bands\":%d,\"band_h\":%d,"
             "\"free_heap\":%u,\"free_psram\":%u}",
             (double)g_fps, (unsigned long)seq, (unsigned long)g_updates, OUT_W, OUT_H, NBANDS, BAND_H,
             (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getFreePsram());
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, json, HTTPD_RESP_USE_STRLEN);
}

static const char INDEX_HTML[] =
    "<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>mini-cctv</title><body style='margin:0;background:#000;color:#9f9;font:14px monospace'>"
    "<img id=v style='width:100%;image-rendering:pixelated;display:block'>"
    "<p style='padding:0 8px'><a style='color:#9f9' href=/status>status</a> | <a style='color:#9f9' href=/jpg>jpg</a></p>"
    "<script>v.src='http://'+location.hostname+':81/stream'</script>";

static esp_err_t indexHandler(httpd_req_t *req) {
    httpd_resp_set_type(req, "text/html");
    return httpd_resp_send(req, INDEX_HTML, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t streamHandler(httpd_req_t *req) {
    static const char *BOUNDARY = "\r\n--frame\r\n";
    esp_err_t r = httpd_resp_set_type(req, "multipart/x-mixed-replace;boundary=frame");
    if (r != ESP_OK) return r;
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    uint32_t lastSeq = 0;
    for (;;) {
        g_fullWantedAt = millis() | 1;
        xSemaphoreTake(g_mtx, portMAX_DELAY);
        const bool fresh = g_fullLen && g_fullSeq == g_ds.seq && g_fullSeq != lastSeq;
        const uint32_t seq = g_fullSeq;
        uint8_t *buf = nullptr;
        size_t len = 0;
        if (fresh && (buf = (uint8_t *)malloc(g_fullLen))) {
            memcpy(buf, g_fullJpg, g_fullLen);
            len = g_fullLen;
        }
        xSemaphoreGive(g_mtx);
        if (!buf) {
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        lastSeq = seq;
        char hdr[80];
        int hl = snprintf(hdr, sizeof(hdr), "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", (unsigned)len);
        r = httpd_resp_send_chunk(req, BOUNDARY, strlen(BOUNDARY));
        if (r == ESP_OK) r = httpd_resp_send_chunk(req, hdr, hl);
        if (r == ESP_OK) r = httpd_resp_send_chunk(req, (const char *)buf, len);
        free(buf);
        if (r != ESP_OK) break; // client went away
    }
    return r;
}

static void startServers() {
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.lru_purge_enable = true; // Bruce opens a fresh connection per request
    cfg.max_open_sockets = 4;
    cfg.stack_size = 6144;
    cfg.server_port = 80;

    httpd_uri_t d = {"/d", HTTP_GET, deltaHandler, nullptr};
    httpd_uri_t jpg = {"/jpg", HTTP_GET, jpgHandler, nullptr};
    httpd_uri_t status = {"/status", HTTP_GET, statusHandler, nullptr};
    httpd_uri_t index = {"/", HTTP_GET, indexHandler, nullptr};
    if (httpd_start(&g_httpd, &cfg) == ESP_OK) {
        httpd_register_uri_handler(g_httpd, &d);
        httpd_register_uri_handler(g_httpd, &jpg);
        httpd_register_uri_handler(g_httpd, &status);
        httpd_register_uri_handler(g_httpd, &index);
    }

    cfg.server_port = 81;
    cfg.ctrl_port += 1;
    cfg.max_open_sockets = 2;
    httpd_uri_t stream = {"/stream", HTTP_GET, streamHandler, nullptr};
    if (httpd_start(&g_stream, &cfg) == ESP_OK) httpd_register_uri_handler(g_stream, &stream);
}

static void startWifi() {
#if USE_STA
    WiFi.mode(WIFI_STA);
    WiFi.begin(STA_SSID, STA_PASS);
    Serial.print("joining " STA_SSID);
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print('.');
    }
    Serial.printf("\nviewer: http://%s/   Bruce app host: http://%s\n", WiFi.localIP().toString().c_str(),
                  WiFi.localIP().toString().c_str());
#else
    WiFi.mode(WIFI_AP);
    WiFi.softAP(CCTV_AP_SSID, CCTV_AP_PASS, CCTV_AP_CHANNEL, 0, 2);
    Serial.printf("AP \"%s\" up. viewer: http://%s/\n", CCTV_AP_SSID, WiFi.softAPIP().toString().c_str());
#endif
    WiFi.setSleep(false);
    WiFi.setTxPower(WIFI_POWER_19_5dBm);
}

static uint8_t *psramAlloc(size_t n) { return (uint8_t *)heap_caps_calloc(1, n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT); }

void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println("\nmini-cctv camera node");

    if (!psramFound()) {
        Serial.println("PSRAM not found: Arduino IDE > Tools > PSRAM = \"OPI PSRAM\" (PlatformIO: qio_opi vs qio_qspi env)");
        for (;;) delay(1000);
    }

    bool ok = true;
    g_refRgb = psramAlloc(RGB_LEN);
    g_newRgb = psramAlloc(RGB_LEN);
    g_raw = psramAlloc(RAW_LEN);
    g_rawNew = psramAlloc(RAW_LEN);
    g_fullJpg = psramAlloc(FULL_JPG_MAX);
    g_tmp = psramAlloc(FULL_JPG_MAX);
    g_resp = psramAlloc(RESP_MAX);
    ok = g_refRgb && g_newRgb && g_raw && g_rawNew && g_fullJpg && g_tmp && g_resp;
    for (int i = 0; i < NBANDS; i++) {
        g_strip[i] = psramAlloc(STRIP_MAX);
        ok = ok && g_strip[i];
    }
    g_mtx = xSemaphoreCreateMutex();
    memset(&g_ds, 0, sizeof(g_ds));

    if (!ok || !g_mtx || !initCamera()) {
        Serial.println("init failed, rebooting in 5s");
        delay(5000);
        ESP.restart();
    }
    startWifi();
    startServers();
    // the JPEG encoder keeps big state on the stack, so give the task plenty
    xTaskCreatePinnedToCore(captureTask, "capture", 24576, nullptr, 2, nullptr, 1);
    Serial.println("streaming");
}

void loop() {
    delay(5000);
    Serial.printf("fps=%.1f seq=%lu updates=%lu heap=%u psram=%u\n", (double)g_fps, (unsigned long)g_ds.seq,
                  (unsigned long)g_updates, (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getFreePsram());
}
