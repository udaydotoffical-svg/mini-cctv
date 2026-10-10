// MiniCCTV - live camera viewer for Bruce (M5StickC Plus2 and friends)
//
// Talks to the ESP32-S3 camera node (firmware/mini_cctv in this repo) over WiFi.
// The camera only sends the horizontal bands of the picture that changed, so a
// quiet scene is nearly free and a busy one still moves at full speed.
//
// Install: copy to /BruceJS/MiniCCTV.js on the SD card (or upload it with the
// Bruce WebUI), then run it from  JS Interpreter -> MiniCCTV.js
//
// Buttons (M5StickC Plus2: the two side buttons are UP / DOWN, the front one is M5)
//   Menu:    UP / DOWN move      M5 select
//   Viewer:  UP  back to menu    M5 show/hide info    DOWN  Photo <-> Fast
//   Anywhere: UP + DOWN together quit the app
//
// Modes
//   Photo  16-bit colour (small JPEG strips). Best picture; moving areas blink briefly,
//          because Bruce's drawJpg clears the area it paints.
//   Fast   8-bit dithered colour. Never blinks and costs no decoding.
//
// Written in plain ES5 (var / function) because Bruce runs mquickjs.

var display = require('display');
var keyboard = require('keyboard');
var wifi = require('wifi');

// ------------------------------- config ------------------------------------
var CAM_SSID = 'ESP32-CAM-S3'; // must match CCTV_AP_SSID in firmware/mini_cctv/config.h
var CAM_PASS = '12345678'; // must match CCTV_AP_PASS
var CAM_HOST = 'http://192.168.4.1';
var JOIN_CAM_WIFI = true; // false = the Stick is already on the same network as the camera
var FRAME_W = 240; // must match OUT_W / OUT_H in config.h
var FRAME_H = 135;
var BAND_H = 16; // must match BAND_H in mini_cctv.ino
var MAX_FAILS = 4; // consecutive bad replies before we show "No signal" and reconnect
// ----------------------------------------------------------------------------

var W = display.width();
var H = display.height();
var OX = Math.max(0, Math.floor((W - FRAME_W) / 2));
var OY = Math.max(0, Math.floor((H - FRAME_H) / 2));
var NBANDS = Math.floor((FRAME_H + BAND_H - 1) / BAND_H);
var LAST_ROWS = FRAME_H - (NBANDS - 1) * BAND_H;

// Reused for every raw band (drawBitmap needs an exact-size array), so no
// per-frame allocation. mquickjs' drawBitmap/drawJpg ignore the offset of a
// subarray view, which is why bands are copied out instead of drawn in place.
var bandBuf = new Uint8Array(FRAME_W * BAND_H);
var lastBuf = LAST_ROWS === BAND_H ? bandBuf : new Uint8Array(FRAME_W * LAST_ROWS);

var C = {
  bg: display.color(8, 12, 20),
  panel: display.color(20, 28, 44),
  accent: display.color(0, 200, 120),
  text: display.color(235, 240, 245),
  dim: display.color(120, 135, 155),
  warn: display.color(255, 170, 0)
};

var photo = true; // true = Photo (JPEG strips), false = Fast (8-bit)
var hud = true;
var since = 0; // last picture update we have fully drawn
var lastErr = '';

// ------------------------------- input -------------------------------------
function readKey() {
  if (keyboard.getEscPress()) {
    return 'esc';
  }
  if (keyboard.getSelPress()) {
    return 'sel';
  }
  if (keyboard.getPrevPress()) {
    return 'prev';
  }
  if (keyboard.getNextPress()) {
    return 'next';
  }
  return '';
}

function waitKey() {
  var k = '';
  while (k === '') {
    k = readKey();
    delay(30);
  }
  return k;
}

// ------------------------------- drawing -----------------------------------
function header(title) {
  display.drawFillRect(0, 0, W, 26, C.panel);
  display.drawFillRect(0, 26, W, 2, C.accent);
  display.setTextSize(2);
  display.setTextColor(C.accent, C.panel);
  display.drawString(title, 8, 5);
}

function footer(text) {
  display.drawFillRect(0, H - 14, W, 14, C.panel);
  display.setTextSize(1);
  display.setTextColor(C.dim, C.panel);
  display.drawString(text, 6, H - 11);
}

function msgScreen(title, lines, hint) {
  display.fill(C.bg);
  header(title);
  display.setTextSize(1);
  display.setTextColor(C.text, C.bg);
  for (var i = 0; i < lines.length; i++) {
    display.drawString(lines[i], 8, 38 + i * 13);
  }
  if (hint) {
    footer(hint);
  }
}

function pad(s, n) {
  while (s.length < n) {
    s += ' ';
  }
  return s;
}

