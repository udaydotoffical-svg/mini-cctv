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

//
// Pipeline (runs continuously in captureTask):
//   OV sensor -> RGB565 QVGA (320x240) -> crop + downscale to OUT_W x OUT_H
//             -> software JPEG encode (baseline) -> latest-frame slot
//
// HTTP (port 80):  /jpg     one JPEG, Content-Length set (what Bruce's httpFetch wants)
//                  /status  JSON stats
//                  /        tiny viewer page (phone / laptop)
// HTTP (port 81):  /stream  MJPEG for browsers / VLC
//
// The frame is rendered on the Stick by display.drawJpg(), which only handles
// baseline JPEGs that fit the panel; that is why we scale + re-encode here
// instead of sending raw sensor JPEGs.

#include <Arduino.h>
#include <WiFi.h>
#include "esp_camera.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "img_converters.h"

#include "camera_pins.h"
#include "config.h"

static SemaphoreHandle_t g_mtx;
static uint8_t *g_jpg = nullptr; // latest encoded frame (malloc'd)
static size_t g_len = 0;
static uint32_t g_seq = 0;
static float g_fps = 0;

static uint16_t *g_scaled = nullptr; // OUT_W*OUT_H RGB565 scratch (PSRAM)

static httpd_handle_t g_httpd = nullptr;
static httpd_handle_t g_stream = nullptr;

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
    c.frame_size = FRAMESIZE_QVGA;     // 320x240
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

// Centre-crop the camera frame to the OUT_W:OUT_H aspect, nearest-neighbour scale.
static void scaleToOut(const camera_fb_t *fb) {
    const uint16_t *src = (const uint16_t *)fb->buf;
    const int sw = fb->width, sh = fb->height;
    int ch = (sw * OUT_H) / OUT_W;
    if (ch > sh) ch = sh;
    const int y0 = (sh - ch) / 2;
    for (int y = 0; y < OUT_H; y++) {
        const uint16_t *row = src + (size_t)(y0 + (y * ch) / OUT_H) * sw;
        uint16_t *dst = g_scaled + (size_t)y * OUT_W;
        for (int x = 0; x < OUT_W; x++) dst[x] = row[(x * sw) / OUT_W];
    }
}

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
        scaleToOut(fb);
        esp_camera_fb_return(fb);

        uint8_t *out = nullptr;
        size_t outLen = 0;
        if (!fmt2jpg((uint8_t *)g_scaled, (size_t)OUT_W * OUT_H * 2, OUT_W, OUT_H, PIXFORMAT_RGB565,
                     JPEG_QUALITY, &out, &outLen) ||
            !out) {
            Serial.println("jpeg encode failed");
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }

        xSemaphoreTake(g_mtx, portMAX_DELAY);
        free(g_jpg);
        g_jpg = out;
        g_len = outLen;
        g_seq++;
        xSemaphoreGive(g_mtx);

        winFrames++;
        uint32_t now = millis();
        if (now - winStart >= 2000) {
            g_fps = winFrames * 1000.0f / (now - winStart);
            winFrames = 0;
            winStart = now;
        }
        vTaskDelay(1); // let idle task / wifi breathe
    }
}

// Copy the latest frame out so a slow client never stalls the capture task.
static bool grabFrame(uint8_t **buf, size_t *len, uint32_t *seq) {
    bool ok = false;
    xSemaphoreTake(g_mtx, portMAX_DELAY);
    if (g_jpg && g_len) {
        *buf = (uint8_t *)malloc(g_len);
        if (*buf) {
            memcpy(*buf, g_jpg, g_len);
            *len = g_len;
            *seq = g_seq;
            ok = true;
        }
    }
    xSemaphoreGive(g_mtx);
    return ok;
}

