// MiniCCTV - camera viewer and security console for Bruce (M5StickC Plus2 and friends)
//
// Talks to the ESP32-S3 camera node (firmware/mini_cctv in this repo) over WiFi.
// Install: copy to /BruceJS/MiniCCTV.js on the SD card (or upload it with the Bruce WebUI),
// then run it from  JS Interpreter -> MiniCCTV.js
//
// Buttons (M5StickC Plus2: the two side buttons are UP / DOWN, the front one is M5)
//   Menus:    UP / DOWN move    M5 select        UP + DOWN together: quit the app (or go back)
//   Viewer:   UP back to the menu    DOWN take a photo    M5 actions (record, zoom, rewind, ...)
//
// Camera modes (kept on the camera, so they keep working when the Stick is away):
//   Live        just the picture                    Guard       + motion alerts and rewind
//   Security    + a photo and a clip per event      Continuous  records all the time
//   Timelapse   a photo every N seconds
// Without an SD card everything still works except saving photos and clips; the app says so.
//
// Settings (main menu -> Settings): auto-record, the default picture mode (Fast / Photo), alerts and
// the info line are remembered. Auto-record, camera mode and the timelapse interval are stored on the
// camera; the rest in /MiniCCTV.cfg on the Stick.
//
// Look: the Knowura design language - dark ground, black ink outlines, hard offset shadows, cyan for
// active things, a deep-blue to blue gradient for the selected control, uppercase labels, pixel type.
//
// Written in plain ES5 (var / function): Bruce runs mquickjs, a strict ES5 subset.

var display = require('display');
var keyboard = require('keyboard');
var wifi = require('wifi');
var audio = require('audio');
var notification = require('notification');
var ir = require('ir');
var storage = require('storage');

// ------------------------------- config ------------------------------------
var CAM_SSID = 'ESP32-CAM-S3'; // must match CCTV_AP_SSID in firmware/mini_cctv/config.h
var CAM_PASS = '12345678'; // must match CCTV_AP_PASS
var CAM_HOST = 'http://192.168.4.1';
var JOIN_CAM_WIFI = true; // false = the Stick is already on the same network as the camera
var FRAME_W = 240; // must match OUT_W / OUT_H in config.h
var FRAME_H = 135;
var BAND_H = 16; // must match BAND_H in mini_cctv.ino
var MAX_FAILS = 4; // consecutive bad replies before "No signal" and a reconnect
var IR_FILE = ''; // e.g. '/BruceIR/lamp_on.ir': sent when motion is detected (turn a lamp on...)
var IR_GAP_MS = 60000; // ...at most this often
var GUARD_DIM = 2; // screen brightness (0..100) while guarding
var AUTO_RETURN_MS = 15000; // guard: back to the dark screen this long after motion stops
var CFG_FILE = { fs: 'littlefs', path: '/MiniCCTV.cfg' }; // the Stick's own settings
// ----------------------------------------------------------------------------

var APP_NAME = 'MiniCCTV';

// must match firmware/mini_cctv/modes.h and filters.h
var MODES = ['Live', 'Guard', 'Security', 'Continuous', 'Timelapse'];
var MODE_BLURB = [
  'Just the picture. Fastest.',
  'Motion alerts + rewind. Stores nothing.',
  'Alerts, photo + clip per event, rewind.',
  'Records all the time + alerts + rewind.',
  'A photo to the SD card every N seconds.'
];
var MODE_ALERTS = [false, true, true, true, false];
var MODE_NEEDS_SD = [false, false, true, true, true];
var FILTERS = ['Normal', 'Night', 'Grey', 'Thermal', 'Edge'];
var ALERT_NAMES = ['Off', 'LED only', 'Beep + LED'];
var ALERT_SHORT = ['Off', 'LED', 'Beep+LED'];
var FLIP_NAMES = ['None', 'Mirror', 'Flip', 'Both'];
var TL_STEPS = [10, 30, 60, 300, 900, 3600];

// flags in the camera's reply header (delta.h)
var DF_REC = 1;
var DF_SD = 2;
var DF_BIG = 4;
var DF_MOTION = 8;
var DF_OVR = 16;

var W = display.width();
var H = display.height();
var OX = Math.max(0, Math.floor((W - FRAME_W) / 2));
var OY = Math.max(0, Math.floor((H - FRAME_H) / 2));
var NBANDS = Math.floor((FRAME_H + BAND_H - 1) / BAND_H);
var LAST_ROWS = FRAME_H - (NBANDS - 1) * BAND_H;

// Reused for every raw band (drawBitmap needs an exact-size array), so no per-frame allocation.
// Bruce's drawBitmap/drawJpg ignore the offset of a subarray view, so bands are copied out.
var bandBuf = new Uint8Array(FRAME_W * BAND_H);
var lastBuf = LAST_ROWS === BAND_H ? bandBuf : new Uint8Array(FRAME_W * LAST_ROWS);

// Knowura dark theme. The ground is a touch lighter than the system's #05070f so the black shadows
// still read on the small panel.
var C = {
  ink: display.color(0, 0, 0),
  bg: display.color(6, 10, 22),
  grid: display.color(13, 21, 42),
  panel: display.color(13, 25, 54),
  code: display.color(0, 4, 10),
  text: display.color(234, 246, 255),
  dim: display.color(143, 166, 204),
  cyan: display.color(34, 229, 255),
  blue: display.color(47, 107, 255),
  deep: display.color(15, 42, 128),
  ok: display.color(25, 195, 125),
  bad: display.color(255, 77, 109)
};

var cam = { mode: 2, sd: 1, rec: 0, z: 10, px: 50, py: 50, f: 0, n: 0, fl: 1, mi: 0, br: 1, auto: 1, free: 0, hist: 0, tl: 60, ov: 0, ago: 0, play: 0, cpos: 0, clen: 0, name: '' };
var camSeen = false; // true once the camera has answered, so `cam` holds real values
var cfg = { photo: true, alerts: 2, hud: true }; // the Stick's saved defaults
var photo = true; // true = Photo (JPEG strips, 16-bit colour), false = Fast (8-bit, never blinks)
var hud = true;
var alertLevel = 2;
var since = 0; // last picture update we have fully drawn
var lastErr = '';
var hdrMotion = 0;
var hdrFlags = DF_SD;
var toastText = '';
var toastKind = '';
var toastUntil = 0;
var lastIrAt = 0;
var menuMseq = -1;
var badSize = '';
var recShown = 0; // which overlay chips are on the picture right now (so they get erased)
var noSdShown = 0;

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

function waitKey(timeoutMs) {
  var t0 = now();
  var k = '';
  while (k === '') {
    k = readKey();
    if (k === '' && timeoutMs > 0 && now() - t0 > timeoutMs) {
      return '';
    }
    delay(30);
  }
  return k;
}