function menuLabels() {
  return ['Watch live', 'Mode: ' + (photo ? 'Photo' : 'Fast'), 'Exit'];
}

function drawMenu(sel) {
  display.fill(C.bg);
  header('MiniCCTV');
  var labels = menuLabels();
  display.setTextSize(2);
  for (var i = 0; i < labels.length; i++) {
    var y = 36 + i * 27;
    if (i === sel) {
      display.drawFillRoundRect(6, y, W - 12, 24, 5, C.accent);
      display.setTextColor(C.bg, C.accent);
    } else {
      display.setTextColor(C.text, C.bg);
    }
    display.drawString((i === sel ? '> ' : '  ') + labels[i], 14, y + 4);
  }
  if (sel === 1) {
    footer(photo ? 'Photo: full colour, moving areas blink' : 'Fast: 256 colours, never blinks');
  } else {
    footer('UP/DOWN move    M5 select');
  }
}

// ------------------------------- network -----------------------------------
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
    return wifi.connectDialog();
  }
  if (onCamNetwork()) {
    return true;
  }
  return wifi.connect(CAM_SSID, 15, CAM_PASS);
}

// Returns the camera's /status object, or null if it doesn't answer.
function probe() {
  for (var i = 0; i < 3; i++) {
    try {
      var r = wifi.httpFetch(CAM_HOST + '/status', { responseType: 'json' });
      if (r && r.status === 200 && r.body) {
        return r.body;
      }
    } catch (e) {
      lastErr = '' + e;
    }
    delay(300);
  }
  return null;
}

// One round trip: "what changed since `since`?" Returns the reply bytes or null.
function fetchBands() {
  var res;
  try {
    res = wifi.httpFetch(CAM_HOST + '/d?f=' + (photo ? 'j' : '8') + '&s=' + since, { responseType: 'binary' });
  } catch (e) {
    lastErr = 'net ' + e;
    return null;
  }
  if (!res) {
    lastErr = 'no reply';
    return null;
  }
  if (res.status !== 200) {
    lastErr = 'http ' + res.status;
    return null;
  }
  var b = res.body;
  if (!b || b.length < 6 || b.length !== res.length) {
    lastErr = 'short ' + (b ? b.length : 0) + '/' + res.length;
    return null;
  }
  lastErr = '';
  return b;
}

// Reply layout (see firmware/mini_cctv/delta.h): u16 mask, u32 seq, then for each
// set bit: u16 len + payload. Draws the bands and advances `since`.
// Returns the number of bands drawn, or -1 if the reply is malformed.
function applyBands(b) {
  var mask = b[0] | (b[1] << 8);
  var seq = b[2] + b[3] * 256 + b[4] * 65536 + b[5] * 16777216;
  var i;
  var off = 6;

  // pass 1: check the whole reply before touching the screen
  for (i = 0; i < NBANDS; i++) {
    if (!(mask & (1 << i))) {
      continue;
    }
    if (off + 2 > b.length) {
      return -1;
    }
    var len = b[off] | (b[off + 1] << 8);
    off += 2;
    var rows = i === NBANDS - 1 ? LAST_ROWS : BAND_H;
    if (off + len > b.length || (!photo && len !== FRAME_W * rows)) {
      return -1;
    }
    off += len;
  }

  // pass 2: draw
  off = 6;
  var drawn = 0;
  for (i = 0; i < NBANDS; i++) {
    if (!(mask & (1 << i))) {
      continue;
    }
    var n = b[off] | (b[off + 1] << 8);
    off += 2;
    var y = OY + i * BAND_H;
    if (photo) {
      if (n > 0) {
        var jp = new Uint8Array(n);
        jp.set(b.subarray(off, off + n), 0);
        display.drawJpg(jp, OX, y, false);
      }
    } else {
      var buf = i === NBANDS - 1 ? lastBuf : bandBuf;
      buf.set(b.subarray(off, off + n), 0);
      display.drawBitmap(OX, y, buf, FRAME_W, i === NBANDS - 1 ? LAST_ROWS : BAND_H, 8);
    }
    off += n;
    drawn++;
  }

  // a camera that restarted counts from 1 again: start over from a full picture
  since = seq < since ? 0 : seq;
  return drawn;
}

// ------------------------------- viewer ------------------------------------
function drawHud(fps, netMs, drawMs) {
  var s;
  if (lastErr !== '') {
    display.setTextColor(C.warn, 0);
    s = lastErr;
  } else {
    display.setTextColor(C.accent, 0);
    s = (photo ? 'PHOTO ' : 'FAST ') + (fps > 0 ? fps + ' fps' : 'still') + '  net ' + netMs + ' draw ' + drawMs;
  }
  display.setTextSize(1);
  display.drawString(pad(s, 40), 2, 2);
}

