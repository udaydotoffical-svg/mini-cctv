// MiniCCTV - live camera viewer for Bruce (M5StickC Plus2 and friends)
//
// Pulls single JPEG frames from the ESP32-S3 camera node (firmware/ in this
// repo) over WiFi and paints them with display.drawJpg().
//
// Copy to /BruceJS/MiniCCTV.js on the SD card (or upload via the Bruce WebUI),
// then run it from  JS Interpreter -> MiniCCTV.js
//
// Controls:  SEL = toggle the status bar     ESC (or SEL+NEXT, see Bruce) = quit
//
// Written in plain ES5 (var / function) because Bruce runs mquickjs.

var display = require('display');
var keyboard = require('keyboard');
var wifi = require('wifi');

// ------------------------------- config ------------------------------------
var CAM_SSID = 'ESP32-CAM-S3'; // must match CCTV_AP_SSID in firmware/include/config.h
var CAM_PASS = '12345678'; // must match CCTV_AP_PASS
var CAM_URL = 'http://192.168.4.1/jpg';
var JOIN_CAM_WIFI = true; // false = Stick is already on the same network as the camera
var FRAME_W = 240; // must match OUT_W / OUT_H in firmware/include/config.h
var FRAME_H = 128;
var MAX_FAILS = 5; // consecutive bad frames before we reconnect
// ----------------------------------------------------------------------------

var W = display.width();
var H = display.height();
var OFFSET_X = Math.floor((W - FRAME_W) / 2);
var BAR_Y = FRAME_H;
var BAR_H = H - FRAME_H;

var hud = true;

function message(line1, line2) {
  display.fill(0);
  display.setTextSize(1);
  display.setTextColor(display.color(255, 255, 255));
  display.drawString(line1, 6, Math.floor(H / 2) - 12);
  if (line2) {
    display.drawString(line2, 6, Math.floor(H / 2) + 4);
  }
}

function onCamNetwork() {
  if (!wifi.connected()) {
    return false;
  }
  var ip = wifi.getIPAddress();
  return ip !== null && ip.indexOf('192.168.4.') === 0;
}

function joinCam() {
  if (!JOIN_CAM_WIFI) {
    if (wifi.connected()) {
      return true;
    }
    message('WiFi not connected', 'opening WiFi menu...');
    return wifi.connectDialog();
  }
  if (onCamNetwork()) {
    return true;
  }
  message('Joining ' + CAM_SSID + ' ...');
  return wifi.connect(CAM_SSID, 15, CAM_PASS);
}

function fetchFrame() {
  var res;
  try {
    res = wifi.httpFetch(CAM_URL, { responseType: 'binary' });
  } catch (e) {
    return null;
  }
  if (!res || res.status !== 200 || !res.body) {
    return null;
  }
  var b = res.body;
  // must be a complete JPEG (SOI marker, and as many bytes as Content-Length said)
  if (b.length < 200 || b[0] !== 0xff || b[1] !== 0xd8 || b.length !== res.length) {
    return null;
  }
  return b;
}

function drawBar(fps, bytes, fails) {
  if (BAR_H <= 0) {
    return;
  }
  display.drawFillRect(0, BAR_Y, W, BAR_H, display.color(0, 0, 0));
  if (!hud) {
    return;
  }
  display.setTextSize(1);
  display.setTextColor(display.color(120, 255, 120));
  var txt = fps + ' fps  ' + Math.floor(bytes / 102.4) / 10 + ' KB';
  if (fails > 0) {
    display.setTextColor(display.color(255, 160, 0));
    txt = 'dropped ' + fails + '  ' + txt;
  }
  display.drawString(txt, 4, BAR_Y);
}

function run() {
  if (W < FRAME_W) {
    message('Screen too narrow', 'use landscape rotation');
    delay(3000);
    return;
  }
  if (!joinCam()) {
    message('Could not join WiFi', 'check SSID/pass, power the cam');
    delay(3000);
    return;
  }

  display.fill(0);
  message('Connected', 'waiting for first frame...');

  var frames = 0;
  var fps = 0;
  var fails = 0;
  var lastBytes = 0;
  var winStart = now();
  var winFrames = 0;
  var sinceGc = 0;

  while (true) {
    if (keyboard.getEscPress()) {
      break;
    }
    if (keyboard.getSelPress()) {
      hud = !hud;
      drawBar(fps, lastBytes, fails);
    }

    var jpg = fetchFrame();
    if (jpg) {
      display.drawJpg(jpg, OFFSET_X, 0, false);
      lastBytes = jpg.length;
      fails = 0;
      frames++;
      winFrames++;
      if (frames === 1) {
        drawBar(fps, lastBytes, fails);
      }
    } else {
      fails++;
      if (fails >= MAX_FAILS) {
        message('No signal', 'reconnecting...');
        wifi.disconnect();
        delay(500);
        if (!joinCam()) {
          delay(1500);
        }
        fails = 0;
        display.fill(0);
      } else {
        delay(150);
      }
    }

    var t = now();
    if (t - winStart >= 1000) {
      fps = Math.floor((winFrames * 10000) / (t - winStart)) / 10;
      winFrames = 0;
      winStart = t;
      drawBar(fps, lastBytes, fails);
    }

    sinceGc++;
    if (sinceGc >= 40) {
      gc();
      sinceGc = 0;
    }
    delay(1);
  }
  display.fill(0);
}

run();