// ------------------------------- saved settings ----------------------------
function loadCfg() {
  var raw = '';
  try {
    raw = storage.read(CFG_FILE);
  } catch (e) {
    return; // no file yet: keep the defaults
  }
  var o = null;
  try {
    o = JSON.parse(raw);
  } catch (e2) {
    return; // damaged file: ignore it
  }
  if (!o) {
    return;
  }
  if (o.photo === 0 || o.photo === 1) {
    cfg.photo = o.photo === 1;
  }
  if (o.alerts === 0 || o.alerts === 1 || o.alerts === 2) {
    cfg.alerts = o.alerts;
  }
  if (o.hud === 0 || o.hud === 1) {
    cfg.hud = o.hud === 1;
  }
}

function saveCfg() {
  try {
    storage.write(CFG_FILE, JSON.stringify({ v: 1, photo: cfg.photo ? 1 : 0, alerts: cfg.alerts, hud: cfg.hud ? 1 : 0 }), 'write');
  } catch (e) {
    lastErr = 'save ' + e;
  }
}

// ------------------------------- Knowura toolkit ---------------------------
function clip(s, n) {
  s = '' + s;
  return s.length > n ? s.substring(0, n) : s;
}

function pad(s, n) {
  while (s.length < n) {
    s += ' ';
  }
  return s;
}

function up(s) {
  return ('' + s).toUpperCase();
}

function mmss(sec) {
  var s = Math.floor(sec);
  var r = s % 60;
  return Math.floor(s / 60) + ':' + (r < 10 ? '0' : '') + r;
}

function textW(s, size) {
  return s.length * 6 * size;
}

function txt(s, x, y, size, color) {
  display.setTextSize(size);
  display.setTextColor(color);
  display.drawString(s, x, y);
}

function txtC(s, cx, y, size, color) {
  txt(s, cx - Math.floor(textW(s, size) / 2), y, size, color);
}

// Dark ground with the design system's faint grid.
function ground() {
  var i;
  display.fill(C.bg);
  for (i = 0; i < W; i += 15) {
    display.drawFastVLine(i, 0, H, C.grid);
  }
  for (i = 0; i < H; i += 15) {
    display.drawFastHLine(0, i, W, C.grid);
  }
}

// A control: hard black shadow (down-right, never blurred), black ink outline, flat fill.
function box(x, y, w, h, r, fill, shadow, edge) {
  var rr = Math.min(r, Math.floor(Math.min(w, h) / 2));
  if (shadow > 0) {
    display.drawFillRoundRect(x + shadow, y + shadow, w, h, rr, C.ink);
  }
  display.drawFillRoundRect(x, y, w, h, rr, C.ink);
  display.drawFillRoundRect(x + edge, y + edge, w - 2 * edge, h - 2 * edge, rr > edge ? rr - edge : 1, fill);
}

// The selected control: ink outline over the brand gradient (deep blue -> blue).
function gradBox(x, y, w, h, r, shadow, edge) {
  var ix = x + edge;
  var iy = y + edge;
  var iw = w - 2 * edge;
  var ih = h - 2 * edge;
  var cap = r > edge ? r - edge : 1;
  box(x, y, w, h, r, C.deep, shadow, edge);
  display.drawFillRectGradient(ix + cap, iy, iw - 2 * cap, ih, C.deep, C.blue, 'h');
  display.drawFillRoundRect(ix + iw - 2 * cap, iy, 2 * cap, ih, cap, C.blue);
}

function chip(x, y, text, fg, fill) {
  var w = textW(text, 1) + 10;
  box(x, y, w, 12, 5, fill, 0, 1);
  txt(text, x + 5, y + 2, 1, fg);
  return w;
}

function toggle(x, y, on) {
  box(x, y, 36, 14, 6, on ? C.cyan : C.code, 0, 1);
  if (on) {
    txt('ON', x + 6, y + 3, 1, C.code);
    display.drawFillCircle(x + 28, y + 7, 4, C.code);
  } else {
    display.drawFillCircle(x + 8, y + 7, 4, C.dim);
    txt('OFF', x + 15, y + 3, 1, C.dim);
  }
}

function keycap(x, y, k) {
  var w = textW(k, 1) + 8;
  box(x, y, w, 11, 4, C.panel, 1, 1);
  txt(k, x + 4, y + 2, 1, C.cyan);
  return w;
}

// pairs: [['UP', 'menu'], ['M5', 'select']] drawn as key caps with a dim caption each
function keys(pairs, y) {
  var x = 6;
  for (var i = 0; i < pairs.length; i++) {
    x += keycap(x, y, pairs[i][0]) + 4;
    var cap = up(pairs[i][1]);
    txt(cap, x, y + 2, 1, C.dim);
    x += textW(cap, 1) + 9;
  }
}

var NAV = [['UP/DN', 'move'], ['M5', 'pick'], ['UP+DN', 'back']];

// 12x12 pixel icons, single ink. X = on.
var ICON_ART = {
  eye: ['............', '............', '...XXXXXX...', '..X......X..', '.X..XXXX..X.', 'X...XXXX...X', 'X...XXXX...X', '.X..XXXX..X.', '..X......X..', '...XXXXXX...', '............', '............'],
  shield: ['............', '.XXXXXXXXXX.', '.X........X.', '.X...XX...X.', '.X..XXXX..X.', '.X...XX...X.', '.X........X.', '..X......X..', '..XX....XX..', '...XX..XX...', '....XXXX....', '............'],
  image: ['............', 'XXXXXXXXXXXX', 'X..........X', 'X..XX......X', 'X..XX......X', 'X.......X..X', 'X......XXX.X', 'X..X..XXXXXX', 'X.XXX.XXXXXX', 'XXXXXXXXXXXX', '............', '............'],
  camera: ['............', '....XXXX....', 'XXXXXXXXXXXX', 'X..........X', 'X...XXXX...X', 'X..X....X..X', 'X..X....X..X', 'X...XXXX...X', 'X..........X', 'XXXXXXXXXXXX', '............', '............'],
  sliders: ['..XXX.......', 'XXXXXXXXXXXX', '..XXX.......', '............', '.......XXX..', 'XXXXXXXXXXXX', '.......XXX..', '............', '....XXX.....', 'XXXXXXXXXXXX', '....XXX.....', '............'],
  power: ['.....XX.....', '.....XX.....', '..XX.XX.XX..', '.XX..XX..XX.', '.X...XX...X.', 'X....XX....X', 'X..........X', 'X..........X', '.X........X.', '.XX......XX.', '..XX....XX..', '....XXXX....'],
  play: ['............', '.XX.........', '.XXXX.......', '.XXXXXX.....', '.XXXXXXXX...', '.XXXXXXXXXX.', '.XXXXXXXXXX.', '.XXXXXXXX...', '.XXXXXX.....', '.XXXX.......', '.XX.........', '............'],
  back: ['............', '............', '............', '...X........', '..XX........', '.XXXXXXXXXX.', '.XXXXXXXXXX.', '..XX........', '...X........', '............', '............', '............']
};
var iconData = {};