function drawHint() {
  display.setTextSize(1);
  display.setTextColor(C.text, 0);
  display.drawString('UP menu   M5 info   DOWN mode', 2, H - 10);
}

function noSignal(outages) {
  display.drawFillRoundRect(30, 48, W - 60, 40, 6, C.panel);
  display.setTextSize(2);
  display.setTextColor(C.warn, C.panel);
  display.drawString('No signal', 54, 58);
  if (outages >= 2) {
    wifi.disconnect(); // stale association: start clean
    delay(300);
  }
  joinCam();
}

// Returns 'menu' (back to the menu) or 'quit'.
function watch() {
  display.fill(0);
  since = 0;
  var fails = 0;
  var outages = 0;
  var fps = 0;
  var winStart = now();
  var winUpd = 0;
  var netMs = 0;
  var drawMs = 0;
  var hintUntil = now() + 3500;
  var sinceGc = 0;

  while (true) {
    var k = readKey();
    if (k === 'esc') {
      return 'quit';
    }
    if (k === 'prev') {
      return 'menu';
    }
    if (k === 'sel') {
      hud = !hud;
      since = 0; // repaint whatever the info line covered
    }
    if (k === 'next') {
      photo = !photo;
      since = 0;
      display.fill(0);
    }

    var t0 = now();
    var reply = fetchBands();
    var t1 = now();
    var drawn = 0;
    if (reply) {
      drawn = applyBands(reply);
      if (drawn < 0) {
        lastErr = 'bad reply';
        fails++;
      } else {
        fails = 0;
        outages = 0;
        if (drawn > 0) {
          winUpd++;
          netMs = t1 - t0;
          drawMs = now() - t1;
        }
      }
    } else {
      fails++;
    }

    if (fails >= MAX_FAILS) {
      outages++;
      noSignal(outages);
      fails = 0;
      since = 0;
      display.fill(0);
    } else if (!reply) {
      delay(100);
    }

    var t = now();
    if (t - winStart >= 1000) {
      fps = Math.floor((winUpd * 10000) / (t - winStart)) / 10;
      winUpd = 0;
      winStart = t;
    }
    if (hud) {
      drawHud(fps, netMs, drawMs);
    }
    if (hintUntil > 0) {
      if (t < hintUntil) {
        drawHint();
      } else {
        hintUntil = 0;
        since = 0; // repaint under the hint
      }
    }

    sinceGc++;
    if (sinceGc >= 20) {
      gc();
      sinceGc = 0;
    }
  }
}

// Returns 'menu' or 'quit'. Shows why when the camera can't be reached.
function enterCctv() {
  if (W < FRAME_W) {
    msgScreen('Landscape only', ['This needs a screen 240 px wide.', 'Rotate Bruce to landscape.'], 'UP back');
    waitKey();
    return 'menu';
  }
  while (true) {
    msgScreen('Connecting', ['Joining ' + CAM_SSID + ' ...', 'a few seconds'], 'UP+DOWN quit');
    var why = '';
    var st = null;
    if (!joinCam()) {
      why = 'wifi';
    } else {
      st = probe();
      if (!st) {
        why = 'cam';
      } else if (st.w !== FRAME_W || st.h !== FRAME_H) {
        why = 'size';
      }
    }
    if (why === '') {
      return watch();
    }
    var lines;
    if (why === 'wifi') {
      lines = ["Couldn't join " + CAM_SSID, 'Is the camera powered on?', 'SSID / password correct?'];
    } else if (why === 'cam') {
      lines = ['Joined WiFi, camera silent', 'Is the sketch running?', 'Expected ' + CAM_HOST];
    } else {
      lines = ['Camera sends ' + st.w + 'x' + st.h, 'App expects ' + FRAME_W + 'x' + FRAME_H, 'Match OUT_W/OUT_H in config.h'];
    }
    msgScreen('Cannot connect', lines, 'M5 retry    UP back');
    var k = waitKey();
    if (k === 'esc') {
      return 'quit';
    }
    if (k === 'prev') {
      return 'menu';
    }
  }
}

// ------------------------------- app ---------------------------------------
function main() {
  var sel = 0;
  drawMenu(sel);
  while (true) {
    var k = readKey();
    if (k === 'esc') {
      break;
    }
    if (k === 'prev') {
      sel = (sel + 2) % 3;
      drawMenu(sel);
    } else if (k === 'next') {
      sel = (sel + 1) % 3;
      drawMenu(sel);
    } else if (k === 'sel') {
      if (sel === 0) {
        if (enterCctv() === 'quit') {
          break;
        }
        drawMenu(sel);
      } else if (sel === 1) {
        photo = !photo;
        drawMenu(sel);
      } else {
        break;
      }
    }
    delay(30);
  }
  display.fill(0);
}

main();
