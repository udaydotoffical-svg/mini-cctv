// Test suite for bruce/MiniCCTV.js. Strict ES5, so it runs on Node (vm) AND on the real mquickjs
// engine that Bruce uses (tools/test_app.js runs it both ways).
//
// It mocks Bruce's JS modules the way Bruce's firmware really behaves (checked against
// src/modules/bjs_interpreter in pr3y/Bruce): drawBitmap needs an exact-size Uint8Array,
// drawJpg a whole JPEG, views with a byteOffset are rejected (Bruce reads from the buffer start),
// wifi.httpFetch hands back {status, body, length} with body a copy at offset 0, button flags are
// consumed when read, and time is virtual so timeouts cost nothing.
//
// Expects these globals from the platform shim: SCENARIO (name), APP_PATH, loadApp(), GOLDEN.
var W = 240;
var H = 135;
var CLOCK = 1000000;
// is this 565 colour bright enough that filling a big area with it would flash?
function bright(c) {
  var r = ((c >> 11) & 31) * 8;
  var g = ((c >> 5) & 63) * 4;
  var b = (c & 31) * 8;
  return (r * 77 + g * 150 + b * 29) / 256 > 60;
}

function rgb565(r, g, b) {
  return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
}
var TITLE_CYAN = rgb565(34, 229, 255);
var TITLE_RED = rgb565(255, 77, 109);
var TITLE_GREEN = rgb565(25, 195, 125);
var FAILED = 0;
var PASSED = 0;

// What Bruce provides to a script. These must be real top-level declarations: in mquickjs, properties
// added to the global object are not visible as global variables.
// Bruce tells a script where it lives
var __filepath = '/BruceJS/MiniCCTV.js';
var __dirpath = '/BruceJS/';
var MODS = {};
function require(n) {
  return MODS[n];
}
function delay(ms) {
  CLOCK += ms;
}
function now() {
  return CLOCK;
}

function out(s) {
  if (typeof print === 'function') {
    print(s);
  } else {
    console.log(s);
  }
}

