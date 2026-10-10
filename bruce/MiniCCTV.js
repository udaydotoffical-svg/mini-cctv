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
// Written in plain ES5 (var / function): Bruce runs mquickjs, a strict ES5 subset.

var display = require('display');
var keyboard = require('keyboard');
var wifi = require('wifi');
var audio = require('audio');
var notification = require('notification');
var ir = require('ir');

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
// ----------------------------------------------------------------------------

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

var C = {
  bg: display.color(8, 12, 20),
  panel: display.color(20, 28, 44),
  accent: display.color(0, 200, 120),
  text: display.color(235, 240, 245),
  dim: display.color(120, 135, 155),
  warn: display.color(255, 170, 0),
  red: display.color(255, 60, 60)
};

var cam = { mode: 2, sd: 1, rec: 0, z: 10, px: 50, py: 50, f: 0, n: 0, fl: 1, mi: 0, br: 1, free: 0, hist: 0, tl: 60, ov: 0, ago: 0, play: 0, cpos: 0, clen: 0, name: '' };
var photo = true; // true = Photo (JPEG strips, 16-bit colour), false = Fast (8-bit, never blinks)
var hud = true;
var alertLevel = 2;
var since = 0; // last picture update we have fully drawn
var lastErr = '';
var hdrMotion = 0;
var hdrFlags = DF_SD;
var toastText = '';
var toastUntil = 0;
var lastIrAt = 0;
var menuMseq = -1;
var badSize = '';

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

// ------------------------------- drawing -----------------------------------
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

function mmss(sec) {
  var s = Math.floor(sec);
  var r = s % 60;
  return Math.floor(s / 60) + ':' + (r < 10 ? '0' : '') + r;
}

function header(title) {
  display.drawFillRect(0, 0, W, 26, C.panel);
  display.drawFillRect(0, 26, W, 2, C.accent);
  display.setTextSize(2);
  display.setTextColor(C.accent, C.panel);
  display.drawString(clip(title, 19), 8, 5);
}

function footer(text) {
  display.drawFillRect(0, H - 14, W, 14, C.panel);
  display.setTextSize(1);
  display.setTextColor(C.dim, C.panel);
  display.drawString(clip(text, 38), 6, H - 11);
}

function msgScreen(title, lines, hint) {
  display.fill(C.bg);
  header(title);
  display.setTextSize(1);
  display.setTextColor(C.text, C.bg);
  for (var i = 0; i < lines.length; i++) {
    display.drawString(clip(lines[i], 38), 8, 36 + i * 13);
  }
  if (hint) {
    footer(hint);
  }
}

function toast(msg) {
  toastText = msg;
  toastUntil = now() + 1800;
}

function drawToast() {
  display.drawFillRect(0, H - 14, W, 14, C.panel);
  display.setTextSize(1);
  display.setTextColor(C.text, C.panel);
  display.drawString(clip(toastText, 38), 4, H - 11);
}