function icon(name, x, y, color) {
  if (!display.drawXBitmap || !ICON_ART[name]) {
    return;
  }
  var d = iconData[name];
  if (!d) {
    var rows = ICON_ART[name];
    d = new Uint8Array(2 * rows.length);
    for (var r = 0; r < rows.length; r++) {
      for (var c = 0; c < 12; c++) {
        if (rows[r].charAt(c) === 'X') {
          d[r * 2 + (c >> 3)] |= 1 << (c & 7);
        }
      }
    }
    iconData[name] = d;
  }
  display.drawXBitmap(x, y, d, 12, 12, color);
}

// Title bar: brand mark, uppercase cyan title, optional chip on the right.
function header(title, chipText) {
  var cw = 0;
  var maxChars = 17;
  if (chipText) {
    cw = textW(up(chipText), 1) + 10;
    maxChars = Math.floor((W - 28 - cw - 6) / 12);
  }
  icon('camera', 6, 5, C.cyan);
  txt(clip(up(title), maxChars), 22, 4, 2, C.cyan);
  if (chipText) {
    chip(W - 6 - cw, 6, up(chipText), C.text, C.code);
  }
  display.drawFastHLine(6, 23, W - 12, C.deep);
}

function footer(hint) {
  if (typeof hint === 'string') {
    txt(clip(hint, 38), 6, H - 12, 1, C.dim);
  } else {
    keys(hint, H - 14);
  }
}

// A modal card: icon, uppercase title, dim lines, then up to two buttons (the first is the action).
// kind: 'err' (red), 'ok' (green) or '' (cyan).
function msgScreen(title, lines, buttons, kind) {
  var X = 12;
  var Y = 6;
  var CW = 216;
  var CH = 117;
  var cx = X + CW / 2;
  var col = kind === 'err' ? C.bad : kind === 'ok' ? C.ok : C.cyan;
  var i;
  ground();
  box(X, Y, CW, CH, 10, C.panel, 3, 3);
  display.drawFillCircle(cx, Y + 14, 9, col);
  display.drawFillCircle(cx, Y + 14, 7, C.panel);
  if (kind === 'err') {
    display.drawFillRect(cx - 1, Y + 9, 3, 6, col);
    display.drawFillRect(cx - 1, Y + 17, 3, 3, col);
  } else if (kind === 'ok') {
    display.drawLine(cx - 4, Y + 14, cx - 1, Y + 17, col);
    display.drawLine(cx - 4, Y + 15, cx - 1, Y + 18, col);
    display.drawLine(cx - 1, Y + 17, cx + 4, Y + 11, col);
    display.drawLine(cx - 1, Y + 18, cx + 4, Y + 12, col);
  } else {
    display.drawFillRect(cx - 1, Y + 9, 3, 3, col);
    display.drawFillRect(cx - 1, Y + 13, 3, 7, col);
  }
  txtC(clip(up(title), 16), cx, Y + 26, 2, col);
  for (i = 0; i < lines.length && i < 4; i++) {
    txtC(clip(lines[i], 33), cx, Y + 46 + i * 10, 1, C.dim);
  }
  if (buttons && buttons.length > 0) {
    var total = 0;
    var ws = [];
    for (i = 0; i < buttons.length; i++) {
      ws.push(Math.max(56, textW(up(buttons[i]), 1) + 20));
      total += ws[i] + (i > 0 ? 10 : 0);
    }
    var bx = Math.floor(cx - total / 2);
    for (i = 0; i < buttons.length; i++) {
      var primary = buttons.length > 1 && i === 0;
      box(bx, Y + CH - 26, ws[i], 16, 6, primary ? C.cyan : C.code, 2, 2);
      txtC(up(buttons[i]), bx + Math.floor(ws[i] / 2), Y + CH - 26 + 4, 1, primary ? C.code : C.text);
      bx += ws[i] + 10;
    }
  }
}

function toast(msg, kind) {
  if (toastUntil > 0) {
    since = 0; // a shorter toast must not leave the end of the previous one behind
  }
  toastText = msg;
  toastKind = kind || '';
  toastUntil = now() + 1800;
}

function drawToast() {
  var t = clip(toastText, 33);
  var w = textW(t, 1) + 28;
  var x = Math.floor((W - w) / 2);
  var y = H - 24;
  var col = toastKind === 'ok' ? C.ok : toastKind === 'err' ? C.bad : C.cyan;
  box(x, y, w, 16, 7, C.panel, 2, 2);
  display.drawFillCircle(x + 10, y + 8, 3, col);
  txt(t, x + 18, y + 4, 1, C.text);
}

// A toast over a menu (the menu repaints itself afterwards).
function notice(msg, kind) {
  toastText = msg;
  toastKind = kind || '';
  drawToast();
  delay(1200);
}

// One menu row. item = a label string, or {l: label, v: value, i: icon}.
function item(label, value, ic) {
  return { l: label, v: value, i: ic };
}

var ROW_X = 6;
var ROW_W = 218;
var ROW_H = 20;
var ROW_Y0 = 28;
var ROW_PITCH = 23;
var ROWS = 4;

function drawRow(it, y, sel) {
  var label = typeof it === 'string' ? it : it.l;
  var val = typeof it === 'string' ? '' : it.v;
  var ic = typeof it === 'string' ? '' : it.i;
  var x = ROW_X;
  var rightW = 0;
  var cx;
  if (sel) {
    x--;
    y--;
    gradBox(x, y, ROW_W, ROW_H, 6, 3, 2);
  } else {
    box(x, y, ROW_W, ROW_H, 6, C.panel, 2, 2);
  }
  if (ic) {
    icon(ic, x + 7, y + 4, C.cyan);
  } else {
    cx = x + 12;
    display.drawFillCircle(cx, y + 10, 3, C.ink);
    display.drawFillCircle(cx, y + 10, 2, sel ? C.cyan : C.deep);
  }
  if (val !== undefined && val !== null && val !== '') {
    var vs = '' + val;
    if (vs === 'On' || vs === 'Off') {
      toggle(x + ROW_W - 42, y + 3, vs === 'On');
      rightW = 48;
    } else {
      var uv = up(vs);
      var cw = textW(uv, 1) + 10;
      chip(x + ROW_W - cw - 6, y + 4, uv, C.cyan, C.code);
      rightW = cw + 12;
    }
  }
  txt(clip(label, Math.floor((ROW_W - 27 - rightW) / 12)), x + 25, y + 2, 2, C.text);
}