// ---------------------------------------------------------------------------
static esp_err_t jpgHandler(httpd_req_t *req) {
    uint8_t *buf = nullptr;
    size_t len = 0;
    uint32_t seq = 0;
    if (!grabFrame(&buf, &len, &seq)) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "no frame yet");
        return ESP_FAIL;
    }
    char seqStr[16];
    snprintf(seqStr, sizeof(seqStr), "%lu", (unsigned long)seq);
    httpd_resp_set_type(req, "image/jpeg");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_set_hdr(req, "X-Frame-Seq", seqStr);
    esp_err_t r = httpd_resp_send(req, (const char *)buf, len); // sets Content-Length
    free(buf);
    return r;
}

static esp_err_t statusHandler(httpd_req_t *req) {
    char json[200];
    snprintf(json, sizeof(json),
             "{\"fps\":%.1f,\"seq\":%lu,\"jpeg_bytes\":%u,\"w\":%d,\"h\":%d,\"free_heap\":%u,\"free_psram\":%u,"
             "\"clients\":%d}",
             g_fps, (unsigned long)g_seq, (unsigned)g_len, OUT_W, OUT_H, (unsigned)ESP.getFreeHeap(),
             (unsigned)ESP.getFreePsram(), WiFi.getMode() == WIFI_AP ? WiFi.softAPgetStationNum() : 1);
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
    uint32_t last = 0;
    for (;;) {
        uint8_t *buf = nullptr;
        size_t len = 0;
        uint32_t seq = 0;
        if (!grabFrame(&buf, &len, &seq) || seq == last) {
            free(buf);
            vTaskDelay(pdMS_TO_TICKS(15));
            continue;
        }
        last = seq;
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
    cfg.lru_purge_enable = true; // Bruce opens a fresh connection per frame
    cfg.max_open_sockets = 4;
    cfg.stack_size = 6144;
    cfg.server_port = 80;

    httpd_uri_t jpg = {"/jpg", HTTP_GET, jpgHandler, nullptr};
    httpd_uri_t status = {"/status", HTTP_GET, statusHandler, nullptr};
    httpd_uri_t index = {"/", HTTP_GET, indexHandler, nullptr};
    if (httpd_start(&g_httpd, &cfg) == ESP_OK) {
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
    Serial.printf("\nviewer: http://%s/   frame: http://%s/jpg\n", WiFi.localIP().toString().c_str(),
                  WiFi.localIP().toString().c_str());
#else
    WiFi.mode(WIFI_AP);
    WiFi.softAP(CCTV_AP_SSID, CCTV_AP_PASS, CCTV_AP_CHANNEL, 0, 2);
    Serial.printf("AP \"%s\" up. viewer: http://%s/   frame: http://%s/jpg\n", CCTV_AP_SSID,
                  WiFi.softAPIP().toString().c_str(), WiFi.softAPIP().toString().c_str());
#endif
    WiFi.setSleep(false);
    WiFi.setTxPower(WIFI_POWER_19_5dBm);
}

void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println("\nmini-cctv camera node");

    if (!psramFound()) {
        Serial.println("PSRAM not found: Arduino IDE > Tools > PSRAM = \"OPI PSRAM\" (PlatformIO: qio_opi vs qio_qspi env)");
        for (;;) delay(1000);
    }
    g_scaled = (uint16_t *)heap_caps_malloc((size_t)OUT_W * OUT_H * 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    g_mtx = xSemaphoreCreateMutex();
    if (!g_scaled || !g_mtx || !initCamera()) {
        Serial.println("init failed, rebooting in 5s");
        delay(5000);
        ESP.restart();
    }
    startWifi();
    startServers();
    // fmt2jpg's encoder keeps big state on the stack, so give the task plenty
    xTaskCreatePinnedToCore(captureTask, "capture", 16384, nullptr, 2, nullptr, 1);
    Serial.println("streaming");
}

void loop() {
    delay(5000);
    Serial.printf("fps=%.1f seq=%lu jpeg=%uB heap=%u psram=%u\n", g_fps, (unsigned long)g_seq, (unsigned)g_len,
                  (unsigned)ESP.getFreeHeap(), (unsigned)ESP.getFreePsram());
}