// A scrolling list of up to 4 visible rows.
function drawList(title, labels, sel, hint) {
  display.fill(C.bg);
  header(title);
  var rows = 4;
  var top = Math.max(0, Math.min(sel - 1, labels.length - rows));
  display.setTextSize(2);
  for (var r = 0; r < rows && top + r < labels.length; r++) {
    var i = top + r;
    var y = 32 + r * 21;
    if (i === sel) {
      display.drawFillRoundRect(4, y, W - 8, 20, 4, C.accent);
      display.setTextColor(C.bg, C.accent);
    } else {
      display.setTextColor(C.text, C.bg);
    }
    display.drawString(clip(labels[i], 17), 10, y + 2);
  }
  display.setTextSize(1);
  display.setTextColor(C.dim, C.bg);
  if (top > 0) {
    display.drawString('^', W - 10, 32);
  }
  if (top + rows < labels.length) {
    display.drawString('v', W - 10, 110);
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
    msgScreen('Landscape only', ['This needs a screen 240 px wide.', 'Rotate Bruce to landscape.'], 'UP back');
    waitKey(0);
    return 'back';
  }
  while (true) {
    msgScreen('Connecting', ['Joining ' + CAM_SSID + ' ...', 'a few seconds'], 'UP+DOWN quit');
    var why = connectCam();
    if (why === '') {
      if (cam.sd === 0) {
        var l2 = ['Photos and recording are off.', 'Live view and alerts work as normal.'];
        if (MODE_NEEDS_SD[cam.mode]) {
          l2.push(MODES[cam.mode] + ' mode wants a card to store things.');
        }
        l2.push('Put a FAT32 card in: it is picked up by itself.');
        msgScreen('No SD card', l2, '');
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
    msgScreen('Cannot connect', lines, 'M5 retry    UP back');
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
function drawHud(kind, fps, netMs, drawMs) {
  var s;
  var color = C.accent;
  if (lastErr !== '') {
    color = C.warn;
    s = lastErr;
  } else if (kind === 'rewind') {
    s = 'REWIND -' + mmss(cam.ago) + (cam.play ? '  playing' : '  paused');
  } else if (kind === 'play') {
    s = clip(cam.name, 12) + (cam.clen > 0 ? ' ' + mmss(cam.cpos) + '/' + mmss(cam.clen) + (cam.play ? ' >' : ' ||') : '');
  } else if (kind === 'ptz') {
    s = 'ZOOM ' + (cam.z / 10) + 'x  pan ' + cam.px + ',' + cam.py;
  } else {
    s = (photo ? 'PHOTO ' : 'FAST ') + (fps > 0 ? fps + ' fps' : 'still') + ' ' + netMs + '/' + drawMs + 'ms';
  }
  display.setTextSize(1);
  display.setTextColor(color, 0);
  display.drawString(pad(s, 26), 2, 2);
}

// recording dot, "no SD" tag and a motion meter: always shown, even with the info line off
function drawStatus() {
  var w = Math.floor((hdrMotion * 40) / 100);
  display.drawFillRect(W - 44, 3, 40, 5, 0);
  if (w > 0) {
    display.drawFillRect(W - 44, 3, w, 5, hdrFlags & DF_BIG ? C.red : C.warn);
  }
  display.setTextSize(1);
  display.setTextColor(C.red, 0);
  display.drawString(hdrFlags & DF_REC ? 'REC' : '   ', W - 70, 2);
  display.setTextColor(C.warn, 0);
  display.drawString(hdrFlags & DF_SD ? '     ' : 'NO SD', 2, 12);
}

function drawHint(kind) {
  display.setTextSize(1);
  display.setTextColor(C.text, 0);
  var s = 'UP menu  DOWN photo  M5 actions';
  if (kind === 'ptz') {
    s = 'M5 next  UP/DOWN change';
  } else if (kind === 'rewind') {
    s = 'UP older  DOWN newer  M5 menu';
  } else if (kind === 'play') {
    s = 'UP back  DOWN +10s  M5 menu';
  }
  display.drawString(pad(s, 38), 2, H - 10);
}

function quickPhoto() {
  if (!(hdrFlags & DF_SD)) {
    toast('No SD card: cannot save');
    return;
  }
  toast('Saving photo...');
  drawToast();
  var r = ctl('snap=1');
  if (r && r.msg === 'saved') {
    toast('Saved ' + r.name);
  } else {
    toast(r ? r.msg : 'camera not answering');
  }
}

function toggleRecording() {
  if (!(hdrFlags & DF_SD)) {
    toast('No SD card: cannot record');
    return;
  }
  var was = hdrFlags & DF_REC;
  ctl('rec=t');
  toast(was ? 'Stopping recording...' : 'Recording started');
}

function cycleFlip() {
  // four combinations of vertical flip and mirror
  var n = (cam.fl * 2 + cam.mi + 1) % 4;
  ctl('fl=' + (n >> 1) + '&mi=' + (n & 1));
}

function actionLabels() {
  return [
    'Resume',
    'Photo',
    hdrFlags & DF_REC ? 'Stop recording' : 'Record clip',
    'Zoom / Pan',
    'Rewind (DVR)',
    'Filter: ' + FILTERS[cam.f],
    'Night: ' + (cam.n ? 'On' : 'Off'),
    'Mode: ' + MODES[cam.mode],
    'Picture: ' + (photo ? 'Photo' : 'Fast'),
    'Info: ' + (hud ? 'On' : 'Off'),
    'Main menu'
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

function pickMode() {
  return runMenu(
    'Camera mode',
    function () {
      var l = [];
      for (var i = 0; i < MODES.length; i++) {
        l.push((i === cam.mode ? '* ' : '  ') + MODES[i]);
      }
      l.push('  Back');
      return l;
    },
    function (sel) {
      return sel < MODES.length ? MODE_BLURB[sel] : 'UP/DOWN move    M5 select';
    },
    function (i) {
      if (i >= MODES.length) {
        return 'back';
      }
      var r = ctl('mode=' + i);
      if (r && r.msg !== 'ok') {
        toast(r.msg);
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
  return 'back';
}

function rewindMenu() {
  return runMenu(
    'Rewind',
    function () {
      return [cam.play ? 'Pause' : 'Play', 'Back to live', 'Close menu'];
    },
    function (sel) {
      return 'UP/DOWN move    M5 select';
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
      return [cam.play ? 'Pause' : 'Play', 'Forward 10 s', 'Back 10 s', 'Close'];
    },
    function (sel) {
      return 'UP/DOWN move    M5 select';
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
      toast('Adjusting: ' + PTZ_TARGETS[st.ptz]);
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
      toast('Zoom reset');
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
      toast(rr ? rr.msg : 'camera not answering');
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
          actionLabels,
          function (sel) {
            return sel === 7 ? MODE_BLURB[cam.mode] : 'UP/DOWN move    M5 select';
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
      display.drawFillRoundRect(30, 48, W - 60, 40, 6, C.panel);
      display.setTextSize(2);
      display.setTextColor(C.warn, C.panel);
      display.drawString('No signal', 54, 58);
      if (outages >= 2) {
        wifi.disconnect(); // stale association: start clean
        delay(300);
      }
      joinCam();
      fails = 0;
      since = 0;
      display.fill(0);
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
function drawGuard(line1, line2, color) {
  display.fill(0);
  display.setTextSize(2);
  display.setTextColor(color, 0);
  display.drawString('GUARD', 8, 8);
  display.setTextSize(1);
  display.setTextColor(C.dim, 0);
  display.drawString(clip(line1, 38), 8, 34);
  display.drawString(clip(line2, 38), 8, 48);
  display.drawString('UP menu   M5 watch   DOWN alerts', 8, H - 12);
}

function guardLoop(ms) {
  var events = 0;
  var lastEvt = 0;
  var fails = 0;
  var line1 = 'Armed: ' + MODES[cam.mode] + ' mode';
  drawGuard(line1, 'Alerts: ' + ALERT_NAMES[alertLevel], C.accent);
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
      drawGuard(line1, 'Alerts: ' + ALERT_NAMES[alertLevel], C.accent);
    }
    if (k === 'sel') {
      display.restoreBrightness();
      var rv = viewer('live');
      display.setBrightness(GUARD_DIM);
      if (rv === 'quit') {
        return 'quit';
      }
      drawGuard(line1, 'Alerts: ' + ALERT_NAMES[alertLevel], C.accent);
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
        drawGuard('No signal from the camera', 'trying to reconnect...', C.warn);
      }
      delay(500);
      continue;
    }
    if (fails >= 3) {
      drawGuard(line1, 'Alerts: ' + ALERT_NAMES[alertLevel], C.accent);
    }
    fails = 0;
    cam.mode = m.mode;
    cam.sd = m.sd;
    if (m.ms < ms) {
      ms = m.ms; // camera restarted
    }
    if (m.ms > ms) {
      ms = m.ms;
      events++;
      lastEvt = now();
      display.restoreBrightness();
      display.fill(C.red);
      alertMotion(m.big === 1);
      var r2 = viewer('guard');
      display.setBrightness(GUARD_DIM);
      if (r2 === 'quit') {
        return 'quit';
      }
      if (r2 === 'menu') {
        return 'menu';
      }
      drawGuard(line1, 'Events: ' + events + '   Alerts: ' + ALERT_NAMES[alertLevel], C.accent);
    }
  }
}

function guard() {
  var c = ensureConnected();
  if (c !== 'ok') {
    return c === 'quit' ? 'quit' : 'menu';
  }
  if (!MODE_ALERTS[cam.mode]) {
    msgScreen(
      'Guard needs a mode',
      ['Camera mode is ' + MODES[cam.mode] + ', which does', 'not watch for motion.', '', 'M5: switch the camera to Security', 'UP: back'],
      ''
    );
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
    msgScreen('Camera not answering', [lastErr], 'UP back');
    waitKey(0);
    return '';
  }
  if (r.sd === 0) {
    msgScreen('No SD card', ['Nothing to show: the camera has no card.'], 'UP back');
    waitKey(0);
    return '';
  }
  var files = r.f;
  if (!files || files.length === 0) {
    msgScreen(dir === 'clips' ? 'No clips yet' : 'No photos yet', ['Nothing saved on the card yet.'], 'UP back');
    waitKey(0);
    return '';
  }
  return runMenu(
    dir === 'clips' ? 'Clips' : 'Photos',
    function () {
      var l = [];
      for (var i = 0; i < files.length; i++) {
        l.push(files[i][0].substring(0, 8) + ' ' + Math.floor(files[i][1] / 1024) + 'K');
      }
      l.push('Back');
      return l;
    },
    function (sel) {
      return sel < files.length ? files[sel][0] : 'UP/DOWN move    M5 select';
    },
    function (i) {
      if (i >= files.length) {
        return 'back';
      }
      var res = ctl((dir === 'clips' ? 'clip=' : 'photo=') + files[i][0]);
      if (!res || res.ov === 0) {
        msgScreen("Can't open it", [res ? res.msg : 'camera not answering'], 'UP back');
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
      return ['Photos', 'Clips', 'Back'];
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
function cameraMenu() {
  var c = ensureConnected();
  if (c !== 'ok') {
    return c === 'quit' ? 'quit' : '';
  }
  return runMenu(
    'Camera settings',
    function () {
      return [
        'Mode: ' + MODES[cam.mode],
        'Filter: ' + FILTERS[cam.f],
        'Night: ' + (cam.n ? 'On' : 'Off'),
        'Flip: ' + (cam.fl ? 'V' : '-') + (cam.mi ? 'M' : '-'),
        'Bright: ' + cam.br,
        'Timelapse: ' + cam.tl + 's',
        'Zoom / Pan',
        'Back'
      ];
    },
    function (sel) {
      if (sel === 0) {
        return MODE_BLURB[cam.mode];
      }
      return cam.sd === 0 ? 'No SD card in the camera' : cam.free + ' MB free on the card';
    },
    function (i) {
      if (i === 0) {
        return pickMode() === 'quit' ? 'quit' : '';
      }
      if (i === 1) {
        ctl('f=' + ((cam.f + 1) % FILTERS.length));
      } else if (i === 2) {
        ctl('n=' + (cam.n ? 0 : 1));
      } else if (i === 3) {
        cycleFlip();
      } else if (i === 4) {
        ctl('br=' + (cam.br >= 2 ? -2 : cam.br + 1));
      } else if (i === 5) {
        pickTimelapse();
      } else if (i === 6) {
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
  msgScreen('MOTION!', ['The camera saw movement.'], 'M5 watch    UP ignore');
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
  return ['Watch live', 'Guard mode', 'Photos & clips', 'Camera settings', 'Picture: ' + (photo ? 'Photo' : 'Fast'), 'Alerts: ' + ALERT_NAMES[alertLevel], 'Exit'];
}

function mainHint(sel) {
  if (sel === 1) {
    return 'Screen off, alerts when it moves';
  }
  if (sel === 4) {
    return photo ? 'Full colour, moving areas blink' : '256 colours, never blinks';
  }
  if (sel === 5) {
    return 'Buzzer and the red LED on motion';
  }
  return 'UP/DOWN move    M5 select';
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
    photo = !photo;
    return '';
  }
  if (i === 5) {
    alertLevel = (alertLevel + 1) % 3;
    return '';
  }
  return 'quit';
}

function main() {
  runMenu('MiniCCTV', mainLabels, mainHint, mainSelect, 'quit', menuIdle);
  display.restoreBrightness();
  display.fill(0);
}

main();