// A scrolling list of up to 4 visible rows.
function drawList(title, items, sel, hint) {
  ground();
  header(title, title === APP_NAME && camSeen ? MODES[cam.mode] : '');
  var top = Math.max(0, Math.min(sel - 1, items.length - ROWS));
  for (var r = 0; r < ROWS && top + r < items.length; r++) {
    // draw the selected row last so its lift and shadow sit on top of its neighbours
    if (top + r !== sel) {
      drawRow(items[top + r], ROW_Y0 + r * ROW_PITCH, false);
    }
  }
  drawRow(items[sel], ROW_Y0 + (sel - top) * ROW_PITCH, true);
  if (items.length > ROWS) {
    var track = ROWS * ROW_PITCH - 3;
    var th = Math.max(8, Math.floor((ROWS * track) / items.length));
    var ty = ROW_Y0 + Math.floor(((track - th) * top) / (items.length - ROWS));
    display.drawFillRoundRect(W - 9, ROW_Y0, 4, track, 2, C.ink);
    display.drawFillRoundRect(W - 9, ty, 4, th, 2, C.cyan);
  }
  footer(hint);
}

// Runs a menu until onSelect returns something (that value is returned). UP+DOWN returns escResult.
// idleFn (optional) is called about every 1.5 s while nothing is pressed; it returns true to redraw.
function runMenu(title, labelsFn, hintFn, onSelect, escResult, idleFn) {
  var sel = 0;
  var dirty = true;
  var idle = 0;
  while (true) {
    var labels = labelsFn();
    if (sel >= labels.length) {
      sel = labels.length - 1;
    }
    if (dirty) {
      drawList(title, labels, sel, hintFn(sel));
      dirty = false;
    }
    var k = readKey();
    if (k === '') {
      delay(30);
      idle++;
      if (idleFn && idle >= 50) {
        idle = 0;
        var r0 = idleFn();
        if (r0 === 'quit') {
          return 'quit';
        }
        if (r0) {
          dirty = true;
        }
      }
      continue;
    }
    idle = 0;
    if (k === 'esc') {
      return escResult;
    }
    if (k === 'prev') {
      sel = (sel + labels.length - 1) % labels.length;
      dirty = true;
    } else if (k === 'next') {
      sel = (sel + 1) % labels.length;
      dirty = true;
    } else {
      var r = onSelect(sel);
      if (r) {
        return r;
      }
      dirty = true;
    }
  }
}