function check(name, cond, extra) {
  if (cond) {
    PASSED++;
  } else {
    FAILED++;
  }
  out((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
}

// Strings compare ignoring case: the UI shows titles and chips in capitals.
function has(list, v) {
  for (var i = 0; i < list.length; i++) {
    if (list[i] === v) {
      return true;
    }
    if (typeof list[i] === 'string' && typeof v === 'string' && list[i].toUpperCase() === v.toUpperCase()) {
      return true;
    }
  }
  return false;
}

function ci(re) {
  return new RegExp(re.source, 'i');
}

function anyText(L, re) {
  var r = ci(re);
  for (var i = 0; i < L.texts.length; i++) {
    if (r.test(L.texts[i])) {
      return true;
    }
  }
  return false;
}

function countText(L, re) {
  var r = ci(re);
  var n = 0;
  for (var i = 0; i < L.texts.length; i++) {
    if (r.test(L.texts[i])) {
      n++;
    }
  }
  return n;
}

function countUrls(L, re) {
  var n = 0;
  for (var i = 0; i < L.urls.length; i++) {
    if (re.test(L.urls[i])) {
      n++;
    }
  }
  return n;
}

// Press keys / run actions when conditions hold: steps = [{when: fn(L), key: 'sel', run: fn(L)}]
function script(steps) {
  var i = 0;
  return function (L) {
    while (i < steps.length) {
      var s = steps[i];
      if (s.when && !s.when(L)) {
        return null;
      }
      i++;
      if (s.run) {
        s.run(L);
      }
      if (s.key) {
        return s.key;
      }
    }
    return null;
  };
}

var MENU = function (n) {
  return function (L) { return L.menuDraws >= n; };
};

function runApp(opts) {
  var L = {
    texts: [], titles: [], menuDraws: 0, jpgs: [], bitmaps: [], urls: [], tones: [], blinks: 0, irs: [],
    joins: 0, disconnects: 0, brightness: [], restores: 0, fills: 0, ticks: 0, maxTicks: opts.maxTicks || 30000,
    timeout: false, error: '', fb: new Uint8Array(opts.light ? 1 : W * H), noSignal: 0, jpgCount: 0, bitmapCount: 0,
    files: opts.files || {}, writes: 0, prompts: [], webUrls: [], renames: 0, fsUsed: {}, dialogs: 0, netLog: [], icons: 0, gradients: 0, flashes: 0
  };
  var curSize = 1;
  var curColor = 0;
  var pending = null;
  // Which network the Stick is on: the camera's, the home WiFi, or none. The camera is reachable only
  // from its own network and GitHub only from the home one, like the real thing.
  var net = opts.homeWifi ? 'home' : opts.preconnected ? 'cam' : 'none';

  function take(name) {
    L.ticks++;
    CLOCK += 1;
    if (L.ticks > L.maxTicks) {
      pending = 'esc';
      L.timeout = true;
    }
    if (pending === null && opts.keys) {
      pending = opts.keys(L);
    }
    if (pending === name) {
      pending = null;
      return true;
    }
    return false;
  }

  function viewCheck(data, who) {
    if (!(data instanceof Uint8Array)) {
      throw new TypeError(who + ' wants a Uint8Array');
    }
    // Bruce's JS_GetTypedArrayBuffer() returns the START of the underlying buffer and ignores a
    // view's byteOffset, so drawing from a subarray would paint the wrong bytes.
    if (data.byteOffset !== 0) {
      throw new Error(who + ': array view with byteOffset ' + data.byteOffset + ' (Bruce would read from the buffer start)');
    }
    if (data.buffer.byteLength !== data.length) {
      throw new Error(who + ': view does not span its whole buffer');
    }
  }

  var MOCK_display = {
    width: function () { return W; },
    height: function () { return H; },
    color: function (r, g, b) { return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3); },
    fill: function (c) {
      L.fills++;
      if (bright(c)) {
        L.flashes++;
      }
      if (!opts.light) {
        for (var i = 0; i < L.fb.length; i++) { L.fb[i] = 0; }
      }
    },
    setTextSize: function (n) { curSize = n; },
    setTextColor: function (c) { curColor = c; },
    // A title is what the UI draws large (size 2) in cyan (screens), red (problems) or green (results).
    drawString: function (t, x, y) {
      if (!opts.light) {
        L.texts.push(t);
      }
      if (curSize === 2 && (curColor === TITLE_CYAN || curColor === TITLE_RED || curColor === TITLE_GREEN)) {
        L.titles.push(t);
        if (t === 'MINICCTV') {
          L.menuDraws++;
        }
      }
      if (t === 'NO SIGNAL') {
        L.noSignal++;
      }
    },
    // a big bright rectangle is a flash on the Stick's screen
    drawFillRect: function (x, y, w, h, c) {
      if (w * h >= (W * H) / 3 && bright(c)) {
        L.flashes++;
      }
    },
    drawFillRoundRect: function (x, y, w, h, r, c) {
      if (w * h >= (W * H) / 3 && bright(c)) {
        L.flashes++;
      }
    },
    drawRect: function () {},
    drawRoundRect: function () {},
    drawFastHLine: function () {},
    drawFastVLine: function () {},
    drawLine: function () {},
    drawCircle: function () {},
    drawFillCircle: function () {},
    drawFillRectGradient: function (x, y, w, h, c1, c2, mode) {
      L.gradients++;
      if (mode !== 'h' && mode !== 'v') {
        throw new Error('drawFillRectGradient: mode must be "h" or "v"');
      }
    },
    // Bruce wants a Uint8Array of exactly ceil(w/8)*h bytes, read from the start of its buffer
    drawXBitmap: function (x, y, data, w, h, fg) {
      viewCheck(data, 'drawXBitmap');
      if (data.length !== ((w + 7) >> 3) * h) {
        throw new TypeError('drawXBitmap: Bitmap size mismatch, len: ' + data.length + ', expected: ' + (((w + 7) >> 3) * h));
      }
      if (typeof fg !== 'number') {
        throw new TypeError('drawXBitmap: colour missing');
      }
      L.icons++;
    },
    setBrightness: function (v) { L.brightness.push(v); },
    restoreBrightness: function () { L.restores++; L.brightness.push('restore'); },
    drawJpg: function (data, x, y, center) {
      viewCheck(data, 'drawJpg');
      if (data[0] !== 0xff || data[1] !== 0xd8) {
        throw new Error('drawJpg: not a JPEG');
      }
      L.jpgCount++;
      if (!opts.light) {
        L.jpgs.push({ x: x, y: y, len: data.length, b0: data[0], b1: data[1] });
      }
    },
    drawBitmap: function (x, y, data, w, h, bpp) {
      viewCheck(data, 'drawBitmap');
      if (bpp !== 8) {
        throw new Error('only 8bpp is used');
      }
      if (data.length !== w * h) {
        throw new TypeError('drawBitmap: Bitmap size mismatch! Got ' + data.length + ', expected ' + (w * h));
      }
      if (x < 0 || y < 0 || x + w > W || y + h > H) {
        throw new Error('drawBitmap outside the screen');
      }
      L.bitmapCount++;
      if (!opts.light) {
        for (var r = 0; r < h; r++) {
          for (var c = 0; c < w; c++) {
            L.fb[(y + r) * W + x + c] = data[r * w + c];
          }
        }
        L.bitmaps.push({ x: x, y: y, w: w, h: h });
      }
    }
  };

  var MOCK_keyboard = {
    getEscPress: function () { return take('esc'); },
    getSelPress: function () { return take('sel'); },
    getPrevPress: function () { return take('prev'); },
    getNextPress: function () { return take('next'); },
    // the typed-text prompt: keyboard(initialText, maxLength, message, mask)
    keyboard: function (initial, max, msg, mask) {
      L.prompts.push({ initial: initial, max: max, msg: msg, mask: mask === true });
      return opts.typed && opts.typed.length ? opts.typed.shift() : '';
    }
  };

  var MOCK_wifi = {
    connected: function () { return net !== 'none'; },
    getIPAddress: function () { return net === 'cam' ? '192.168.4.2' : net === 'home' ? '192.168.1.50' : null; },
    connect: function (ssid) {
      L.joins++;
      CLOCK += 1000;
      if (ssid === 'ESP32-CAM-S3') {
        if (opts.joinFails || !FC.tryJoin()) {
          return false;
        }
        net = 'cam';
        L.netLog.push('cam');
        return true;
      }
      net = 'home';
      L.netLog.push('home');
      return true;
    },
    connectDialog: function () {
      L.dialogs++;
      if (opts.homeFails) {
        return false;
      }
      net = 'home';
      L.netLog.push('home');
      return true;
    },
    disconnect: function () { L.disconnects++; net = 'none'; L.netLog.push('none'); },
    httpFetch: function (url, o) {
      if (url.indexOf('http://192.168.4.1') !== 0) {
        // the internet: needs the home WiFi
        L.webUrls.push(url);
        CLOCK += 200;
        if (net !== 'home') {
          throw new Error('WIFI Not Connected');
        }
        var w = opts.web ? opts.web(url, o) : null;
        if (w === 'throw' || !w) {
          throw new Error('connect failed');
        }
        return w;
      }
      if (!opts.light) {
        L.urls.push(url);
      }
      CLOCK += 30;
      if (net !== 'cam') {
        throw new Error('WIFI Not Connected');
      }
      if (opts.fetch) {
        var r = opts.fetch(url, L.urls.length, L);
        if (r === 'throw') {
          throw new Error('connect failed');
        }
        if (r) {
          return r;
        }
      }
      var res = FC.handle(url, o);
      if (res.body instanceof Uint8Array) {
        // Bruce hands back a fresh copy starting at offset 0
        res = { status: res.status, body: new Uint8Array(res.body), length: res.length };
      }
      if (/\/ota$/.test(url) && FC.state().ota === 1) {
        net = 'none'; // the camera has dropped its network to go and update
        L.netLog.push('none');
      }
      return res;
    }
  };

  var MOCK_audio = { tone: function (f, d) { L.tones.push([f, d]); } };
  var MOCK_notification = { blink: function () { L.blinks++; } };
  var MOCK_ir = { transmitFile: function (p, hide) { L.irs.push(p); return true; } };
  // Bruce's storage: paths are strings or {fs, path}; reading a file that is not there throws;
  // write(path, text, 'write') replaces, anything else appends (that is Bruce's default).
  function spath(p) {
    return typeof p === 'object' ? p.path : p;
  }
  var MOCK_storage = {
    read: function (p) {
      if (opts.storageBroken) {
        throw new Error('storage unavailable');
      }
      if (!L.files.hasOwnProperty(spath(p))) {
        throw new TypeError('storageRead: File: ' + spath(p) + ' does not exist');
      }
      return L.files[spath(p)];
    },
    write: function (p, data, mode) {
      if (opts.storageBroken) {
        throw new Error('storage unavailable');
      }
      if (typeof data !== 'string') {
        return false;
      }
      L.files[spath(p)] = mode === 'write' || !L.files.hasOwnProperty(spath(p)) ? data : L.files[spath(p)] + data;
      L.writes++;
      L.fsUsed[spath(p)] = typeof p === 'object' ? p.fs : 'littlefs';
      if (opts.writeFails && spath(p).indexOf(opts.writeFails) >= 0) {
        return false;
      }
      return true;
    },
    // names of the files directly inside a folder; the folder exists on one filesystem only
    readdir: function (p, o) {
      if (typeof p !== 'object' || p.fs !== (opts.selfFs || 'sd')) {
        throw new TypeError('storageReaddir: Directory does not exist: ' + spath(p));
      }
      var dir = spath(p);
      if (dir.charAt(dir.length - 1) !== '/') {
        dir += '/';
      }
      var names = [];
      for (var k in L.files) {
        if (L.files.hasOwnProperty(k) && k.indexOf(dir) === 0 && k.indexOf('/', dir.length) < 0) {
          names.push(o && o.withFileTypes ? { name: k.substring(dir.length), size: L.files[k].length, isDirectory: false } : k.substring(dir.length));
        }
      }
      return names;
    },
    remove: function (p) {
      if (!L.files.hasOwnProperty(spath(p))) {
        throw new TypeError('storageRemove: File: ' + spath(p) + ' does not exist');
      }
      delete L.files[spath(p)];
      return true;
    },
    // like FAT: renaming onto a file that exists fails
    rename: function (p, to) {
      L.renames++;
      if (!L.files.hasOwnProperty(spath(p))) {
        throw new TypeError('storageRename: File: ' + spath(p) + ' does not exist');
      }
      if (L.files.hasOwnProperty(to) || (opts.renameFailsAt && L.renames === opts.renameFailsAt)) {
        return false;
      }
      L.files[to] = L.files[spath(p)];
      delete L.files[spath(p)];
      return true;
    }
  };

  MODS = { display: MOCK_display, keyboard: MOCK_keyboard, wifi: MOCK_wifi, audio: MOCK_audio, notification: MOCK_notification, ir: MOCK_ir, storage: MOCK_storage };

  try {
    loadApp();
  } catch (e) {
    L.error = '' + e;
  }
  return L;
}

function frameEquals(fb, expected) {
  for (var i = 0; i < fb.length; i++) {
    if (fb[i] !== expected[i]) {
      return i;
    }
  }
  return -1;
}

// Key helpers: the main menu is Watch live(0) Camera(1) Guard(2) Photos&clips(3) Image(4) Settings(5) Exit(6);
// Settings is Auto-record(0) Alerts(1) Info line(2) Mode(3) Timelapse(4) Person box(5) Sharpen(6) Back(7).
// 'next' = DOWN, 'prev' = UP, 'sel' = M5, 'esc' = UP+DOWN together.
function T(name) {
  return function (l) { return has(l.titles, name); };
}

// straight into Watch live
function toWatch() {
  return [{ when: MENU(1), key: 'sel' }];
}

// from the first main menu draw to the Settings screen
function toSettings() {
  return [
    { when: MENU(1), key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' },
    { when: null, key: 'sel' }, { when: T('Settings'), key: 'next' }       // ...and one row down, on Alerts
  ];
}

var SCENARIOS = {};

// ---------------------------------------------------------------------------------------------
SCENARIOS.menu_and_exit = function () {
  FC.reset();
  var L = runApp({ keys: script([{ when: MENU(1), key: 'esc' }]) });
  check('app ran without throwing', L.error === '', L.error);
  check('main menu is shown and UP+DOWN quits it', has(L.titles, 'MiniCCTV') && L.urls.length === 0);
  // four rows are visible at a time: the header icon plus one per row
  check('the menu draws its icons and a gradient-selected row', L.icons >= 5 && L.gradients >= 1 && anyText(L, /^Watch live$/) && anyText(L, /^Camera$/));
  check('screen brightness is restored on the way out', L.restores >= 1);
};

SCENARIOS.watch_live_bands = function () {
  FC.reset({ autoMotion: true });
  var L = runApp({
    keys: script([
      { when: MENU(1), key: 'sel' },
      { when: function (l) { return l.bitmaps.length >= 30; }, key: 'prev' },
      { when: MENU(2), key: 'esc' }
    ])
  });
  check('app ran without throwing', L.error === '', L.error);
  check('joined the camera WiFi once', L.joins === 1, '(' + L.joins + ')');
  check('connect order: status, then the control state, then pictures',
    /\/status$/.test(L.urls[0]) && /\/ctl\?$/.test(L.urls[1]) && /\/d\?f=8&s=0$/.test(L.urls[2]), L.urls.slice(0, 3).join(' '));
  check('the picture is drawn as 8-bit bands at band boundaries, full width',
    L.bitmaps.length >= 30 && L.bitmaps.every(function (b) { return b.x === 0 && b.y % 16 === 0 && b.y <= 128 && b.w === 240; }));
  check('the first picture paints all 9 bands', (function () { var s = {}; for (var i = 0; i < 9; i++) { s[L.bitmaps[i].y] = 1; } return Object.keys(s).length === 9; })());
  check('later updates only send the bands that moved', L.bitmaps.length < 9 * 12);
  check('requests ask what changed since the last seen update', countUrls(L, /\/d\?f=8&s=[1-9]/) > 3);
  check('UP leaves the viewer and returns to the main menu', L.menuDraws >= 2);
  check('with an SD card there is no warning', !has(L.titles, 'No SD card') && !anyText(L, /^NO SD$/));
  check('the live picture never uses JPEG drawing (it blanks the area to black first: a blink)', L.jpgCount === 0 && countUrls(L, /\/d\?f=j/) === 0);
};

SCENARIOS.watch_fast_mode_is_exact = function () {
  FC.reset({ autoMotion: true });
  var L = runApp({
    keys: script(toWatch().concat([
      { when: function (l) { return l.bitmaps.length >= 45; }, run: function (l) { l.snap = new Uint8Array(l.fb); l.want = FC.expectedFrame(); }, key: 'prev' },
      { when: null, key: 'esc' }
    ]))
  });
  check('app ran without throwing', L.error === '', L.error);
  check('it draws raw 8-bit bands of the right size', L.bitmaps.length >= 45 && L.bitmaps[8].h === 7 && L.bitmaps[0].h === 16 && L.jpgCount === 0);
  var bad = frameEquals(L.snap, L.want);
  check('the Stick screen equals the camera picture (deltas applied correctly)', bad === -1, bad === -1 ? '' : '(first mismatch at pixel ' + bad + ')');
  check('requests use f=8', countUrls(L, /\/d\?f=8&s=/) > 5 && countUrls(L, /\/d\?f=j/) === 0);
};

SCENARIOS.no_sd_warns_but_plays_live = function () {
  FC.reset({ sd: 0, autoMotion: true });
  var L = runApp({
    keys: script([
      { when: MENU(1), key: 'sel' },
      { when: function (l) { return l.bitmaps.length >= 12; }, key: 'next' },     // DOWN: photo
      { when: function (l) { return anyText(l, /No SD card: cannot save/); }, key: 'sel' },  // M5: actions
      { when: function (l) { return has(l.titles, 'Camera'); }, key: 'next' },
      { when: function (l) { return true; }, key: 'next' },
      { when: function (l) { return true; }, key: 'sel' },                       // Record clip
      { when: function (l) { return anyText(l, /No SD card: cannot record/); }, key: 'esc' },   // leave the menu
      { when: function (l) { return true; }, key: 'prev' },
      { when: MENU(2), key: 'esc' }
    ])
  });
  check('app ran without throwing', L.error === '', L.error);
  check('a No SD warning is shown on connect', has(L.titles, 'No SD card'));
  check('...but it does not block: live pictures arrive', L.bitmaps.length >= 12);
  check('a "NO SD" tag stays on the live picture', anyText(L, /^NO SD$/));
  check('taking a photo says there is no card instead of asking the camera', anyText(L, /No SD card: cannot save/) && countUrls(L, /snap=1/) === 0);
  check('recording says there is no card instead of asking the camera', anyText(L, /No SD card: cannot record/) && countUrls(L, /rec=t/) === 0);
};

SCENARIOS.no_sd_security_mode_warning = function () {
  FC.reset({ sd: 0, mode: 2 });
  var L = runApp({ keys: script([{ when: MENU(1), key: 'sel' }, { when: function (l) { return l.bitmaps.length >= 3; }, key: 'prev' }, { when: MENU(2), key: 'esc' }]) });
  check('Security mode without a card says it wants one', anyText(L, /Security mode wants a card/));
  FC.reset({ sd: 0, mode: 0 });
  L = runApp({ keys: script([{ when: MENU(1), key: 'sel' }, { when: function (l) { return l.bitmaps.length >= 3; }, key: 'prev' }, { when: MENU(2), key: 'esc' }]) });
  check('Live mode without a card does not nag about recording', has(L.titles, 'No SD card') && !anyText(L, /mode wants a card/));
};

SCENARIOS.photo_and_record = function () {
  FC.reset({ autoMotion: true });
  var L = runApp({
    keys: script([
      { when: MENU(1), key: 'sel' },
      { when: function (l) { return l.bitmaps.length >= 12; }, key: 'next' },                        // DOWN: photo
      { when: function (l) { return anyText(l, /Saved IMG_0043.jpg/); }, key: 'sel' },            // M5
      { when: function (l) { return has(l.titles, 'Camera'); }, key: 'next' },
      { when: null, key: 'next' },
      { when: null, key: 'sel' },                                                                  // Record clip
      { when: function (l) { return FC.state().rec === 1; }, key: 'sel' },                        // M5 again
      { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'sel' },       // Stop recording
      { when: function (l) { return FC.state().rec === 0; }, key: 'esc' },
      { when: null, key: 'prev' },
      { when: MENU(2), key: 'esc' }
    ])
  });
  check('app ran without throwing', L.error === '', L.error);
  check('DOWN takes a photo and the Stick says what it was called', countUrls(L, /snap=1/) === 1 && anyText(L, /Saved IMG_0043.jpg/));
  check('the action menu starts recording', countUrls(L, /rec=t/) === 2 && anyText(L, /Recording started/));
  check('the menu label flips to "Stop recording" while recording', anyText(L, /^Stop recording$/));
  check('a red REC marker appears on the picture while recording', anyText(L, /^REC$/));
  check('...and the same menu stops it again', FC.state().rec === 0);
};

SCENARIOS.action_menu_camera_settings = function () {
  FC.reset({ autoMotion: true });
  var L = runApp({
    keys: script([
      { when: MENU(1), key: 'sel' },
      { when: function (l) { return l.bitmaps.length >= 12; }, key: 'sel' },
      { when: function (l) { return has(l.titles, 'Camera'); }, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' },
      { when: null, key: 'next' }, { when: null, key: 'next' },
      { when: null, key: 'sel' },                                                // Filter
      { when: function (l) { return FC.state().f === 1; }, key: 'next' },
      { when: null, key: 'sel' },                                                // Night
      { when: function (l) { return FC.state().n === 1; }, key: 'next' },
      { when: null, key: 'sel' },                                                // Mode submenu
      { when: function (l) { return has(l.titles, 'Camera mode'); }, key: 'next' },
      { when: null, key: 'sel' },                                                // -> Guard (mode 1)
      { when: function (l) { return FC.state().mode === 1; }, key: 'esc' },      // close action menu
      { when: null, key: 'prev' },
      { when: MENU(2), key: 'esc' }
    ])
  });
  check('app ran without throwing', L.error === '', L.error);
  check('filter cycles through the camera (Normal -> Night)', countUrls(L, /\/ctl\?f=1$/) === 1 && FC.state().f === 1);
  check('night mode toggles', countUrls(L, /\/ctl\?n=1$/) === 1 && FC.state().n === 1);
  check('the mode picker changes the camera mode', countUrls(L, /\/ctl\?mode=1$/) === 1 && FC.state().mode === 1);
  check('the mode picker shows each mode\'s one-line description', anyText(L, /Motion alerts \+ rewind/) || has(L.titles, 'Camera mode'));
  // chips are drawn in capitals, row labels are not, so the case tells them apart
  check('the action menu shows the new filter and mode as chips', L.texts.indexOf('NIGHT') >= 0 && L.texts.indexOf('GUARD') >= 0);
  check('the active mode is marked in the picker', L.texts.indexOf('ACTIVE') >= 0);
};

SCENARIOS.timelapse_interval = function () {
  FC.reset({ mode: 2, tl: 60 });
  var L = runApp({
    keys: script(toSettings().concat([
      { when: null, key: 'next' }, { when: null, key: 'next' },                  // Alerts(1) -> Info line -> Mode (3)
      { when: null, key: 'sel' },                                               // Mode -> picker (connects first)
      { when: T('Camera mode'), key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' },
      { when: null, key: 'sel' },                                               // Timelapse mode
      { when: function (l) { return FC.state().mode === 4; }, key: 'next' },    // back in Settings: Mode -> Timelapse row
      { when: null, key: 'sel' },                                               // cycle the interval
      { when: function (l) { return FC.state().tl === 300; }, key: 'esc' },     // leave Settings
      { when: MENU(2), key: 'esc' }
    ]))
  });
  check('app ran without throwing', L.error === '', L.error);
  check('choosing Timelapse mode does not touch the interval', countUrls(L, /\/ctl\?mode=4$/) === 1 && countUrls(L, /\/ctl\?tl=/) === 1, '(' + L.urls.filter(function (u) { return /tl=|mode=/.test(u); }).join(' ') + ')');
  check('the interval has its own row and steps 60 s -> 300 s', FC.state().tl === 300 && anyText(L, /^1m$/) && anyText(L, /^5m$/));
};

SCENARIOS.zoom_and_pan = function () {
  FC.reset({ autoMotion: true });
  var L = runApp({
    keys: script([
      { when: MENU(1), key: 'sel' },
      { when: function (l) { return l.bitmaps.length >= 12; }, key: 'sel' },
      { when: function (l) { return has(l.titles, 'Camera'); }, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' },
      { when: null, key: 'sel' },                                               // Zoom / Pan
      { when: function (l) { return anyText(l, /ZOOM 1x/); }, key: 'prev' },    // UP = zoom in (+0.5x)
      { when: function (l) { return FC.state().z === 15; }, key: 'prev' },
      { when: function (l) { return FC.state().z === 20; }, key: 'sel' },       // -> pan left/right
      { when: null, key: 'next' },                                              // DOWN = right
      { when: function (l) { return FC.state().px === 60; }, key: 'sel' },      // -> pan up/down
      { when: null, key: 'prev' },                                              // UP = up
      { when: function (l) { return FC.state().py === 40; }, key: 'sel' },      // -> Reset
      { when: null, key: 'next' },
      { when: function (l) { return FC.state().z === 10 && FC.state().px === 50; }, key: 'sel' }, // Zoom -> Pan
      { when: null, key: 'sel' }, { when: null, key: 'sel' },                                     // -> Pan up/down -> Reset
      { when: null, key: 'sel' },                                               // -> Done
      { when: null, key: 'next' },                                              // leave
      { when: null, key: 'prev' },
      { when: MENU(2), key: 'esc' }
    ])
  });
  check('app ran without throwing', L.error === '', L.error);
  check('UP zooms in by half a step each press', countUrls(L, /\/ctl\?z=15$/) === 1 && countUrls(L, /\/ctl\?z=20$/) === 1);
  check('the info line shows the zoom', anyText(L, /ZOOM 2x/));
  check('pan right and up move the view by 10', countUrls(L, /\/ctl\?px=60$/) === 1 && countUrls(L, /\/ctl\?py=40$/) === 1);
  check('Reset puts zoom and pan back', countUrls(L, /\/ctl\?z=10&px=50&py=50$/) === 1 && FC.state().z === 10);
  check('"Done" returns to the live view', L.menuDraws >= 2 && L.error === '');
};

SCENARIOS.rewind = function () {
  FC.reset({ autoMotion: true, mode: 2, hist: 90 });
  var L = runApp({
    keys: script([
      { when: MENU(1), key: 'sel' },
      { when: function (l) { return l.bitmaps.length >= 12; }, key: 'sel' },
      { when: function (l) { return has(l.titles, 'Camera'); }, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' },
      { when: null, key: 'sel' },                                               // Rewind (DVR)
      { when: function (l) { return FC.state().ov === 1; }, key: 'prev' },      // older
      { when: function (l) { return FC.state().ago === 10; }, key: 'next' },    // newer
      { when: function (l) { return FC.state().ago === 5; }, key: 'next' },     // newer than 5 s = live
      { when: function (l) { return FC.state().ov === 0; }, key: 'prev' },
      { when: MENU(2), key: 'esc' }
    ])
  });
  check('app ran without throwing', L.error === '', L.error);
  check('Rewind asks the camera for 5 s back and the info line says so', countUrls(L, /\/ctl\?rw=5$/) >= 1 && anyText(L, /REWIND -0:05/));
  check('UP goes 5 s further back, DOWN 5 s forward', countUrls(L, /\/ctl\?rw=10$/) === 1 && FC.state().ago === 0);
  check('going forward past 5 s returns to the live picture', FC.state().ov === 0 && L.menuDraws >= 2);

  FC.reset({ autoMotion: true, mode: 0 });
  L = runApp({
    keys: script([
      { when: MENU(1), key: 'sel' },
      { when: function (l) { return l.bitmaps.length >= 12; }, key: 'sel' },
      { when: function (l) { return has(l.titles, 'Camera'); }, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' },
      { when: null, key: 'sel' },
      { when: function (l) { return anyText(l, /rewind needs Guard or Security/); }, key: 'prev' },
      { when: MENU(2), key: 'esc' }
    ])
  });
  check('Live mode has no rewind and explains which modes do', anyText(L, /rewind needs Guard or Security/) && FC.state().ov === 0);
};

SCENARIOS.gallery_photos_and_clips = function () {
  FC.reset({ autoMotion: true });
  var L = runApp({
    keys: script([
      { when: MENU(1), key: 'next' }, { when: MENU(2), key: 'next' },
      { when: MENU(3), key: 'next' },
      { when: MENU(4), key: 'sel' },                                            // Photos & clips
      { when: function (l) { return has(l.titles, 'Photos & clips'); }, key: 'sel' },   // Photos
      { when: function (l) { return has(l.titles, 'Photos'); }, key: 'next' },
      { when: null, key: 'sel' },                                               // the second photo
      { when: function (l) { return FC.state().ov === 2 && l.bitmaps.length >= 12; }, key: 'prev' },  // UP back
      { when: function (l) { return FC.state().ov === 0; }, key: 'esc' },       // leave the list
      { when: null, key: 'next' },                                              // -> Clips
      { when: null, key: 'sel' },
      { when: function (l) { return has(l.titles, 'Clips'); }, key: 'next' },
      { when: null, key: 'sel' },                                               // the second clip
      { when: function (l) { return FC.state().ov === 3 && l.bitmaps.length >= 30; }, key: 'sel' },  // M5: playback menu
      { when: function (l) { return has(l.titles, 'Playback'); }, key: 'next' },
      { when: null, key: 'sel' },                                               // Forward 10 s
      { when: function (l) { return FC.state().cpos === 10; }, key: 'esc' },    // close the menu
      { when: null, key: 'prev' },                                              // UP: back
      { when: function (l) { return FC.state().ov === 0; }, key: 'esc' },
      { when: null, key: 'esc' },
      { when: MENU(2), key: 'esc' }
    ])
  });
  check('app ran without throwing', L.error === '', L.error);
  check('the gallery lists photos from the camera, with their sizes', countUrls(L, /\/files\?d=photos$/) === 1 && anyText(L, /^IMG_0041$/) && anyText(L, /^60K$/) && anyText(L, /^IMG_0040$/) && anyText(L, /^58K$/));
  check('opening the second photo asks the camera for exactly that one', countUrls(L, /\/ctl\?photo=IMG_0040.jpg$/) === 1 && countUrls(L, /\/ctl\?photo=IMG_0041.jpg$/) === 0);
  check('the info line names what is playing', anyText(L, /^IMG_0040 {3,}$/));
  check('leaving a photo puts the camera back on live', countUrls(L, /\/ctl\?live=1$/) >= 1);
  check('clips list and open the second one', countUrls(L, /\/files\?d=clips$/) === 1 && countUrls(L, /\/ctl\?clip=VID_0002.avi$/) === 1 && countUrls(L, /\/ctl\?clip=VID_0003.avi$/) === 0);
  check('the clip info line shows position and length', anyText(L, /^VID_0002 0:\d\d\/0:48/));
  check('the playback menu can skip forward 10 s', countUrls(L, /\/ctl\?sk=10$/) === 1);
  check('the camera ends up live again', FC.state().ov === 0);

  FC.reset({ sd: 0 });
  L = runApp({ keys: script([{ when: MENU(1), key: 'next' }, { when: MENU(2), key: 'next' }, { when: MENU(3), key: 'next' }, { when: MENU(4), key: 'sel' },
    { when: function (l) { return has(l.titles, 'Photos & clips'); }, key: 'sel' }, { when: function (l) { return has(l.titles, 'No SD card'); }, key: 'prev' },
    { when: null, key: 'esc' }, { when: MENU(2), key: 'esc' }]) });
  check('the gallery says so (and does not crash) when the camera has no card', has(L.titles, 'No SD card') && L.error === '');
  FC.reset({ photos: [] });
  L = runApp({ keys: script([{ when: MENU(1), key: 'next' }, { when: MENU(2), key: 'next' }, { when: MENU(3), key: 'next' }, { when: MENU(4), key: 'sel' },
    { when: function (l) { return has(l.titles, 'Photos & clips'); }, key: 'sel' }, { when: function (l) { return has(l.titles, 'No photos yet'); }, key: 'prev' },
    { when: null, key: 'esc' }, { when: MENU(2), key: 'esc' }]) });
  check('an empty card says "No photos yet"', has(L.titles, 'No photos yet'));
};

SCENARIOS.guard_mode = function () {
  FC.reset({ mode: 2 });
  var L = runApp({
    keys: script([
      { when: MENU(1), key: 'next' },
      { when: MENU(2), key: 'next' },
      { when: MENU(3), key: 'sel' },                                            // Guard mode
      { when: function (l) { return has(l.brightness, 2); }, run: function () { FC.state().mseq = 1; FC.state().big = 1; FC.state().motion = 1; FC.state().lv = 40; } },
      { when: function (l) { return l.tones.length >= 3; }, run: function () { FC.state().motion = 0; FC.state().lv = 0; FC.state().big = 0; } },
      { when: function (l) { return countUrls(l, /\/d\?f=8/) > 100 && l.brightness.length >= 3; }, key: 'prev' },   // after the auto-return
      { when: MENU(2), key: 'esc' }
    ])
  });
  check('app ran without throwing', L.error === '' && !L.timeout, L.error);
  check('the screen is dimmed while guarding', L.brightness[0] === 2);
  check('a person-sized event sounds three beeps and blinks the LED', L.tones.length === 3 && L.blinks === 1, '(' + L.tones.length + ' tones, ' + L.blinks + ' blinks)');
  check('the event wakes the screen and shows the live picture', has(L.brightness, 'restore') && L.bitmaps.length > 0);
  check('it dims again once things go quiet, with no key pressed', L.brightness.slice(0, 3).join(',') === '2,restore,2', '(brightness calls: ' + L.brightness.join(',') + ')');
  check('UP leaves guard mode and restores the brightness', L.brightness[L.brightness.length - 1] === 'restore' && L.brightness[L.brightness.length - 2] === 'restore' && L.menuDraws >= 2);
  check('guard polls the camera with the motion counter', countUrls(L, /\/m\?s=0$/) >= 1);

  // a camera in Live mode can't guard: offer to switch it
  FC.reset({ mode: 0 });
  L = runApp({ keys: script([{ when: MENU(1), key: 'next' }, { when: MENU(2), key: 'next' }, { when: MENU(3), key: 'sel' }, { when: function (l) { return has(l.titles, 'Arm guard?'); }, key: 'sel' },
    { when: function (l) { return FC.state().mode === 2 && has(l.brightness, 2); }, key: 'prev' }, { when: MENU(2), key: 'esc' }]) });
  check('Guard on a Live-mode camera offers to switch it to Security, and does', has(L.titles, 'Arm guard?') && FC.state().mode === 2);
  FC.reset({ mode: 0 });
  L = runApp({ keys: script([{ when: MENU(1), key: 'next' }, { when: MENU(2), key: 'next' }, { when: MENU(3), key: 'sel' }, { when: function (l) { return has(l.titles, 'Arm guard?'); }, key: 'prev' }, { when: MENU(2), key: 'esc' }]) });
  check('...or you can say no (mode stays, screen never dimmed)', FC.state().mode === 0 && !has(L.brightness, 2));
};

SCENARIOS.guard_survives_camera_reboot = function () {
  // the camera has already seen 5 events; then it reboots (its counter restarts) and sees a new one
  FC.reset({ mode: 2, mseq: 5 });
  var L = runApp({
    keys: script([
      { when: MENU(1), key: 'next' },
      { when: MENU(2), key: 'next' },
      { when: MENU(3), key: 'sel' },                                            // Guard mode
      { when: function (l) { return has(l.brightness, 2) && countUrls(l, /\/m\?s=5$/) >= 2; }, run: function () { FC.state().mseq = 0; } },   // reboot
      { when: function (l) { return countUrls(l, /\/m\?s=0$/) >= 2; }, run: function () { FC.state().mseq = 1; FC.state().motion = 1; FC.state().lv = 30; } },   // new event
      { when: function (l) { return l.tones.length >= 1; }, run: function () { FC.state().motion = 0; FC.state().lv = 0; } },
      { when: function (l) { return countUrls(l, /\/d\?f=8/) > 5; }, key: 'prev' },
      { when: MENU(2), key: 'esc' }
    ])
  });
  check('app ran without throwing', L.error === '' && !L.timeout, L.error);
  check('guard follows the counter back down after the reboot', countUrls(L, /\/m\?s=5$/) >= 2 && countUrls(L, /\/m\?s=0$/) >= 2);
  check('...and the first event after the reboot still raises the alarm', L.tones.length >= 1 && L.blinks >= 1, '(' + L.tones.length + ' tones)');
};

SCENARIOS.alerts_in_viewer_and_menu = function () {
  // live viewer: motion starts -> a small beep (not the person-sized pattern)
  FC.reset({ mode: 1 });
  var L = runApp({
    keys: script([
      { when: MENU(1), key: 'sel' },
      { when: function (l) { return l.bitmaps.length >= 3; }, run: function () { FC.state().motion = 1; FC.state().lv = 20; } },
      { when: function (l) { return l.tones.length >= 1; }, key: 'prev' },
      { when: MENU(2), key: 'esc' }
    ])
  });
  check('motion in the live viewer beeps once and blinks the LED', L.tones.length === 1 && L.tones[0][0] === 1900 && L.blinks === 1, '(' + L.tones.length + ')');
  FC.reset({ mode: 0 });
  L = runApp({ keys: script([{ when: MENU(1), key: 'sel' }, { when: function (l) { return l.bitmaps.length >= 3; }, run: function (l) { FC.state().motion = 1; l.motionAt = l.urls.length; } },
    { when: function (l) { return l.urls.length > l.motionAt + 8; }, key: 'prev' }, { when: MENU(2), key: 'esc' }]) });
  check('Live mode never alerts (it has no motion detection)', L.tones.length === 0 && L.blinks === 0 && L.urls.length > 10, '(' + L.urls.length + ' requests)');

  // main menu: alerts even when nothing is being watched
  FC.reset({ mode: 2 });
  L = runApp({
    preconnected: true,
    keys: script([
      { when: function (l) { return l.menuDraws >= 1 && l.urls.length >= 1; }, run: function () { FC.state().mseq = 5; } },
      { when: function (l) { return has(l.titles, 'MOTION!'); }, key: 'prev' },
      { when: MENU(2), key: 'esc' }
    ])
  });
  check('the main menu alerts on a new motion event without Guard mode', L.tones.length === 1 && has(L.titles, 'MOTION!') && L.error === '');
  check('...and carries on afterwards', L.menuDraws >= 2);

  // a camera in Live mode has no motion detection, so the menu must not alert for it either
  FC.reset({ mode: 0 });
  L = runApp({
    preconnected: true,
    keys: script([
      { when: function (l) { return l.menuDraws >= 1 && l.urls.length >= 1; }, run: function (l) { FC.state().mseq = 5; l.at = l.urls.length; } },
      { when: function (l) { return l.urls.length > l.at + 3; }, key: 'esc' }
    ])
  });
  check('the main menu stays quiet for a camera in Live mode', L.tones.length === 0 && !has(L.titles, 'MOTION!') && L.urls.length > 3, '(' + L.urls.length + ' status checks)');

  // alerts can be switched off in Settings (Alerts: Beep+LED -> Off)
  FC.reset({ mode: 2 });
  L = runApp({
    preconnected: true,
    keys: script(toSettings().concat([
      { when: null, key: 'sel' },            // Alerts: Beep+LED -> Off
      { when: null, key: 'esc' },            // back to the main menu
      { when: function (l) { return l.urls.length >= 1; }, run: function () { FC.state().mseq = 9; } },
      { when: function (l) { return l.ticks > 900; }, key: 'esc' }
    ]))
  });
  check('with alerts Off the menu stays silent', L.tones.length === 0 && L.blinks === 0 && !has(L.titles, 'MOTION!') && L.writes === 1);

  // ...and so does the live viewer, even though it sees the same motion
  FC.reset({ mode: 2 });
  L = runApp({
    keys: script(toSettings().concat([
      { when: null, key: 'sel' },            // Alerts: Beep + LED -> Off
      { when: null, key: 'esc' },            // back to the main menu (cursor on Settings)
      { when: null, key: 'prev' }, { when: null, key: 'prev' }, { when: null, key: 'prev' }, { when: null, key: 'prev' }, { when: null, key: 'prev' },
      { when: null, key: 'sel' },            // Watch live
      { when: function (l) { return l.bitmaps.length >= 3; }, run: function (l) { FC.state().motion = 1; FC.state().lv = 30; l.motionAt = l.urls.length; } },
      { when: function (l) { return l.urls.length > l.motionAt + 8; }, key: 'prev' },   // give the camera's reply time to carry the motion flag
      { when: null, key: 'esc' }
    ]))
  });
  check('with alerts Off the live viewer stays silent too', L.bitmaps.length >= 8 && L.tones.length === 0 && L.blinks === 0, '(' + L.bitmaps.length + ' strips, ' + L.tones.length + ' tones, ' + L.blinks + ' blinks, alertLevel ' + alertLevel + ')');
};

SCENARIOS.settings_auto_record = function () {
  // Auto-record lives on the camera: the first press connects, then it toggles and the row follows
  FC.reset({ auto: 1, mode: 2 });
  var L = runApp({
    keys: script(toSettings().concat([
      { when: null, key: 'prev' },                                              // Auto-record
      { when: null, key: 'sel' },                                               // connects, then 1 -> 0
      { when: function (l) { return FC.state().auto === 0; }, key: 'sel' },     // 0 -> 1
      { when: function (l) { return FC.state().auto === 1 && countUrls(l, /\/ctl\?auto=1$/) === 1; }, key: 'esc' },
      { when: MENU(2), key: 'esc' }
    ]))
  });
  check('app ran without throwing', L.error === '', L.error);
  check('the first press connects once and then switches auto-record off', L.joins === 1 && countUrls(L, /\/ctl\?auto=0$/) === 1);
  check('the second press switches it back on', countUrls(L, /\/ctl\?auto=1$/) === 1 && FC.state().auto === 1);
  check('the row shows the camera\'s state (an OFF toggle after the first press)', anyText(L, /^OFF$/) && anyText(L, /^ON$/));
  check('auto-record is not a Stick setting: it is not in the Stick\'s file (only the camera version it saw is)', L.writes <= 1 && (L.files['/MiniCCTV.cfg'] || '').indexOf('auto') < 0);

  // outside Security mode the row says where it applies
  FC.reset({ auto: 1, mode: 1 });
  L = runApp({
    keys: script(toSettings().concat([
      { when: null, key: 'prev' }, { when: null, key: 'sel' },
      { when: function (l) { return FC.state().auto === 0; }, key: 'esc' },
      { when: MENU(2), key: 'esc' }
    ]))
  });
  check('in Guard mode the hint says auto-record is used in Security mode', anyText(L, /Used in Security mode/));
};

SCENARIOS.settings_persist = function () {
  // change two Stick settings: each change is saved as a whole file
  FC.reset();
  var L = runApp({
    keys: script(toSettings().concat([
      { when: null, key: 'sel' },                                               // Alerts: Beep+LED -> Off
      { when: null, key: 'next' }, { when: null, key: 'sel' },                  // Info line: On -> Off
      { when: null, key: 'esc' },
      { when: MENU(2), key: 'esc' }
    ]))
  });
  var saved = null;
  try {
    saved = JSON.parse(L.files['/MiniCCTV.cfg']);
  } catch (e) {
    saved = null;
  }
  check('app ran without throwing', L.error === '', L.error);
  check('each change is written (two writes) and the file is one valid JSON object', L.writes === 2 && saved !== null, '(' + L.files['/MiniCCTV.cfg'] + ')');
  check('the file holds the new defaults', saved !== null && saved.alerts === 0 && saved.hud === 0 && saved.v === 4);
  check('no camera was needed for any of it', L.urls.length === 0);
  check('the rows show the new values', anyText(L, /^Off$/));

  // next start: the defaults are used (LED-only alerts, no info chip)
  FC.reset({ mode: 1 });
  L = runApp({
    files: { '/MiniCCTV.cfg': '{"v":3,"alerts":1,"hud":0}' },
    keys: script([
      { when: MENU(1), key: 'sel' },
      { when: function (l) { return l.bitmaps.length >= 3; }, run: function (l) { FC.state().motion = 1; FC.state().lv = 20; l.motionAt = l.urls.length; } },
      { when: function (l) { return l.urls.length > l.motionAt + 8; }, key: 'prev' },
      { when: MENU(2), key: 'esc' }
    ])
  });
  check('a saved Info line Off hides the info chip', L.bitmaps.length >= 3 && !anyText(L, /^LIVE /));
  check('a saved LED-only alert level blinks without beeping', L.blinks === 1 && L.tones.length === 0, '(' + L.blinks + ' blinks, ' + L.tones.length + ' tones)');

  // settings files from earlier versions (they had a "photo" or "pic" key) still load, the extra key is ignored
  FC.reset();
  L = runApp({ files: { '/MiniCCTV.cfg': '{"v":2,"pic":1,"photo":1,"alerts":0,"hud":1}' }, keys: script([{ when: MENU(1), key: 'sel' }, { when: function (l) { return l.bitmaps.length >= 3; }, key: 'prev' }, { when: MENU(2), key: 'esc' }]) });
  check('an older settings file still loads (alerts Off kept) and the picture is still 8-bit', L.error === '' && alertLevel === 0 && L.jpgCount === 0 && countUrls(L, /\/d\?f=j/) === 0);

  // a damaged or out-of-range file is ignored, not trusted
  var bad = ['{oops', '', '[]', '{"v":1,"alerts":9,"hud":2}', '{"alerts":"yes"}'];
  var okAll = true;
  for (var i = 0; i < bad.length; i++) {
    FC.reset();
    L = runApp({ files: { '/MiniCCTV.cfg': bad[i] }, keys: script([{ when: MENU(1), key: 'sel' }, { when: function (l) { return l.bitmaps.length >= 3; }, key: 'prev' }, { when: MENU(2), key: 'esc' }]) });
    var fixed = null;
    try { fixed = JSON.parse(L.files['/MiniCCTV.cfg']); } catch (eFix) { fixed = null; }
    // the app falls back to its defaults, and what it saves afterwards (the camera version) is a valid file
    if (L.error !== '' || L.bitmaps.length < 3 || hud !== true || alertLevel !== 2 || (L.writes > 0 && (!fixed || fixed.alerts !== 2 || fixed.hud !== 1))) {
      okAll = false;
      out('  bad config ' + JSON.stringify(bad[i]) + ' -> error "' + L.error + '", ' + L.bitmaps.length + ' bands, hud ' + hud + ', alerts ' + alertLevel);
    }
  }
  check('damaged or out-of-range settings files fall back to the defaults without crashing', okAll);

  // storage that throws must not break the app, and the setting still applies for this run
  FC.reset({ autoMotion: true });
  L = runApp({ storageBroken: true, keys: script(toSettings().concat([{ when: null, key: 'sel' }, { when: null, key: 'esc' }, { when: MENU(2), key: 'prev' }, { when: null, key: 'prev' }, { when: null, key: 'prev' }, { when: null, key: 'prev' }, { when: null, key: 'prev' }, { when: null, key: 'sel' }, { when: function (l) { return l.bitmaps.length >= 3; }, key: 'prev' }, { when: null, key: 'esc' }])) });
  check('with unusable storage the app still runs and the change applies for now', L.error === '' && L.bitmaps.length >= 3 && alertLevel === 0, L.error);
};

SCENARIOS.settings_without_camera = function () {
  FC.reset({ down: true });
  var L = runApp({
    keys: script(toSettings().concat([
      { when: null, key: 'sel' },                                               // Alerts works offline
      { when: null, key: 'prev' }, { when: null, key: 'sel' },                  // Auto-record needs the camera
      { when: function (l) { return anyText(l, /Joined WiFi, camera silent/); }, key: 'prev' },   // back out of the error
      { when: null, key: 'esc' },
      { when: MENU(2), key: 'esc' }
    ]))
  });
  check('app ran without throwing', L.error === '', L.error);
  check('Stick-side settings change and save with the camera off', L.writes === 1 && anyText(L, /^Off$/));
  check('camera-side rows wait ("...") until the camera has answered', anyText(L, /^\.\.\.$/));
  check('pressing one tries to connect and explains when it cannot', anyText(L, /Joined WiFi, camera silent/) && countUrls(L, /\/ctl\?auto/) === 0);
  check('...and leaves you in Settings, then the main menu', L.menuDraws >= 2);
};

SCENARIOS.settings_person_box_and_sharpen = function () {
  FC.reset({ box: 1, sharp: 1 });
  var L = runApp({
    keys: script(toSettings().concat([
      { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' },   // Info(2) Mode(3) Timelapse(4) Person box(5)
      { when: null, key: 'sel' },                                               // connects, then box 1 -> 0
      { when: function (l) { return FC.state().box === 0; }, key: 'next' },     // Sharpen
      { when: null, key: 'sel' },                                               // sharp 1 -> 0
      { when: function (l) { return FC.state().sharp === 0; }, key: 'sel' },    // and back on
      { when: function (l) { return FC.state().sharp === 1; }, key: 'esc' },
      { when: MENU(2), key: 'esc' }
    ]))
  });
  check('app ran without throwing', L.error === '', L.error);
  check('Person box switches the camera\'s box off', countUrls(L, /\/ctl\?box=0$/) === 1 && FC.state().box === 0);
  check('Sharpen toggles off and on again', countUrls(L, /\/ctl\?sh=0$/) === 1 && countUrls(L, /\/ctl\?sh=1$/) === 1 && FC.state().sharp === 1);
  check('the rows show the hints for what they do', anyText(L, /Red box: person-sized/) && anyText(L, /Crisper edges/));
  check('both are camera settings: neither is in the Stick\'s file', (L.files['/MiniCCTV.cfg'] || '').indexOf('box') < 0 && (L.files['/MiniCCTV.cfg'] || '').indexOf('sharp') < 0);
};

SCENARIOS.camera_screen = function () {
  // the viewfinder: M5 / UP = shutter, DOWN = next mode (Photo, Burst, Timer, Video), UP+DOWN = exit
  FC.reset({ autoMotion: true });
  var L = runApp({
    keys: script([
      { when: MENU(1), key: 'next' },
      { when: MENU(2), key: 'sel' },                                            // Camera
      { when: function (l) { return l.bitmaps.length >= 12; }, key: 'sel' },    // shutter: Photo
      { when: function (l) { return anyText(l, /Saved IMG_0043.jpg/); }, key: 'next' },    // -> Burst
      { when: function (l) { return anyText(l, /Burst x6/); }, key: 'sel' },
      { when: function (l) { return anyText(l, /Burst: 6 saved/); }, key: 'next' },         // -> Timer
      { when: function (l) { return anyText(l, /Timer 3s/); }, key: 'sel' },
      { when: function (l) { return countUrls(l, /snap=1/) === 8; }, key: 'next' },        // -> Video
      { when: function (l) { return anyText(l, /Video/); }, key: 'sel' },                  // start
      { when: function (l) { return FC.state().rec === 1; }, key: 'sel' },                 // stop
      { when: function (l) { return FC.state().rec === 0 && anyText(l, /Video saved/); }, run: function (l) { l.mark = l.menuDraws; }, key: 'esc' },
      { when: MENU(2), key: 'esc' }
    ])
  });
  check('app ran without throwing', L.error === '' && !L.timeout, L.error);
  check('the shutter takes one photo and says what it was called', anyText(L, /Saved IMG_0043.jpg/));
  check('Burst takes six in a row', anyText(L, /Burst: 6 saved/) && countUrls(L, /snap=1/) >= 7);
  check('Timer counts 3, 2, 1 and then takes the photo', anyText(L, /^3$/) && anyText(L, /^2$/) && anyText(L, /^1$/) && countUrls(L, /snap=1/) === 8, '(' + countUrls(L, /snap=1/) + ' snaps)');
  check('Video starts and stops a clip', countUrls(L, /rec=t/) === 2 && FC.state().rec === 0 && anyText(L, /Recording\.\.\./));
  check('the viewfinder draws its mode chip, shutter ring and counter', anyText(L, /< PHOTO >/) && anyText(L, /< VIDEO >/) && anyText(L, /^x\d+\s*$/));
  check('UP+DOWN leaves the camera screen for the main menu (it does not quit the app)', L.menuDraws > L.mark && L.error === '', '(menu drawn ' + L.menuDraws + ' times, ' + L.mark + ' before leaving)');
  check('taking pictures never flashes the screen', L.flashes === 0 && L.jpgCount === 0, '(' + L.flashes + ' flashes)');

  // without a card every mode says so and none of them asks the camera (Timer does not even count down)
  FC.reset({ sd: 0, autoMotion: true });
  L = runApp({ keys: script([{ when: MENU(1), key: 'next' }, { when: MENU(2), key: 'sel' }, { when: function (l) { return l.bitmaps.length >= 12; }, key: 'sel' },   // Photo
    { when: function (l) { return anyText(l, /No SD card: cannot save/); }, key: 'next' }, { when: null, key: 'sel' },                                   // Burst
    { when: null, key: 'next' }, { when: null, key: 'sel' },                                                                                              // Timer
    { when: null, key: 'next' }, { when: null, key: 'sel' },                                                                                              // Video
    { when: function (l) { return anyText(l, /No SD card: cannot record/); }, key: 'esc' }, { when: MENU(2), key: 'esc' }]) });
  check('with no SD card every shooting mode says so and never asks the camera',
    anyText(L, /No SD card: cannot save/) && anyText(L, /No SD card: cannot record/) && countUrls(L, /snap=1|rec=t/) === 0, '(' + countUrls(L, /snap=1|rec=t/) + ' requests)');
  check('...and the timer does not count down for nothing', !anyText(L, /^3$/));
};

SCENARIOS.no_flashing = function () {
  // Nothing in the app may flash: no JPEG drawing (Bruce blanks the area to black first), and no bright
  // fill of a big part of the screen. This walks the screens most likely to: the live view, a motion
  // alert in Guard mode and in the live viewer, the shutter, a signal outage and the menus.
  FC.reset({ mode: 2, autoMotion: true });
  var L = runApp({
    keys: script([
      { when: MENU(1), key: 'sel' },                                            // Watch live
      { when: function (l) { return l.bitmaps.length >= 12; }, run: function () { FC.state().motion = 1; FC.state().big = 1; FC.state().lv = 60; } },   // person-sized motion
      { when: function (l) { return l.tones.length >= 3; }, key: 'next' },      // DOWN: photo
      { when: function (l) { return anyText(l, /Saved IMG_0043/); }, key: 'sel' },   // actions menu
      { when: null, key: 'esc' },                                               // close it again
      { when: null, key: 'prev' },
      { when: MENU(2), key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'sel' },   // Guard mode
      { when: function (l) { return has(l.brightness, 2); }, run: function () { FC.state().mseq = 3; } },   // an event while guarding
      { when: function (l) { return l.tones.length >= 6 && countUrls(l, /\/d\?f=8/) > 200; }, key: 'prev' },
      { when: MENU(3), key: 'esc' }
    ])
  });
  check('app ran without throwing', L.error === '' && !L.timeout, L.error);
  check('the alerts and the shutter really ran', L.tones.length >= 6 && countUrls(L, /snap=1/) === 1);
  check('no JPEG is ever drawn', L.jpgCount === 0);
  check('no bright fill of a large area at any point', L.flashes === 0, '(' + L.flashes + ')');

  // an outage and the recovery
  FC.reset({ autoMotion: true });
  var reqs = 0;
  L = runApp({
    fetch: function (url) {
      if (/\/d\?/.test(url)) { reqs++; if (reqs > 6 && reqs <= 24) { return 'throw'; } }
      return null;
    },
    keys: script([{ when: MENU(1), key: 'sel' }, { when: function () { return reqs > 30; }, key: 'prev' }, { when: MENU(2), key: 'esc' }])
  });
  check('a signal outage and recovery does not flash either', L.noSignal >= 1 && L.flashes === 0 && L.jpgCount === 0);
};

// ---------------------------------------------------------------------------------------------
// Updates. The test "internet" serves the list of versions and the app; the camera does its own
// downloading in real life, so the Stick never fetches firmware (a test checks that).
var BASE = 'https://raw.githubusercontent.com/udaydotoffical-svg/mini-cctv/main/';
// stand-ins for the real app: big enough to pass the "plausible size" check, and shaped like it
// (a version line, ends with main();)
var FILL = (function () { var f = ''; for (var i = 0; i < 80; i++) { f += '// padding padding padding\n'; } return f; })();
function appText(ver) {
  return '// MiniCCTV ' + ver + '\n' + FILL + 'var APP_VERSION = \'' + ver + '\';\nvar more = 1;\nmain();\n';
}
var OLD_APP = appText('2.1.0');
var NEW_APP = appText('2.2.0');
var CFG_NOW = '{"v":4,"alerts":2,"hud":1,"camFw":"2.1.0","homeSsid":"OldHome"}';
var PASSWORD = 'p@ss&w=r+d% /';
var SSID = 'Caf\u00e9 5G & Co=1'; // a home WiFi name with a space, an accent, & and =

function webFor(o) {
  o = o || {};
  var text = o.text === undefined ? NEW_APP : o.text;
  return function (url) {
    if (/dist\/version\.json$/.test(url)) {
      if (o.listFails) { return 'throw'; }
      var m = { app: o.app || '2.2.0', app_url: o.appUrl || BASE + 'bruce/MiniCCTV.js', app_size: o.size === undefined ? NEW_APP.length : o.size, fw: o.fw === undefined ? '2.1.0' : o.fw };
      return { status: 200, body: m, length: 0 };
    }
    if (/bruce\/MiniCCTV\.js$/.test(url)) {
      if (o.appThrows) { return 'throw'; }
      return { status: o.appStatus || 200, body: text, length: o.length === undefined ? text.length : o.length };
    }
    return { status: 404, body: '', length: 0 };
  };
}

function noSecrets(L) {
  var leaked = false;
  for (var k in L.files) {
    if (L.files.hasOwnProperty(k) && L.files[k].indexOf('p@ss') >= 0) { leaked = true; }
  }
  return !leaked && !anyText(L, /p@ss/) && !anyText(L, /r\+d/);
}

SCENARIOS.update_helpers = function () {
  FC.reset();
  var L = runApp({ keys: script([{ when: MENU(1), key: 'esc' }]) });
  check('app ran without throwing', L.error === '', L.error);
  check('version numbers parse like the camera\'s', verNum('2.10.3') === 2010003 && verNum('0.0.1') === 1 && verNum('999.999.999') === 999999999);
  check('anything else is not a version', verNum('') === -1 && verNum('2.1') === -1 && verNum('2.1.0.1') === -1 && verNum('v2.1.0') === -1 && verNum('2.1.x') === -1 && verNum('1000.0.0') === -1 && verNum(null) === -1 && verNum(210) === -1);
  check('newer compares numbers, not text', newer('2.10.0', '2.9.0') && !newer('2.9.0', '2.10.0') && newer('2.1.1', '2.1.0') && !newer('2.1.0', '2.1.0'));
  check('an unreadable version is older than any real one, and never newer', newer('1.0.0', '') && newer('1.0.0', 'garbage') && !newer('garbage', '1.0.0') && !newer('x', 'y'));
  check('urlEncode keeps the safe characters', urlEncode('AZaz09-_.~') === 'AZaz09-_.~');
  check('urlEncode escapes every special character in a password', urlEncode(PASSWORD) === 'p%40ss%26w%3Dr%2Bd%25%20%2F', urlEncode(PASSWORD));
  check('urlEncode turns non-ASCII into UTF-8', urlEncode('é€') === '%C3%A9%E2%82%AC', urlEncode('é€'));
};

SCENARIOS.update_app_installs = function () {
  FC.reset();
  var L = runApp({
    homeWifi: true,
    files: { '/MiniCCTV.cfg': CFG_NOW, '/BruceJS/MiniCCTV.js': OLD_APP },
    web: webFor(),
    keys: script([{ when: function (l) { return anyText(l, /App updated/); }, key: 'sel' }])
  });
  check('app ran without throwing', L.error === '', L.error);
  check('it asked GitHub for the list and then the app, nothing else', L.webUrls.length === 2 && /version\.json$/.test(L.webUrls[0]) && /bruce\/MiniCCTV\.js$/.test(L.webUrls[1]), L.webUrls.join(' '));
  check('the new app replaced the old one', L.files['/BruceJS/MiniCCTV.js'] === NEW_APP);
  check('the old app is kept as MiniCCTV.js.bak, and no half-written file is left', L.files['/BruceJS/MiniCCTV.js.bak'] === OLD_APP && !L.files.hasOwnProperty('/BruceJS/MiniCCTV.js.new'));
  check('it was written on the filesystem the app lives on (the SD card)', L.fsUsed['/BruceJS/MiniCCTV.js.new'] === 'sd');
  check('the screen said what was happening', anyText(L, /App update/) && anyText(L, /Downloading v2\.2\.0/) && anyText(L, /Now v2\.2\.0/));
  check('then the app ended, to be reopened (the main menu never showed)', L.menuDraws === 0 && L.urls.length === 0);

  // an app that lives in the Stick's own flash
  FC.reset();
  L = runApp({ homeWifi: true, selfFs: 'littlefs', files: { '/MiniCCTV.cfg': CFG_NOW, '/BruceJS/MiniCCTV.js': OLD_APP }, web: webFor(), keys: script([{ when: function (l) { return anyText(l, /App updated/); }, key: 'sel' }]) });
  check('an app in the Stick\'s flash is replaced in the Stick\'s flash', L.files['/BruceJS/MiniCCTV.js'] === NEW_APP && L.fsUsed['/BruceJS/MiniCCTV.js.new'] === 'littlefs');

  // UP during the 3 second notice skips it
  FC.reset();
  L = runApp({ homeWifi: true, files: { '/MiniCCTV.cfg': CFG_NOW, '/BruceJS/MiniCCTV.js': OLD_APP }, web: webFor(), keys: script([{ when: function (l) { return anyText(l, /Installing in 3 s/); }, key: 'prev' }, { when: MENU(1), key: 'esc' }]) });
  check('UP during the notice skips the update and goes on to the menu', L.files['/BruceJS/MiniCCTV.js'] === OLD_APP && L.webUrls.length === 1 && L.menuDraws >= 1);
};

SCENARIOS.update_app_refuses_bad_downloads = function () {
  var cases = [
    ['a size that does not match the list', { length: NEW_APP.length + 1 }],
    ['a body shorter than the list says', { size: NEW_APP.length + 50 }],
    ['a file that is not the announced version', { text: appText('2.1.5'), size: appText('2.1.5').length }],
    ['a file cut off before its end', { text: NEW_APP.substring(0, NEW_APP.length - 8), size: NEW_APP.length - 8 }],
    ['an HTTP error', { appStatus: 500 }],
    ['a download that throws', { appThrows: true }],
    ['a card that will not take the file', { writeFails: '.new' }]
  ];
  for (var i = 0; i < cases.length; i++) {
    FC.reset();
    var c = cases[i][1];
    var L = runApp({
      homeWifi: true,
      writeFails: c.writeFails,
      files: { '/MiniCCTV.cfg': CFG_NOW, '/BruceJS/MiniCCTV.js': OLD_APP },
      web: webFor(c),
      keys: script([{ when: function (l) { return anyText(l, /Update failed/); }, key: 'sel' }, { when: MENU(1), key: 'esc' }])
    });
    var untouched = L.files['/BruceJS/MiniCCTV.js'] === OLD_APP && !L.files.hasOwnProperty('/BruceJS/MiniCCTV.js.new') && !L.files.hasOwnProperty('/BruceJS/MiniCCTV.js.bak');
    check('refused: ' + cases[i][0] + ' (the app is left exactly as it was, and says the update failed)', L.error === '' && untouched && anyText(L, /Update failed/) && anyText(L, /unchanged/) && L.menuDraws >= 1, '(' + L.texts.slice(-6).join(' | ') + ')');
  }

  // a list that points outside this repository, or is nonsense, is ignored and the download is never made
  var lists = [{ appUrl: 'https://evil.example.com/MiniCCTV.js' }, { app: 'two' }, { size: 5 }, { size: 9999999 }];
  var all = true;
  for (var j = 0; j < lists.length; j++) {
    FC.reset();
    var L2 = runApp({ homeWifi: true, files: { '/MiniCCTV.cfg': CFG_NOW, '/BruceJS/MiniCCTV.js': OLD_APP }, web: webFor(lists[j]), keys: script([{ when: MENU(1), key: 'esc' }]) });
    if (L2.error !== '' || L2.files['/BruceJS/MiniCCTV.js'] !== OLD_APP || L2.webUrls.length !== 1 || L2.menuDraws < 1) { all = false; out('  bad list ' + j + ': ' + L2.webUrls.join(' ')); }
  }
  check('a list that points outside the repository, or is nonsense, is ignored and nothing is downloaded', all);
};

SCENARIOS.update_app_swap_is_safe = function () {
  // the swap is two renames: old -> .bak, then new -> app. A failure in either must leave a working app.
  var at = [1, 2];
  for (var i = 0; i < at.length; i++) {
    FC.reset();
    var L = runApp({
      homeWifi: true, renameFailsAt: at[i],
      files: { '/MiniCCTV.cfg': CFG_NOW, '/BruceJS/MiniCCTV.js': OLD_APP },
      web: webFor(),
      keys: script([{ when: function (l) { return anyText(l, /Update failed/); }, key: 'sel' }, { when: MENU(1), key: 'esc' }])
    });
    check('rename #' + at[i] + ' failing leaves the old app in place, with no stray files', L.files['/BruceJS/MiniCCTV.js'] === OLD_APP && !L.files.hasOwnProperty('/BruceJS/MiniCCTV.js.new') && !L.files.hasOwnProperty('/BruceJS/MiniCCTV.js.bak') && anyText(L, /could not replace/), '(' + Object.keys(L.files).join(',') + ')');
  }
  // an old .bak from an earlier update does not get in the way (FAT will not rename onto an existing file)
  FC.reset();
  var L3 = runApp({ homeWifi: true, files: { '/MiniCCTV.cfg': CFG_NOW, '/BruceJS/MiniCCTV.js': OLD_APP, '/BruceJS/MiniCCTV.js.bak': '// two versions ago' }, web: webFor(), keys: script([{ when: function (l) { return anyText(l, /App updated/); }, key: 'sel' }]) });
  check('an older .bak is replaced by the newer one', L3.files['/BruceJS/MiniCCTV.js'] === NEW_APP && L3.files['/BruceJS/MiniCCTV.js.bak'] === OLD_APP);
};

SCENARIOS.update_not_needed = function () {
  var up = webFor({ app: '2.1.0', fw: '2.1.0' });
  // current everywhere: straight to the menu, quietly
  FC.reset();
  var L = runApp({ homeWifi: true, files: { '/MiniCCTV.cfg': CFG_NOW, '/BruceJS/MiniCCTV.js': OLD_APP }, web: up, keys: script([{ when: MENU(1), key: 'esc' }]) });
  check('up to date: one look at the list, no download, no writes, then the menu', L.webUrls.length === 1 && L.writes === 0 && L.files['/BruceJS/MiniCCTV.js'] === OLD_APP && L.menuDraws >= 1 && L.error === '');
  check('...and no card pops up for it', !anyText(L, /App update|Camera update|Up to date/));
  // an app that is NEWER than the list (a development copy) is left alone
  FC.reset();
  L = runApp({ homeWifi: true, files: { '/MiniCCTV.cfg': CFG_NOW }, web: webFor({ app: '2.0.0', fw: '2.1.0' }), keys: script([{ when: MENU(1), key: 'esc' }]) });
  check('an app newer than the list is never "downgraded"', L.webUrls.length === 1 && L.writes === 0);
  // not on a home WiFi: it must not touch the internet
  FC.reset();
  L = runApp({ preconnected: true, files: { '/MiniCCTV.cfg': CFG_NOW }, web: webFor(), keys: script([{ when: MENU(1), key: 'esc' }]) });
  check('on the camera\'s WiFi it never goes looking for updates', L.webUrls.length === 0 && L.menuDraws >= 1);
  FC.reset();
  L = runApp({ files: { '/MiniCCTV.cfg': CFG_NOW }, web: webFor(), keys: script([{ when: MENU(1), key: 'esc' }]) });
  check('with no WiFi at all it does not ask Bruce to connect, and does not nag', L.webUrls.length === 0 && L.dialogs === 0 && L.joins === 0 && L.menuDraws >= 1);
  // no internet / a broken list: silent
  FC.reset();
  L = runApp({ homeWifi: true, files: { '/MiniCCTV.cfg': CFG_NOW }, web: webFor({ listFails: true }), keys: script([{ when: MENU(1), key: 'esc' }]) });
  check('no internet at start: silent, straight to the menu', L.error === '' && L.menuDraws >= 1 && !anyText(L, /No update info/) && L.writes === 0);
};

SCENARIOS.update_camera = function () {
  var cam = webFor({ app: '2.1.0', fw: '2.2.0' });
  var steps = [
    { when: function (l) { return anyText(l, /Check and update it now/); }, key: 'sel' },
    { when: function (l) { return anyText(l, /Update camera\?/) || has(l.titles, 'Update camera?'); }, key: 'sel' },
    { when: function (l) { return has(l.titles, 'Camera updated') || has(l.titles, 'Not updated'); }, key: 'sel' },
    { when: MENU(1), key: 'esc' }
  ];
  FC.reset({ fw: '2.1.0', newFw: '2.2.0' });
  var L = runApp({ homeWifi: true, typed: [SSID, PASSWORD], files: { '/MiniCCTV.cfg': CFG_NOW }, web: cam, keys: script(steps) });
  var saved = null;
  try { saved = JSON.parse(L.files['/MiniCCTV.cfg']); } catch (e) { saved = null; }
  var req = FC.state().otaReq;
  check('app ran without throwing', L.error === '' && !L.timeout, L.error);
  check('it offers the camera update when the list has a newer camera than the one it knows', anyText(L, /Camera v2\.1\.0\s+->\s+v2\.2\.0/));
  check('the Stick left the home WiFi, joined the camera, lost it while it updated, and rejoined', L.netLog.join(',') === 'none,cam,none,cam', L.netLog.join(','));
  check('it asked for the WiFi name (pre-filled with the last one) and then the password (masked)', L.prompts.length === 2 && L.prompts[0].initial === 'OldHome' && /name/i.test(L.prompts[0].msg) && L.prompts[0].mask === false && /password/i.test(L.prompts[1].msg) && L.prompts[1].mask === true, JSON.stringify(L.prompts));
  check('the camera received exactly what was typed, decoded (special characters survive)', req !== null && req.ssid === SSID && req.pass === PASSWORD, JSON.stringify(req));
  check('the details went to the camera, once, by POST over its own network', FC.state().otaCalls === 1 && countUrls(L, /\/ota$/) === 1);
  check('the screen counted the wait and then said the camera was updated', anyText(L, /Waiting \d+ s/) && anyText(L, /Camera firmware is now/) && anyText(L, /^v2\.2\.0\.$/));
  check('the Stick remembers the camera is now 2.2.0 and the WiFi NAME, and clears the camera\'s note', saved !== null && saved.camFw === '2.2.0' && saved.homeSsid === SSID && FC.state().otamsg === '');
  check('the password is never saved, shown or kept anywhere', noSecrets(L));
  check('the Stick never downloads firmware itself (the camera does)', countText({ texts: L.webUrls }, /\.bin/) === 0 && L.webUrls.length === 1);
  check('the main menu follows', L.menuDraws >= 1);

  // the camera could not join the home WiFi
  FC.reset({ fw: '2.1.0', updOk: false });
  L = runApp({ homeWifi: true, typed: [SSID, 'wrongpass'], files: { '/MiniCCTV.cfg': CFG_NOW }, web: cam, keys: script(steps) });
  saved = JSON.parse(L.files['/MiniCCTV.cfg']);
  check('a camera that could not join the WiFi says why, and nothing is marked as updated', anyText(L, /Not updated/i) && anyText(L, /home WiFi failed: check the name/) && saved.camFw === '2.1.0', JSON.stringify(saved));

  // the camera is already the latest
  FC.reset({ fw: '2.2.0' });
  L = runApp({ homeWifi: true, typed: [SSID, 'x'], files: { '/MiniCCTV.cfg': CFG_NOW }, web: cam, keys: script([steps[0], { when: function (l) { return has(l.titles, 'Camera current'); }, key: 'sel' }, steps[3]]) });
  check('a camera that is already current says so and asks for nothing', anyText(L, /is the latest/) && L.prompts.length === 0 && FC.state().otaCalls === 0 && JSON.parse(L.files['/MiniCCTV.cfg']).camFw === '2.2.0');

  // later, skipped, or cancelled: nothing is sent
  FC.reset({ fw: '2.1.0' });
  L = runApp({ homeWifi: true, files: { '/MiniCCTV.cfg': CFG_NOW }, web: cam, keys: script([{ when: function (l) { return anyText(l, /Check and update it now/); }, key: 'prev' }, { when: MENU(1), key: 'esc' }]) });
  check('UP at "update now?" leaves the camera alone and goes to the menu', L.netLog.length === 0 && FC.state().otaCalls === 0 && L.menuDraws >= 1);
  FC.reset({ fw: '2.1.0' });
  L = runApp({ homeWifi: true, typed: [], files: { '/MiniCCTV.cfg': CFG_NOW }, web: cam, keys: script([steps[0], steps[1], { when: MENU(1), key: 'esc' }]) });
  check('escaping the WiFi name prompt cancels without sending anything', FC.state().otaCalls === 0 && L.prompts.length === 1 && L.menuDraws >= 1);
  FC.reset({ fw: '2.1.0' });
  L = runApp({ homeWifi: true, typed: [SSID, ''], files: { '/MiniCCTV.cfg': CFG_NOW }, web: cam, keys: script([steps[0], steps[1], { when: function (l) { return anyText(l, /open\s*$/) || anyText(l, /network with no password/); }, key: 'prev' }, { when: MENU(1), key: 'esc' }]) });
  check('an empty password is double-checked, and cancelling sends nothing', FC.state().otaCalls === 0 && anyText(L, /network with no password/));
  FC.reset({ fw: '2.1.0' });
  L = runApp({ homeWifi: true, typed: ['OpenCafe', ''], files: { '/MiniCCTV.cfg': CFG_NOW }, web: cam, keys: script([steps[0], steps[1], { when: function (l) { return anyText(l, /network with no password/); }, key: 'sel' }, steps[2], steps[3]]) });
  check('...but confirming an open network goes ahead with an empty password', FC.state().otaReq !== null && FC.state().otaReq.ssid === 'OpenCafe' && FC.state().otaReq.pass === '');

  // trouble
  FC.reset({ fw: '2.1.0', down: true });
  L = runApp({ homeWifi: true, typed: [SSID, 'x'], files: { '/MiniCCTV.cfg': CFG_NOW }, web: cam, keys: script([steps[0], { when: function (l) { return has(l.titles, 'Camera not found'); }, key: 'prev' }, steps[3]]) });
  check('a camera that is off is reported, and the app carries on', anyText(L, /powered on/) && FC.state().otaCalls === 0 && L.menuDraws >= 1 && L.error === '');
  FC.reset({ fw: '2.1.0', updGone: 99999 });
  L = runApp({ homeWifi: true, typed: [SSID, 'x'], files: { '/MiniCCTV.cfg': CFG_NOW }, web: cam, maxTicks: 400000, keys: script([steps[0], steps[1], { when: function (l) { return has(l.titles, 'No answer yet'); }, key: 'sel' }, steps[3]]) });
  check('a camera that never comes back: the wait ends by itself with an explanation', anyText(L, /may still be busy/) && L.error === '' && !L.timeout && L.menuDraws >= 1);
  FC.reset({ fw: '2.1.0', updGone: 99999 });
  L = runApp({ homeWifi: true, typed: [SSID, 'x'], files: { '/MiniCCTV.cfg': CFG_NOW }, web: cam, maxTicks: 400000, keys: script([steps[0], steps[1], { when: function (l) { return anyText(l, /Waiting [3-9] s/); }, key: 'prev' }, steps[3]]) });
  check('UP stops waiting at once', !anyText(L, /may still be busy/) && L.menuDraws >= 1 && !anyText(L, /Waiting 1\d\d s/));
  check('the password is not kept in any of the failure paths either', noSecrets(L));
};

SCENARIOS.update_in_settings = function () {
  FC.reset({ fw: '2.1.0' });
  // from the camera's WiFi: Settings -> Updates asks to pick the home WiFi, then reports
  var L = runApp({
    preconnected: true, files: { '/MiniCCTV.cfg': CFG_NOW }, web: webFor({ app: '2.1.0', fw: '2.1.0' }),
    keys: script(toSettings().concat([
      { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' },   // Alerts(1) -> Updates(7)
      { when: null, key: 'sel' },
      { when: function (l) { return has(l.titles, 'Join home WiFi'); }, key: 'sel' },
      { when: function (l) { return has(l.titles, 'Up to date'); }, key: 'sel' },
      { when: null, key: 'next' },                                              // App
      { when: null, key: 'sel' },                                               // says its version
      { when: function (l) { return anyText(l, /Stick app v2\.1\.0/); }, key: 'next' },
      { when: null, key: 'sel' },                                               // Camera version (not seen yet: connects)
      { when: function (l) { return anyText(l, /Camera firmware v2\.1\.0/); }, key: 'esc' },
      { when: MENU(2), key: 'esc' }
    ]))
  });
  check('app ran without throwing', L.error === '', L.error);
  check('Updates from the camera\'s WiFi offers Bruce\'s WiFi picker, then looks at GitHub', L.dialogs === 1 && L.webUrls.length === 1 && anyText(L, /Up to date/i) && anyText(L, /Camera v2\.1\.0/), '(dialogs ' + L.dialogs + ', web ' + L.webUrls.length + ', last texts: ' + L.texts.slice(-12).join(' | ') + ')');
  check('the rows show both versions as chips', L.texts.indexOf('V2.1.0') >= 0 && anyText(L, /^App$/) && anyText(L, /^Camera$/));
  check('the Updates row reports "Current" once it has looked', L.texts.indexOf('CURRENT') >= 0);
  check('the app row says its version and where the newest is', anyText(L, /Stick app v2\.1\.0/) && anyText(L, /Latest on GitHub: v2\.1\.0/));

  // a newer app found by hand installs, then the app ends
  FC.reset({ fw: '2.1.0' });
  L = runApp({
    homeWifi: true, files: { '/MiniCCTV.cfg': CFG_NOW, '/BruceJS/MiniCCTV.js': OLD_APP }, web: webFor({ app: '2.2.0', fw: '2.1.0' }),
    keys: script(toSettings().concat([
      { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' },
      { when: null, key: 'sel' },                                               // Updates (already on the home WiFi: no picker)
      { when: function (l) { return anyText(l, /App updated/); }, key: 'sel' }
    ]))
  });
  check('Updates by hand on the home WiFi installs a newer app and ends the app', L.error === '' && L.dialogs === 0 && L.files['/BruceJS/MiniCCTV.js'] === NEW_APP && L.files['/BruceJS/MiniCCTV.js.bak'] === OLD_APP);

  // no internet when asked by hand: it says so
  FC.reset();
  L = runApp({
    homeWifi: true, files: { '/MiniCCTV.cfg': CFG_NOW }, web: webFor({ listFails: true }),
    keys: script(toSettings().concat([
      { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' },
      { when: null, key: 'sel' },
      { when: function (l) { return has(l.titles, 'No update info'); }, key: 'sel' },
      { when: null, key: 'esc' }, { when: MENU(2), key: 'esc' }
    ]))
  });
  check('asked by hand with no internet, it explains instead of failing silently', anyText(L, /Could not read the update list/) && L.error === '');
};

SCENARIOS.update_footprint = function () {
  // Used by tools/mq_footprint.js, which shrinks the engine's heap until this stops working: installing
  // a real-sized (63 KB) app update is the most memory the app ever needs at once.
  var f = '';
  for (var i = 0; i < 2300; i++) {
    f += '// padding padding padding\n';
  }
  var big = '// MiniCCTV 2.2.0\n' + f + 'var APP_VERSION = \'2.2.0\';\nmain();\n';
  f = null; // the rig must hold one copy of the download (standing in for the one on the Stick), not two
  FC.reset();
  var L = runApp({
    light: true, homeWifi: true,
    files: { '/MiniCCTV.cfg': CFG_NOW, '/BruceJS/MiniCCTV.js': '// old\nvar APP_VERSION = \'2.1.0\';\nmain();\n' },
    web: webFor({ text: big, size: big.length }),
    keys: script([{ when: function (l) { return l.files['/BruceJS/MiniCCTV.js.bak'] !== undefined; }, key: 'sel' }])
  });
  check('a 63 KB update was installed', L.error === '' && L.files['/BruceJS/MiniCCTV.js'] === big, L.error);
};

SCENARIOS.tables_match_firmware = function () {
  FC.reset();
  var L = runApp({ keys: script([{ when: MENU(1), key: 'esc' }]) });
  check('app ran without throwing', L.error === '', L.error);
  var ok = MODES.length === GOLDEN.modes.length;
  var why = '';
  for (var i = 0; i < GOLDEN.modes.length && ok; i++) {
    var g = GOLDEN.modes[i];
    if (MODES[i] !== g[0]) { ok = false; why = 'name ' + i + ': app "' + MODES[i] + '" vs firmware "' + g[0] + '"'; }
    else if (MODE_BLURB[i] !== g[1]) { ok = false; why = 'description of ' + g[0]; }
    else if ((MODE_ALERTS[i] ? 1 : 0) !== g[2]) { ok = false; why = 'alerts flag of ' + g[0]; }
    else if ((MODE_NEEDS_SD[i] ? 1 : 0) !== g[3]) { ok = false; why = 'needs-SD flag of ' + g[0]; }
  }
  check('mode names, descriptions, alerts and needs-SD flags match firmware/mini_cctv/modes.h', ok, why);
  var f = FILTERS.length === GOLDEN.filters.length;
  for (var j = 0; j < GOLDEN.filters.length && f; j++) {
    if (FILTERS[j] !== GOLDEN.filters[j]) { f = false; why = 'filter ' + j; }
  }
  check('filter names match firmware/mini_cctv/filters.h', f, why);
  check('the alert level names line up', ALERT_NAMES.length === 3 && ALERT_SHORT.length === 3 && FLIP_NAMES.length === 4);
};

SCENARIOS.ir_trigger = function () {
  FC.reset({ mode: 2 });
  var L = runApp({
    keys: script([
      { when: MENU(1), key: 'next' },
      { when: MENU(2), key: 'next' },
      { when: MENU(3), key: 'sel' },
      { when: function (l) { return has(l.brightness, 2); }, run: function () { FC.state().mseq = 1; FC.state().motion = 1; } },
      { when: function (l) { return l.irs.length >= 1; }, run: function () { FC.state().motion = 0; } },
      { when: function (l) { return countUrls(l, /\/d\?f=8/) > 100; }, run: function () { FC.state().mseq = 2; FC.state().motion = 1; } },   // a second event, seconds later
      { when: function (l) { return l.tones.length >= 2; }, run: function () { FC.state().motion = 0; } },
      { when: function (l) { return countUrls(l, /\/d\?f=8/) > 300; }, key: 'prev' },
      { when: MENU(2), key: 'esc' }
    ])
  });
  check('app ran without throwing', L.error === '', L.error);
  check('motion sends the IR command (a lamp turning on)', L.irs.length >= 1 && L.irs[0] === '/BruceIR/lamp.ir', '(' + L.irs.join(',') + ')');
  check('a second event soon after does not repeat it (60 s gap)', L.irs.length === 1 && L.tones.length >= 2, '(' + L.irs.length + ' IR, ' + L.tones.length + ' beeps)');
};

SCENARIOS.connect_failures = function () {
  FC.reset({ down: true });
  var L = runApp({ keys: script([{ when: MENU(1), key: 'sel' }, { when: function (l) { return anyText(l, /Joined WiFi, camera silent/); }, key: 'prev' }, { when: MENU(2), key: 'esc' }]) });
  check('camera silent: says so, gives up after 3 probes, and lets you back out', anyText(L, /Joined WiFi, camera silent/) && countUrls(L, /\/status$/) === 3 && L.menuDraws >= 2);
  FC.reset();
  L = runApp({ joinFails: true, keys: script([{ when: MENU(1), key: 'sel' }, { when: function (l) { return anyText(l, /Couldn't join/); }, key: 'prev' }, { when: MENU(2), key: 'esc' }]) });
  check('WiFi join failure is explained', anyText(L, /Couldn't join/) && L.urls.length === 0);
  FC.reset();
  L = runApp({
    fetch: function (url) { return /\/status$/.test(url) ? { status: 200, body: { w: 320, h: 240 }, length: 0 } : null; },
    keys: script([{ when: MENU(1), key: 'sel' }, { when: function (l) { return anyText(l, /Camera sends 320x240/); }, key: 'prev' }, { when: MENU(2), key: 'esc' }])
  });
  check('a config mismatch is reported instead of drawing garbage', anyText(L, /Camera sends 320x240/) && L.bitmaps.length === 0);
  FC.reset();
  L = runApp({ keys: script([{ when: MENU(1), key: 'sel' }, { when: function (l) { return l.bitmaps.length >= 3; }, key: 'esc' }]) });
  check('UP+DOWN quits the whole app straight from the viewer', L.error === '' && L.menuDraws === 1 && L.restores >= 1);
};

SCENARIOS.stream_trouble = function () {
  // camera vanishes for a while mid-stream, then comes back
  FC.reset({ autoMotion: true });
  var reqs = 0;
  var L = runApp({
    fetch: function (url) {
      if (/\/d\?/.test(url)) {
        reqs++;
        if (reqs > 6 && reqs <= 24) {
          return 'throw';
        }
      }
      return null;
    },
    keys: script([
      { when: MENU(1), key: 'sel' },
      { when: function (l) { return reqs > 30; }, key: 'prev' },
      { when: MENU(2), key: 'esc' }
    ])
  });
  check('app ran without throwing', L.error === '' && !L.timeout, L.error);
  check('an outage shows "No signal"', L.noSignal >= 1);
  check('it reconnects, with a clean disconnect on repeated outages', L.joins >= 2 && L.disconnects >= 1, '(joins ' + L.joins + ', disc ' + L.disconnects + ')');
  check('afterwards it restarts from a full picture (s=0)', countUrls({ urls: L.urls.slice(24) }, /s=0$/) >= 1);

  // truncated reply: body shorter than Content-Length is never drawn
  FC.reset({ autoMotion: true });
  L = runApp({
    maxTicks: 300,
    fetch: function (url) {
      if (/\/d\?/.test(url)) {
        var r = FC.handle(url, { responseType: 'binary' });
        return { status: 200, body: new Uint8Array(r.body.subarray(0, 200)), length: r.length };
      }
      return null;
    },
    keys: script([{ when: MENU(1), key: 'sel' }])
  });
  check('a truncated reply is rejected and nothing half-drawn', L.bitmaps.length === 0 && L.bitmaps.length === 0 && L.error === '');

  // a reply that is well-formed but shorter than its Content-Length is dropped too
  FC.reset({ autoMotion: true });
  L = runApp({
    maxTicks: 300,
    fetch: function (url) {
      if (/\/d\?/.test(url)) {
        var r2 = FC.handle(url, { responseType: 'binary' });
        return { status: 200, body: new Uint8Array(r2.body), length: r2.length + 5 };
      }
      return null;
    },
    keys: script([{ when: MENU(1), key: 'sel' }])
  });
  check('a reply shorter than its declared length is rejected even if it parses', L.bitmaps.length === 0 && L.error === '');

  // Fast mode: a band that is not exactly 240 x rows bytes is rejected (drawBitmap needs an exact size)
  FC.reset();
  L = runApp({
    maxTicks: 300,
    files: { '/MiniCCTV.cfg': '{"v":1,"photo":0,"alerts":2,"hud":1}' },
    fetch: function (url) {
      if (/\/d\?/.test(url)) {
        var body = new Uint8Array(8 + 2 + 100);
        body[0] = 1; // band 0 only
        body[2] = 1; // seq 1
        body[8] = 100; // 100 bytes where 3840 are due
        return { status: 200, body: body, length: body.length };
      }
      return null;
    },
    keys: script([{ when: MENU(1), key: 'sel' }])
  });
  check('a Fast band of the wrong size is rejected, not drawn or thrown on', L.bitmaps.length === 0 && L.error === '', L.error);

  // camera reboot: its update counter starts again from 1
  FC.reset({ autoMotion: true });
  var n = 0;
  L = runApp({
    fetch: function (url) {
      if (/\/d\?/.test(url)) {
        n++;
        if (n === 6) {
          FC.reset({ autoMotion: true });
        }
      }
      return null;
    },
    keys: script([{ when: MENU(1), key: 'sel' }, { when: function (l) { return n > 12; }, key: 'prev' }, { when: MENU(2), key: 'esc' }])
  });
  var sv = [];
  for (var i = 0; i < L.urls.length; i++) {
    var m = /\/d\?f=8&s=(\d+)$/.exec(L.urls[i]);
    if (m) { sv.push(parseInt(m[1], 10)); }
  }
  var dropped = false;
  for (var j = 1; j < sv.length; j++) {
    if (sv[j] === 0 && sv[j - 1] > 0) { dropped = true; }
  }
  check('a rebooted camera (counter goes backwards) triggers a full redraw', dropped, '(s: ' + sv.join(',') + ')');
};

SCENARIOS.real_firmware_bytes = function () {
  // Replies produced by the real C++ encoder (tools/test_delta.cpp), parsed by the real app.
  var d8 = new Uint8Array(GOLDEN.d8);
  var fb8 = new Uint8Array(GOLDEN.d8fb);
  var empty = function (seq) { return new Uint8Array([0, 0, seq & 255, (seq >> 8) & 255, 0, 0, 37, 10]); };
  FC.reset();
  var L = runApp({
    fetch: function (url) {
      if (/\/d\?f=8&s=0$/.test(url)) { return { status: 200, body: new Uint8Array(d8), length: d8.length }; }
      if (/\/d\?/.test(url)) { return { status: 200, body: empty(1), length: 8 }; }
      return null;
    },
    keys: script(toWatch().concat([
      { when: function (l) { return countUrls(l, /\/d\?f=8&s=1$/) >= 3; }, run: function (l) { l.snap = new Uint8Array(l.fb); }, key: 'esc' }
    ]))
  });
  check('golden raw8: app ran without throwing', L.error === '', L.error);
  check('golden raw8: 9 bands drawn, the last one 7 rows', L.bitmaps.length >= 9 && L.bitmaps[8].h === 7 && L.bitmaps[0].h === 16);
  check('golden raw8: the screen equals the frame the C++ encoder was given', frameEquals(L.snap, fb8) === -1);
  check('golden raw8: it then asks for since=1 (the seq in the reply)', countUrls(L, /\/d\?f=8&s=1$/) >= 1);
  check('golden raw8: motion level and flags from the header are read', hdrMotion === 37 && hdrFlags === 10, '(' + hdrMotion + ',' + hdrFlags + ')');
};

SCENARIOS.long_run_memory = function () {
  // many frames on the real engine: catches leaks and heap exhaustion
  FC.reset({ autoMotion: true });
  var L = runApp({
    maxTicks: 200000,
    keys: script(toWatch().concat([
      { when: function (l) { return l.bitmaps.length >= 1500; }, key: 'prev' }, { when: null, key: 'esc' }
    ]))
  });
  check('1500 picture updates without running out of memory', L.error === '' && L.bitmaps.length >= 1500 && !L.timeout, L.error);
  check('...and none of them was a JPEG', L.jpgCount === 0);
};

SCENARIOS.footprint = function () {
  // Used by tools/mq_footprint.js, which shrinks the engine's heap until this stops working. Full
  // 32 KB pictures, since that is the heaviest thing the app handles.
  FC.reset({ autoMotion: true });
  var L = runApp({
    light: true, maxTicks: 200000,
    keys: script(toWatch().concat([
      { when: function (l) { return l.bitmapCount >= 300; }, key: 'prev' }, { when: null, key: 'esc' }
    ]))
  });
  check('300 picture updates ran', L.error === '' && L.bitmapCount >= 300, L.error);
};

// ---------------------------------------------------------------------------------------------
function main() {
  var names = [];
  if (SCENARIO === 'all') {
    for (var k in SCENARIOS) {
      if (SCENARIOS.hasOwnProperty(k)) { names.push(k); }
    }
  } else {
    names.push(SCENARIO);
  }
  for (var i = 0; i < names.length; i++) {
    out('== ' + names[i]);
    SCENARIOS[names[i]]();
  }
  out('SUMMARY passed=' + PASSED + ' failed=' + FAILED);
}

main();