// ------------------------------- camera ------------------------------------
function onCamNetwork() {
  if (!wifi.connected()) {
    return false;
  }
  if (!JOIN_CAM_WIFI) {
    return true;
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

function getJson(path) {
  var r;
  try {
    r = wifi.httpFetch(CAM_HOST + path, { responseType: 'json' });
  } catch (e) {
    lastErr = 'net ' + e;
    return null;
  }
  if (!r || r.status !== 200 || !r.body) {
    lastErr = 'http ' + (r ? r.status : 0);
    return null;
  }
  return r.body;
}

// Send controls and remember the camera's answer (its full state).
function ctl(q) {
  var b = getJson('/ctl?' + q);
  if (b) {
    cam = b;
    camSeen = true;
  }
  return b;
}

// '' = ready, otherwise why not: 'wifi', 'cam' or 'size'
function connectCam() {
  if (!joinCam()) {
    return 'wifi';
  }
  var st = null;
  for (var i = 0; i < 3 && !st; i++) {
    st = getJson('/status');
    if (!st) {
      delay(300);
    }
  }
  if (!st) {
    return 'cam';
  }
  if (st.w !== FRAME_W || st.h !== FRAME_H) {
    badSize = st.w + 'x' + st.h;
    return 'size';
  }
  menuMseq = st.mseq;
  if (!ctl('')) {
    return 'cam';
  }
  return '';
}

// Returns 'ok', 'back' or 'quit'. Warns about a missing SD card but never blocks live view.
function ensureConnected() {
  if (W < FRAME_W) {
    msgScreen('Landscape only', ['This needs a screen 240 px wide.', 'Rotate Bruce to landscape.'], ['UP back'], 'err');
    waitKey(0);
    return 'back';
  }
  while (true) {
    msgScreen('Connecting', ['Joining ' + CAM_SSID + ' ...', 'a few seconds'], ['UP+DN quit'], '');
    var why = connectCam();
    if (why === '') {
      if (cam.sd === 0) {
        var l2 = ['Photos and recording are off.', 'Live view and alerts still work.'];
        if (MODE_NEEDS_SD[cam.mode]) {
          l2.push(MODES[cam.mode] + ' mode wants a card.');
        }
        l2.push('Insert a FAT32 card, no reboot.');
        msgScreen('No SD card', l2, null, 'err');
        delay(2200);
      }
      return 'ok';
    }
    var lines;
    if (why === 'wifi') {
      lines = ["Couldn't join " + CAM_SSID, 'Is the camera powered on?', 'SSID / password correct?'];
    } else if (why === 'cam') {
      lines = ['Joined WiFi, camera silent', 'Is the sketch running?', 'Expected ' + CAM_HOST];
    } else {
      lines = ['Camera sends ' + badSize, 'App expects ' + FRAME_W + 'x' + FRAME_H, 'Match OUT_W/OUT_H in config.h'];
    }
    msgScreen('Cannot connect', lines, ['M5 retry', 'UP back'], 'err');
    var k = waitKey(0);
    if (k === 'esc') {
      return 'quit';
    }
    if (k === 'prev') {
      return 'back';
    }
  }
}

// ------------------------------- alerts ------------------------------------
function fireIr() {
  if (IR_FILE === '' || !ir || !ir.transmitFile) {
    return;
  }
  var t = now();
  if (lastIrAt !== 0 && t - lastIrAt < IR_GAP_MS) {
    return;
  }
  lastIrAt = t;
  try {
    ir.transmitFile(IR_FILE, true);
  } catch (e) {
    lastErr = 'ir ' + e;
  }
}

// Buzzer, the red LED on G19 (it is also the IR emitter), and optionally an IR command.
function alertMotion(big) {
  if (alertLevel === 0) {
    return;
  }
  try {
    if (alertLevel >= 2 && audio && audio.tone) {
      audio.tone(big ? 2800 : 1900, 70);
      delay(90);
      if (big) {
        audio.tone(2800, 70);
        delay(90);
        audio.tone(3400, 90);
      }
    }
    if (notification && notification.blink) {
      notification.blink(70);
    }
  } catch (e) {
    lastErr = 'alert ' + e;
  }
  fireIr();
}

// ------------------------------- picture -----------------------------------
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
  if (!b || b.length < 8 || b.length !== res.length) {
    lastErr = 'short ' + (b ? b.length : 0) + '/' + res.length;
    return null;
  }
  lastErr = '';
  return b;
}

// Reply layout (firmware/mini_cctv/delta.h): u16 mask, u32 seq, u8 motion, u8 flags, then for
// each set bit u16 len + payload. Draws the bands, advances `since`, and remembers motion and
// flags. Returns the number of bands drawn, or -1 if the reply is malformed.
function applyBands(b) {
  var mask = b[0] | (b[1] << 8);
  var seq = b[2] + b[3] * 256 + b[4] * 65536 + b[5] * 16777216;
  var i;
  var off = 8;

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
  off = 8;
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

  hdrMotion = b[6];
  hdrFlags = b[7];
  // a camera that restarted counts from 1 again: start over from a full picture
  since = seq < since ? 0 : seq;
  return drawn;
}

// ------------------------------- viewer ------------------------------------
// The overlays are chips: ink outline, near-black fill, so they read on any picture.
function drawHud(kind, fps, netMs, drawMs) {
  var s;
  var color = C.cyan;
  if (lastErr !== '') {
    color = C.bad;
    s = lastErr;
  } else if (kind === 'rewind') {
    s = 'REWIND -' + mmss(cam.ago) + (cam.play ? '  playing' : '  paused');
  } else if (kind === 'play') {
    s = clip(cam.name.split('.')[0], 12) + (cam.clen > 0 ? ' ' + mmss(cam.cpos) + '/' + mmss(cam.clen) + (cam.play ? ' >' : ' ||') : '');
  } else if (kind === 'ptz') {
    s = 'ZOOM ' + (cam.z / 10) + 'x  pan ' + cam.px + ',' + cam.py;
  } else {
    s = (photo ? 'PHOTO ' : 'FAST ') + (fps > 0 ? fps + ' fps' : 'still') + ' ' + netMs + '/' + drawMs + 'ms';
  }
  chip(2, 2, pad(clip(s, 22), 22), color, C.code);
}

// REC chip, "no SD" chip and the motion meter: always shown, even with the info line off
function drawStatus() {
  var rec = hdrFlags & DF_REC;
  var noSd = hdrFlags & DF_SD ? 0 : 1;
  var mw = Math.floor((hdrMotion * 38) / 100);
  if ((recShown && !rec) || (noSdShown && !noSd)) {
    since = 0; // repaint the picture under a chip that has just gone
  }
  recShown = rec ? 1 : 0;
  noSdShown = noSd;
  box(W - 46, 2, 42, 12, 4, C.code, 0, 1);
  if (mw > 0) {
    display.drawFillRect(W - 45, 3, mw, 10, hdrFlags & DF_BIG ? C.bad : C.cyan);
  }
  if (rec) {
    box(W - 90, 2, 40, 12, 5, C.code, 0, 1);
    display.drawFillCircle(W - 82, 8, 3, C.bad);
    txt('REC', W - 75, 4, 1, C.bad);
  }
  if (noSd) {
    chip(2, 16, 'NO SD', C.bad, C.code);
  }
}

function drawHint(kind) {
  var pairs = [['UP', 'menu'], ['DN', 'photo'], ['M5', 'more']];
  if (kind === 'ptz') {
    pairs = [['M5', 'next'], ['UP/DN', 'change']];
  } else if (kind === 'rewind') {
    pairs = [['UP', 'older'], ['DN', 'newer'], ['M5', 'menu']];
  } else if (kind === 'play') {
    pairs = [['UP', 'back'], ['DN', '+10s'], ['M5', 'menu']];
  }
  display.drawFillRect(0, H - 14, W, 14, C.code);
  keys(pairs, H - 13);
}

function quickPhoto() {
  if (!(hdrFlags & DF_SD)) {
    toast('No SD card: cannot save', 'err');
    return;
  }
  toast('Saving photo...', '');
  drawToast();
  var r = ctl('snap=1');
  if (r && r.msg === 'saved') {
    toast('Saved ' + r.name, 'ok');
  } else {
    toast(r ? r.msg : 'camera not answering', 'err');
  }
}

function toggleRecording() {
  if (!(hdrFlags & DF_SD)) {
    toast('No SD card: cannot record', 'err');
    return;
  }
  var was = hdrFlags & DF_REC;
  ctl('rec=t');
  toast(was ? 'Stopping recording...' : 'Recording started', was ? '' : 'ok');
}

function cycleFlip() {
  // four combinations of vertical flip and mirror
  var n = (cam.fl * 2 + cam.mi + 1) % 4;
  ctl('fl=' + (n >> 1) + '&mi=' + (n & 1));
}

function actionItems() {
  return [
    item('Resume'),
    item('Photo'),
    item(hdrFlags & DF_REC ? 'Stop recording' : 'Record clip'),
    item('Zoom / Pan'),
    item('Rewind (DVR)'),
    item('Filter', FILTERS[cam.f]),
    item('Night', cam.n ? 'On' : 'Off'),
    item('Mode', MODES[cam.mode]),
    item('Picture', photo ? 'Photo' : 'Fast'),
    item('Info', hud ? 'On' : 'Off'),
    item('Main menu')
  ];
}

function actionSelect(i) {
  if (i === 0) {
    return 'resume';
  }
  if (i === 1) {
    quickPhoto();
    return 'resume';
  }
  if (i === 2) {
    toggleRecording();
    return 'resume';
  }
  if (i === 3) {
    return 'ptz';
  }
  if (i === 4) {
    return 'rewind';
  }
  if (i === 5) {
    ctl('f=' + ((cam.f + 1) % FILTERS.length));
  } else if (i === 6) {
    ctl('n=' + (cam.n ? 0 : 1));
  } else if (i === 7) {
    var m = pickMode();
    if (m === 'quit') {
      return 'quit';
    }
  } else if (i === 8) {
    photo = !photo;
  } else if (i === 9) {
    hud = !hud;
  } else {
    return 'menu';
  }
  return '';
}

// Picks the camera's mode. Returns 'quit' or 'back'; the camera's own message (e.g. "mode set, but
// no SD card") is left in modeMsg for the caller to show.
var modeMsg = '';

function pickMode() {
  modeMsg = '';
  return runMenu(
    'Camera mode',
    function () {
      var l = [];
      for (var i = 0; i < MODES.length; i++) {
        l.push(item(MODES[i], i === cam.mode ? 'Active' : ''));
      }
      l.push(item('Back', '', 'back'));
      return l;
    },
    function (sel) {
      return sel < MODES.length ? MODE_BLURB[sel] : NAV;
    },
    function (i) {
      if (i >= MODES.length) {
        return 'back';
      }
      var r = ctl('mode=' + i);
      if (r && r.msg !== 'ok') {
        modeMsg = r.msg;
        toast(r.msg, 'err');
      }
      return 'back';
    },
    'back'
  );
}

function pickTimelapse() {
  var idx = 0;
  for (var i = 0; i < TL_STEPS.length; i++) {
    if (TL_STEPS[i] <= cam.tl) {
      idx = i;
    }
  }
  ctl('tl=' + TL_STEPS[(idx + 1) % TL_STEPS.length]);
}

function tlName(s) {
  if (s < 60) {
    return s + 's';
  }
  return s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h';
}

function rewindMenu() {
  return runMenu(
    'Rewind',
    function () {
      return [item(cam.play ? 'Pause' : 'Play', '', 'play'), item('Back to live', '', 'eye'), item('Close menu', '', 'back')];
    },
    function (sel) {
      return NAV;
    },
    function (i) {
      if (i === 0) {
        ctl('rwp=' + (cam.play ? 0 : 1));
        return 'resume';
      }
      if (i === 1) {
        ctl('live=1');
        return 'back';
      }
      return 'resume';
    },
    'resume'
  );
}

function playMenu() {
  return runMenu(
    'Playback',
    function () {
      return [item(cam.play ? 'Pause' : 'Play', '', 'play'), item('Forward 10 s'), item('Back 10 s'), item('Close', '', 'back')];
    },
    function (sel) {
      return NAV;
    },
    function (i) {
      if (i === 0) {
        ctl('pp=' + (cam.play ? 0 : 1));
      } else if (i === 1) {
        ctl('sk=10');
      } else if (i === 2) {
        ctl('sk=-10');
      }
      return 'resume';
    },
    'resume'
  );
}

var PTZ_TARGETS = ['Zoom', 'Pan left/right', 'Pan up/down', 'Reset', 'Done'];

// Key handling for each kind of viewer. Returns '', 'resume' (repaint), 'menu', 'back', 'ptz',
// 'rewind', 'actions' or 'quit'.
function viewerKey(kind, k, st) {
  if (kind === 'ptz') {
    if (k === 'sel') {
      st.ptz = (st.ptz + 1) % PTZ_TARGETS.length;
      toast('Adjusting: ' + PTZ_TARGETS[st.ptz], '');
      return '';
    }
    var d = k === 'prev' ? -1 : 1;
    if (st.ptz === 0) {
      ctl('z=' + (cam.z - d * 5));
    } else if (st.ptz === 1) {
      ctl('px=' + (cam.px + d * 10));
    } else if (st.ptz === 2) {
      ctl('py=' + (cam.py + d * 10));
    } else if (st.ptz === 3) {
      ctl('z=10&px=50&py=50');
      st.ptz = 0;
      toast('Zoom reset', 'ok');
    } else {
      return 'back';
    }
    return '';
  }
  if (kind === 'rewind') {
    if (k === 'prev') {
      ctl('rw=' + (cam.ago + 5));
    } else if (k === 'next') {
      var a = cam.ago - 5;
      ctl('rw=' + (a > 0 ? a : 0));
      if (a <= 0) {
        return 'back';
      }
    } else {
      var r = rewindMenu();
      if (r === 'back' || r === 'quit') {
        return r;
      }
      return 'resume';
    }
    return '';
  }
  if (kind === 'play') {
    if (k === 'prev') {
      ctl('live=1');
      return 'back';
    }
    if (k === 'next') {
      if (cam.clen > 0) {
        ctl('sk=10');
      }
      return '';
    }
    if (cam.clen > 0) {
      var p = playMenu();
      if (p === 'quit') {
        return 'quit';
      }
    }
    return 'resume';
  }
  // live and guard
  if (k === 'prev') {
    return 'menu';
  }
  if (k === 'next') {
    quickPhoto();
    return '';
  }
  return 'actions';
}

// kind: 'live' | 'guard' (returns 'auto' when things go quiet) | 'ptz' | 'rewind' | 'play'
// Returns 'menu', 'back', 'auto' or 'quit'.
function viewer(kind) {
  display.fill(0);
  since = 0;
  recShown = 0;
  noSdShown = 0;
  var st = { ptz: 0 };
  var fails = 0;
  var outages = 0;
  var fps = 0;
  var winStart = now();
  var winUpd = 0;
  var netMs = 0;
  var drawMs = 0;
  var hintUntil = now() + 3500;
  var lastMotionAt = now();
  var prevMotion = false;
  var lastState = now();
  var sinceGc = 0;

  if (kind === 'rewind') {
    var rr = ctl('rw=5');
    if (!rr || rr.ov !== 1) {
      toast(rr ? rr.msg : 'camera not answering', 'err');
      return 'back';
    }
  }

  while (true) {
    var k = readKey();
    if (k === 'esc') {
      return 'quit';
    }
    if (k !== '') {
      var act = viewerKey(kind, k, st);
      if (act === 'actions') {
        act = runMenu(
          'Camera',
          actionItems,
          function (sel) {
            return sel === 7 ? MODE_BLURB[cam.mode] : NAV;
          },
          actionSelect,
          'resume'
        );
      }
      if (act === 'ptz' || act === 'rewind') {
        var sub = viewer(act);
        if (sub === 'quit' || sub === 'menu') {
          return sub;
        }
        act = 'resume';
      }
      if (act === 'quit' || act === 'menu' || act === 'back') {
        return act;
      }
      if (act === 'resume') {
        display.fill(0);
        since = 0;
        hintUntil = 0;
        recShown = 0;
        noSdShown = 0;
      }
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
      box(40, 40, 160, 52, 10, C.panel, 3, 2);
      txtC('NO SIGNAL', W / 2, 48, 2, C.bad);
      txtC('reconnecting...', W / 2, 72, 1, C.dim);
      if (outages >= 2) {
        wifi.disconnect(); // stale association: start clean
        delay(300);
      }
      joinCam();
      fails = 0;
      since = 0;
      display.fill(0);
      recShown = 0;
      noSdShown = 0;
    } else if (!reply) {
      delay(100);
    }

    var t = now();
    if (reply && drawn >= 0) {
      var moving = (hdrFlags & DF_MOTION) !== 0;
      if (moving) {
        lastMotionAt = t;
        if (!prevMotion && (kind === 'live' || kind === 'guard') && MODE_ALERTS[cam.mode]) {
          alertMotion((hdrFlags & DF_BIG) !== 0);
        }
      }
      prevMotion = moving;
      if (kind === 'guard' && t - lastMotionAt > AUTO_RETURN_MS) {
        return 'auto';
      }
      if ((hdrFlags & DF_OVR) === 0 && kind === 'rewind') {
        return 'back'; // playback caught up with the live picture
      }
    }
    if (t - winStart >= 1000) {
      fps = Math.floor((winUpd * 10000) / (t - winStart)) / 10;
      winUpd = 0;
      winStart = t;
    }
    if ((kind === 'play' || kind === 'rewind') && t - lastState > 1000) {
      lastState = t;
      ctl('');
    }
    if (hud || kind !== 'live') {
      drawHud(kind, fps, netMs, drawMs);
    }
    drawStatus();
    if (hintUntil > 0) {
      if (t < hintUntil && toastUntil < t) {
        drawHint(kind);
      } else if (t >= hintUntil) {
        hintUntil = 0;
        since = 0; // repaint under the hint
      }
    }
    if (toastUntil > 0) {
      if (t < toastUntil) {
        drawToast();
      } else {
        toastUntil = 0;
        since = 0;
      }
    }

    sinceGc++;
    if (sinceGc >= 20) {
      gc();
      sinceGc = 0;
    }
  }
}

// ------------------------------- guard -------------------------------------
var gd = { armedAt: 0, events: 0, lost: false, sec: -1 };

function two(n) {
  return (n < 10 ? '0' : '') + n;
}

// the big counter: how long the camera has been guarded
function drawGuardClock() {
  var s = Math.floor((now() - gd.armedAt) / 1000);
  gd.sec = s;
  display.drawFillRect(14, 46, 212, 34, C.panel);
  txtC(two(Math.floor(s / 3600)) + ':' + two(Math.floor(s / 60) % 60) + ':' + two(s % 60), W / 2, 48, 4, gd.lost ? C.dim : C.text);
}

function drawGuard() {
  var x = 10;
  ground();
  header('Guard', MODES[cam.mode]);
  box(10, 28, 220, 58, 10, C.panel, 3, 2);
  if (gd.lost) {
    txt('NO SIGNAL - RECONNECTING', 22, 34, 1, C.bad);
  } else {
    display.drawFillCircle(24, 37, 3, C.cyan);
    txt('ARMED', 32, 34, 1, C.cyan);
  }
  drawGuardClock();
  x += chip(x, 98, 'EVENTS ' + gd.events, gd.events > 0 ? C.bad : C.cyan, C.code) + 6;
  chip(x, 98, 'ALERTS ' + up(ALERT_NAMES[alertLevel]), C.cyan, C.code);
  footer([['UP', 'menu'], ['M5', 'watch'], ['DN', 'alerts']]);
}

function guardLoop(ms) {
  var fails = 0;
  gd.armedAt = now();
  gd.events = 0;
  gd.lost = false;
  drawGuard();
  while (true) {
    var k = readKey();
    if (k === 'esc') {
      return 'quit';
    }
    if (k === 'prev') {
      return 'menu';
    }
    if (k === 'next') {
      alertLevel = (alertLevel + 2) % 3;
      drawGuard();
    }
    if (k === 'sel') {
      display.restoreBrightness();
      var rv = viewer('live');
      display.setBrightness(GUARD_DIM);
      if (rv === 'quit') {
        return 'quit';
      }
      drawGuard();
    }

    var m = getJson('/m?s=' + ms);
    if (!m) {
      fails++;
      if (fails >= 3) {
        if (fails >= 6) {
          wifi.disconnect();
          delay(300);
        }
        joinCam();
        gd.lost = true;
        drawGuard();
      }
      delay(500);
      continue;
    }
    if (gd.lost) {
      gd.lost = false;
      drawGuard();
    }
    fails = 0;
    cam.mode = m.mode;
    cam.sd = m.sd;
    if (m.ms < ms) {
      ms = m.ms; // camera restarted
    }
    if (m.ms > ms) {
      ms = m.ms;
      gd.events++;
      display.restoreBrightness();
      display.fill(C.bad);
      txtC('MOTION', W / 2, 50, 4, C.ink);
      alertMotion(m.big === 1);
      var r2 = viewer('guard');
      display.setBrightness(GUARD_DIM);
      if (r2 === 'quit') {
        return 'quit';
      }
      if (r2 === 'menu') {
        return 'menu';
      }
      drawGuard();
    } else if (Math.floor((now() - gd.armedAt) / 1000) !== gd.sec) {
      drawGuardClock();
    }
  }
}

function guard() {
  var c = ensureConnected();
  if (c !== 'ok') {
    return c === 'quit' ? 'quit' : 'menu';
  }
  if (!MODE_ALERTS[cam.mode]) {
    msgScreen('Arm guard?', [MODES[cam.mode] + ' mode has no motion', 'detection. Switch it to Security?'], ['M5 switch', 'UP back'], '');
    var k = waitKey(0);
    if (k === 'esc') {
      return 'quit';
    }
    if (k !== 'sel') {
      return 'menu';
    }
    ctl('mode=2');
  }
  var st = getJson('/status');
  display.setBrightness(GUARD_DIM);
  var r = guardLoop(st ? st.mseq : 0);
  display.restoreBrightness();
  return r;
}

// ------------------------------- gallery -----------------------------------
function pickFile(dir) {
  var r = getJson('/files?d=' + dir);
  if (!r) {
    msgScreen('Camera offline', [lastErr], ['UP back'], 'err');
    waitKey(0);
    return '';
  }
  if (r.sd === 0) {
    msgScreen('No SD card', ['The camera has no card.'], ['UP back'], 'err');
    waitKey(0);
    return '';
  }
  var files = r.f;
  if (!files || files.length === 0) {
    msgScreen(dir === 'clips' ? 'No clips yet' : 'No photos yet', ['Nothing saved on the card yet.'], ['UP back'], '');
    waitKey(0);
    return '';
  }
  return runMenu(
    dir === 'clips' ? 'Clips' : 'Photos',
    function () {
      var l = [];
      for (var i = 0; i < files.length; i++) {
        l.push(item(files[i][0].substring(0, 8), Math.floor(files[i][1] / 1024) + 'K', dir === 'clips' ? 'play' : 'image'));
      }
      l.push(item('Back', '', 'back'));
      return l;
    },
    function (sel) {
      return sel < files.length ? files[sel][0] : NAV;
    },
    function (i) {
      if (i >= files.length) {
        return 'back';
      }
      var res = ctl((dir === 'clips' ? 'clip=' : 'photo=') + files[i][0]);
      if (!res || res.ov === 0) {
        msgScreen("Can't open it", [res ? res.msg : 'camera not answering'], ['UP back'], 'err');
        waitKey(0);
        return '';
      }
      var v = viewer('play');
      ctl('live=1');
      if (v === 'quit') {
        return 'quit';
      }
      return '';
    },
    'back'
  );
}

function gallery() {
  var c = ensureConnected();
  if (c !== 'ok') {
    return c === 'quit' ? 'quit' : '';
  }
  return runMenu(
    'Photos & clips',
    function () {
      return [item('Photos', '', 'image'), item('Clips', '', 'play'), item('Back', '', 'back')];
    },
    function (sel) {
      return cam.sd === 0 ? 'No SD card in the camera' : cam.free + ' MB free on the card';
    },
    function (i) {
      if (i === 2) {
        return 'back';
      }
      if (pickFile(i === 0 ? 'photos' : 'clips') === 'quit') {
        return 'quit';
      }
      return '';
    },
    'back'
  );
}

// ------------------------------- camera settings ---------------------------
// Things you adjust while looking at the picture: filter, night, flip, brightness, zoom.
function cameraMenu() {
  var c = ensureConnected();
  if (c !== 'ok') {
    return c === 'quit' ? 'quit' : '';
  }
  return runMenu(
    'Camera',
    function () {
      return [
        item('Filter', FILTERS[cam.f]),
        item('Night', cam.n ? 'On' : 'Off'),
        item('Flip', FLIP_NAMES[cam.fl * 2 + cam.mi]),
        item('Brightness', (cam.br > 0 ? '+' : '') + cam.br),
        item('Zoom / Pan', '', 'eye'),
        item('Back', '', 'back')
      ];
    },
    function (sel) {
      return NAV;
    },
    function (i) {
      if (i === 0) {
        ctl('f=' + ((cam.f + 1) % FILTERS.length));
      } else if (i === 1) {
        ctl('n=' + (cam.n ? 0 : 1));
      } else if (i === 2) {
        cycleFlip();
      } else if (i === 3) {
        ctl('br=' + (cam.br >= 2 ? -2 : cam.br + 1));
      } else if (i === 4) {
        var v = viewer('ptz');
        ctl('live=1');
        if (v === 'quit') {
          return 'quit';
        }
      } else {
        return 'back';
      }
      return '';
    },
    'back'
  );
}

// ------------------------------- settings ----------------------------------
// What the app and the camera start with. The Stick's own choices live in /MiniCCTV.cfg; auto-record,
// the camera mode and the timelapse interval are saved by the camera itself.
function settingsItems() {
  return [
    item('Auto-record', camSeen ? (cam.auto ? 'On' : 'Off') : '...'),
    item('Picture', cfg.photo ? 'Photo' : 'Fast'),
    item('Alerts', ALERT_SHORT[cfg.alerts]),
    item('Info line', cfg.hud ? 'On' : 'Off'),
    item('Mode', camSeen ? MODES[cam.mode] : '...'),
    item('Timelapse', camSeen ? tlName(cam.tl) : '...'),
    item('Back', '', 'back')
  ];
}

function settingsHint(sel) {
  if (sel === 0) {
    return camSeen && cam.mode !== 2 ? 'Used in Security mode.' : 'A clip for every motion event.';
  }
  if (sel === 1) {
    return 'Photo: full colour. Fast: no blinking.';
  }
  if (sel === 2) {
    return 'Buzzer and the red LED on motion.';
  }
  if (sel === 3) {
    return 'FPS and timings on the live picture.';
  }
  if (sel === 4) {
    return camSeen ? MODE_BLURB[cam.mode] : 'The camera keeps its mode.';
  }
  if (sel === 5) {
    return 'Photo interval in Timelapse mode.';
  }
  return NAV;
}

// the camera must have answered once before its own settings can be shown or changed
function needCamera() {
  if (camSeen) {
    return 'ok';
  }
  return ensureConnected();
}

function settingsSelect(i) {
  var c;
  var r;
  if (i === 1) {
    cfg.photo = !cfg.photo;
    photo = cfg.photo;
    saveCfg();
    return '';
  }
  if (i === 2) {
    cfg.alerts = (cfg.alerts + 1) % 3;
    alertLevel = cfg.alerts;
    saveCfg();
    return '';
  }
  if (i === 3) {
    cfg.hud = !cfg.hud;
    hud = cfg.hud;
    saveCfg();
    return '';
  }
  if (i === 6) {
    return 'back';
  }
  c = needCamera();
  if (c === 'quit') {
    return 'quit';
  }
  if (c !== 'ok') {
    return '';
  }
  if (i === 0) {
    r = ctl('auto=' + (cam.auto ? 0 : 1));
  } else if (i === 4) {
    if (pickMode() === 'quit') {
      return 'quit';
    }
    r = cam;
  } else {
    pickTimelapse();
    r = cam;
  }
  if (!r) {
    notice('Camera not answering', 'err');
  } else if (modeMsg !== '') {
    notice(modeMsg, 'err');
    modeMsg = '';
  }
  return '';
}

function settings() {
  return runMenu('Settings', settingsItems, settingsHint, settingsSelect, 'back');
}

// ------------------------------- app ---------------------------------------
// While the main menu is open (and the Stick is already on the camera's WiFi) it still watches
// for motion, so an alert doesn't need Guard mode to be running.
function menuIdle() {
  if (alertLevel === 0 || !onCamNetwork()) {
    return false;
  }
  var st = getJson('/status');
  if (!st) {
    return false;
  }
  var fire = menuMseq >= 0 && st.mseq > menuMseq && MODE_ALERTS[st.mode];
  menuMseq = st.mseq;
  if (!fire) {
    return false;
  }
  alertMotion(false);
  msgScreen('Motion!', ['The camera saw movement.'], ['M5 watch', 'UP ignore'], 'err');
  var k = waitKey(8000);
  if (k === 'esc') {
    return 'quit';
  }
  if (k === 'sel') {
    var c = ensureConnected();
    if (c === 'quit') {
      return 'quit';
    }
    if (c === 'ok' && viewer('guard') === 'quit') {
      return 'quit';
    }
  }
  return true;
}

function mainLabels() {
  return [
    item('Watch live', '', 'eye'),
    item('Guard mode', '', 'shield'),
    item('Photos & clips', '', 'image'),
    item('Camera', '', 'camera'),
    item('Settings', '', 'sliders'),
    item('Exit', '', 'power')
  ];
}

function mainHint(sel) {
  if (sel === 1) {
    return 'Screen off, alerts when it moves';
  }
  if (sel === 2) {
    return 'Browse what is on the SD card';
  }
  if (sel === 3) {
    return 'Filter, night, flip, zoom';
  }
  if (sel === 4) {
    return 'Auto-record, picture, alerts, mode';
  }
  return NAV;
}

function mainSelect(i) {
  var c;
  var r;
  if (i === 0) {
    c = ensureConnected();
    if (c === 'quit') {
      return 'quit';
    }
    if (c === 'ok') {
      r = viewer('live');
      if (r === 'quit') {
        return 'quit';
      }
    }
    return '';
  }
  if (i === 1) {
    return guard() === 'quit' ? 'quit' : '';
  }
  if (i === 2) {
    return gallery() === 'quit' ? 'quit' : '';
  }
  if (i === 3) {
    return cameraMenu() === 'quit' ? 'quit' : '';
  }
  if (i === 4) {
    return settings() === 'quit' ? 'quit' : '';
  }
  return 'quit';
}

function main() {
  loadCfg();
  photo = cfg.photo;
  alertLevel = cfg.alerts;
  hud = cfg.hud;
  runMenu(APP_NAME, mainLabels, mainHint, mainSelect, 'quit', menuIdle);
  display.restoreBrightness();
  display.fill(0);
}

main();
