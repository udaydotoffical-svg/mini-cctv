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
    files: opts.files || {}, writes: 0, icons: 0, gradients: 0
  };
  var curSize = 1;
  var curColor = 0;
  var pending = null;
  var connected = !!opts.preconnected;

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
    drawFillRect: function () {},
    drawFillRoundRect: function () {},
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
    getNextPress: function () { return take('next'); }
  };

  var MOCK_wifi = {
    connected: function () { return connected; },
    getIPAddress: function () { return connected ? '192.168.4.2' : null; },
    connect: function () {
      L.joins++;
      CLOCK += 1000;
      if (opts.joinFails) {
        return false;
      }
      connected = true;
      return true;
    },
    connectDialog: function () { connected = true; return true; },
    disconnect: function () { L.disconnects++; connected = false; },
    httpFetch: function (url, o) {
      if (!opts.light) {
        L.urls.push(url);
      }
      CLOCK += 30;
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

// Key helpers: the main menu is Watch live(0) Guard(1) Photos&clips(2) Camera(3) Settings(4) Exit(5);
// Settings is Auto-record(0) Picture(1) Alerts(2) Info line(3) Mode(4) Timelapse(5) Back(6).
// 'next' = DOWN, 'prev' = UP, 'sel' = M5, 'esc' = UP+DOWN together.
function T(name) {
  return function (l) { return has(l.titles, name); };
}

// Settings -> Picture -> Fast, back out, and into Watch live
function toFastWatch() {
  return toSettings().concat([
    { when: null, key: 'sel' }, { when: null, key: 'esc' },
    { when: null, key: 'prev' }, { when: null, key: 'prev' }, { when: null, key: 'prev' }, { when: null, key: 'prev' },
    { when: null, key: 'sel' }
  ]);
}

// from the first main menu draw to the Settings screen
function toSettings() {
  return [
    { when: MENU(1), key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' },
    { when: null, key: 'sel' }, { when: T('Settings'), key: 'next' }
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

SCENARIOS.watch_photo_mode = function () {
  FC.reset({ autoMotion: true });
  var L = runApp({
    keys: script([
      { when: MENU(1), key: 'sel' },
      { when: function (l) { return l.jpgs.length >= 30; }, key: 'prev' },
      { when: MENU(2), key: 'esc' }
    ])
  });
  check('app ran without throwing', L.error === '', L.error);
  check('joined the camera WiFi once', L.joins === 1, '(' + L.joins + ')');
  check('connect order: status, then the control state, then pictures',
    /\/status$/.test(L.urls[0]) && /\/ctl\?$/.test(L.urls[1]) && /\/d\?f=j&s=0$/.test(L.urls[2]), L.urls.slice(0, 3).join(' '));
  check('Photo mode draws whole JPEG strips at band boundaries',
    L.jpgs.length >= 30 && L.jpgs.every(function (j) { return j.x === 0 && j.y % 16 === 0 && j.y <= 128 && j.b0 === 0xff && j.b1 === 0xd8; }));
  check('the first picture paints all 9 bands', (function () { var s = {}; for (var i = 0; i < 9; i++) { s[L.jpgs[i].y] = 1; } return Object.keys(s).length === 9; })());
  check('later updates only send the bands that moved', L.jpgs.length < 9 * 12);
  check('requests ask what changed since the last seen update', countUrls(L, /\/d\?f=j&s=[1-9]/) > 3);
  check('UP leaves the viewer and returns to the main menu', L.menuDraws >= 2);
  check('with an SD card there is no warning', !has(L.titles, 'No SD card') && !anyText(L, /^NO SD$/));
};

SCENARIOS.watch_fast_mode_is_exact = function () {
  FC.reset({ autoMotion: true });
  var L = runApp({
    keys: script([
      { when: MENU(1), key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' },
      { when: null, key: 'sel' },                    // Settings
      { when: T('Settings'), key: 'next' },          // -> Picture
      { when: null, key: 'sel' },                    // Photo -> Fast
      { when: null, key: 'esc' },                    // back to the main menu (cursor on Settings)
      { when: null, key: 'prev' }, { when: null, key: 'prev' }, { when: null, key: 'prev' }, { when: null, key: 'prev' },
      { when: null, key: 'sel' },                    // Watch live
      { when: function (l) { return l.bitmaps.length >= 45; }, run: function (l) { l.snap = new Uint8Array(l.fb); l.want = FC.expectedFrame(); }, key: 'prev' },
      { when: null, key: 'esc' }
    ])
  });
  check('app ran without throwing', L.error === '', L.error);
  check('Fast mode draws raw 8-bit bands of the right size', L.bitmaps.length >= 45 && L.bitmaps[8].h === 7 && L.bitmaps[0].h === 16 && L.jpgs.length === 0);
  var bad = frameEquals(L.snap, L.want);
  check('the Stick screen equals the camera picture (deltas applied correctly)', bad === -1, bad === -1 ? '' : '(first mismatch at pixel ' + bad + ')');
  check('Fast requests use f=8', countUrls(L, /\/d\?f=8&s=/) > 5 && countUrls(L, /\/d\?f=j/) === 0);
};

SCENARIOS.no_sd_warns_but_plays_live = function () {
  FC.reset({ sd: 0, autoMotion: true });
  var L = runApp({
    keys: script([
      { when: MENU(1), key: 'sel' },
      { when: function (l) { return l.jpgs.length >= 12; }, key: 'next' },     // DOWN: photo
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
  check('...but it does not block: live pictures arrive', L.jpgs.length >= 12);
  check('a "NO SD" tag stays on the live picture', anyText(L, /^NO SD$/));
  check('taking a photo says there is no card instead of asking the camera', anyText(L, /No SD card: cannot save/) && countUrls(L, /snap=1/) === 0);
  check('recording says there is no card instead of asking the camera', anyText(L, /No SD card: cannot record/) && countUrls(L, /rec=t/) === 0);
};

SCENARIOS.no_sd_security_mode_warning = function () {
  FC.reset({ sd: 0, mode: 2 });
  var L = runApp({ keys: script([{ when: MENU(1), key: 'sel' }, { when: function (l) { return l.jpgs.length >= 3; }, key: 'prev' }, { when: MENU(2), key: 'esc' }]) });
  check('Security mode without a card says it wants one', anyText(L, /Security mode wants a card/));
  FC.reset({ sd: 0, mode: 0 });
  L = runApp({ keys: script([{ when: MENU(1), key: 'sel' }, { when: function (l) { return l.jpgs.length >= 3; }, key: 'prev' }, { when: MENU(2), key: 'esc' }]) });
  check('Live mode without a card does not nag about recording', has(L.titles, 'No SD card') && !anyText(L, /mode wants a card/));
};

SCENARIOS.photo_and_record = function () {
  FC.reset({ autoMotion: true });
  var L = runApp({
    keys: script([
      { when: MENU(1), key: 'sel' },
      { when: function (l) { return l.jpgs.length >= 12; }, key: 'next' },                        // DOWN: photo
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
      { when: function (l) { return l.jpgs.length >= 12; }, key: 'sel' },
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
      { when: null, key: 'next' }, { when: null, key: 'next' }, { when: null, key: 'next' },   // Picture(1) -> Alerts -> Info line -> Mode (4)
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
      { when: function (l) { return l.jpgs.length >= 12; }, key: 'sel' },
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
      { when: function (l) { return l.jpgs.length >= 12; }, key: 'sel' },
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
      { when: function (l) { return l.jpgs.length >= 12; }, key: 'sel' },
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
      { when: MENU(3), key: 'sel' },                                            // Photos & clips
      { when: function (l) { return has(l.titles, 'Photos & clips'); }, key: 'sel' },   // Photos
      { when: function (l) { return has(l.titles, 'Photos'); }, key: 'next' },
      { when: null, key: 'sel' },                                               // the second photo
      { when: function (l) { return FC.state().ov === 2 && l.jpgs.length >= 12; }, key: 'prev' },  // UP back
      { when: function (l) { return FC.state().ov === 0; }, key: 'esc' },       // leave the list
      { when: null, key: 'next' },                                              // -> Clips
      { when: null, key: 'sel' },
      { when: function (l) { return has(l.titles, 'Clips'); }, key: 'next' },
      { when: null, key: 'sel' },                                               // the second clip
      { when: function (l) { return FC.state().ov === 3 && l.jpgs.length >= 30; }, key: 'sel' },  // M5: playback menu
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
  L = runApp({ keys: script([{ when: MENU(1), key: 'next' }, { when: MENU(2), key: 'next' }, { when: MENU(3), key: 'sel' },
    { when: function (l) { return has(l.titles, 'Photos & clips'); }, key: 'sel' }, { when: function (l) { return has(l.titles, 'No SD card'); }, key: 'prev' },
    { when: null, key: 'esc' }, { when: MENU(2), key: 'esc' }]) });
  check('the gallery says so (and does not crash) when the camera has no card', has(L.titles, 'No SD card') && L.error === '');
  FC.reset({ photos: [] });
  L = runApp({ keys: script([{ when: MENU(1), key: 'next' }, { when: MENU(2), key: 'next' }, { when: MENU(3), key: 'sel' },
    { when: function (l) { return has(l.titles, 'Photos & clips'); }, key: 'sel' }, { when: function (l) { return has(l.titles, 'No photos yet'); }, key: 'prev' },
    { when: null, key: 'esc' }, { when: MENU(2), key: 'esc' }]) });
  check('an empty card says "No photos yet"', has(L.titles, 'No photos yet'));
};

SCENARIOS.guard_mode = function () {
  FC.reset({ mode: 2 });
  var L = runApp({
    keys: script([
      { when: MENU(1), key: 'next' },
      { when: MENU(2), key: 'sel' },                                            // Guard mode
      { when: function (l) { return has(l.brightness, 2); }, run: function () { FC.state().mseq = 1; FC.state().big = 1; FC.state().motion = 1; FC.state().lv = 40; } },
      { when: function (l) { return l.tones.length >= 3; }, run: function () { FC.state().motion = 0; FC.state().lv = 0; FC.state().big = 0; } },
      { when: function (l) { return countUrls(l, /\/d\?f=j/) > 100 && l.brightness.length >= 3; }, key: 'prev' },   // after the auto-return
      { when: MENU(2), key: 'esc' }
    ])
  });
  check('app ran without throwing', L.error === '' && !L.timeout, L.error);
  check('the screen is dimmed while guarding', L.brightness[0] === 2);
  check('a person-sized event sounds three beeps and blinks the LED', L.tones.length === 3 && L.blinks === 1, '(' + L.tones.length + ' tones, ' + L.blinks + ' blinks)');
  check('the event wakes the screen and shows the live picture', has(L.brightness, 'restore') && L.jpgs.length > 0);
  check('it dims again once things go quiet, with no key pressed', L.brightness.slice(0, 3).join(',') === '2,restore,2', '(brightness calls: ' + L.brightness.join(',') + ')');
  check('UP leaves guard mode and restores the brightness', L.brightness[L.brightness.length - 1] === 'restore' && L.brightness[L.brightness.length - 2] === 'restore' && L.menuDraws >= 2);
  check('guard polls the camera with the motion counter', countUrls(L, /\/m\?s=0$/) >= 1);

  // a camera in Live mode can't guard: offer to switch it
  FC.reset({ mode: 0 });
  L = runApp({ keys: script([{ when: MENU(1), key: 'next' }, { when: MENU(2), key: 'sel' }, { when: function (l) { return has(l.titles, 'Arm guard?'); }, key: 'sel' },
    { when: function (l) { return FC.state().mode === 2 && has(l.brightness, 2); }, key: 'prev' }, { when: MENU(2), key: 'esc' }]) });
  check('Guard on a Live-mode camera offers to switch it to Security, and does', has(L.titles, 'Arm guard?') && FC.state().mode === 2);
  FC.reset({ mode: 0 });
  L = runApp({ keys: script([{ when: MENU(1), key: 'next' }, { when: MENU(2), key: 'sel' }, { when: function (l) { return has(l.titles, 'Arm guard?'); }, key: 'prev' }, { when: MENU(2), key: 'esc' }]) });
  check('...or you can say no (mode stays, screen never dimmed)', FC.state().mode === 0 && !has(L.brightness, 2));
};

SCENARIOS.guard_survives_camera_reboot = function () {
  // the camera has already seen 5 events; then it reboots (its counter restarts) and sees a new one
  FC.reset({ mode: 2, mseq: 5 });
  var L = runApp({
    keys: script([
      { when: MENU(1), key: 'next' },
      { when: MENU(2), key: 'sel' },                                            // Guard mode
      { when: function (l) { return has(l.brightness, 2) && countUrls(l, /\/m\?s=5$/) >= 2; }, run: function () { FC.state().mseq = 0; } },   // reboot
      { when: function (l) { return countUrls(l, /\/m\?s=0$/) >= 2; }, run: function () { FC.state().mseq = 1; FC.state().motion = 1; FC.state().lv = 30; } },   // new event
      { when: function (l) { return l.tones.length >= 1; }, run: function () { FC.state().motion = 0; FC.state().lv = 0; } },
      { when: function (l) { return countUrls(l, /\/d\?f=j/) > 5; }, key: 'prev' },
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
      { when: function (l) { return l.jpgs.length >= 3; }, run: function () { FC.state().motion = 1; FC.state().lv = 20; } },
      { when: function (l) { return l.tones.length >= 1; }, key: 'prev' },
      { when: MENU(2), key: 'esc' }
    ])
  });
  check('motion in the live viewer beeps once and blinks the LED', L.tones.length === 1 && L.tones[0][0] === 1900 && L.blinks === 1, '(' + L.tones.length + ')');
  FC.reset({ mode: 0 });
  L = runApp({ keys: script([{ when: MENU(1), key: 'sel' }, { when: function (l) { return l.jpgs.length >= 3; }, run: function (l) { FC.state().motion = 1; l.motionAt = l.urls.length; } },
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
      { when: null, key: 'next' },           // Alerts
      { when: null, key: 'sel' },            // Beep+LED -> Off
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
      { when: null, key: 'next' },           // Alerts
      { when: null, key: 'sel' },            // Beep + LED -> Off
      { when: null, key: 'esc' },            // back to the main menu (cursor on Settings)
      { when: null, key: 'prev' }, { when: null, key: 'prev' }, { when: null, key: 'prev' }, { when: null, key: 'prev' },
      { when: null, key: 'sel' },            // Watch live
      { when: function (l) { return l.jpgs.length >= 3; }, run: function (l) { FC.state().motion = 1; FC.state().lv = 30; l.motionAt = l.urls.length; } },
      { when: function (l) { return l.urls.length > l.motionAt + 8; }, key: 'prev' },   // give the camera's reply time to carry the motion flag
      { when: null, key: 'esc' }
    ]))
  });
  check('with alerts Off the live viewer stays silent too', L.jpgs.length >= 8 && L.tones.length === 0 && L.blinks === 0, '(' + L.jpgs.length + ' strips, ' + L.tones.length + ' tones, ' + L.blinks + ' blinks, alertLevel ' + alertLevel + ')');
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
  check('auto-record is not a Stick setting: nothing is written to the Stick', L.writes === 0);

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
  // change three Stick settings: each one is saved as a whole file
  FC.reset();
  var L = runApp({
    keys: script(toSettings().concat([
      { when: null, key: 'sel' },                                               // Picture: Photo -> Fast
      { when: null, key: 'next' }, { when: null, key: 'sel' },                  // Alerts: Beep+LED -> Off
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
  check('each change is written (three writes) and the file is one valid JSON object', L.writes === 3 && saved !== null, '(' + L.files['/MiniCCTV.cfg'] + ')');
  check('the file holds the new defaults', saved !== null && saved.photo === 0 && saved.alerts === 0 && saved.hud === 0 && saved.v === 1);
  check('no camera was needed for any of it', L.urls.length === 0);
  check('the rows show the new values', anyText(L, /^Fast$/) && anyText(L, /^Off$/));

  // next start: the defaults are used (Fast picture, LED-only alerts, no info chip)
  FC.reset({ mode: 1 });
  L = runApp({
    files: { '/MiniCCTV.cfg': '{"v":1,"photo":0,"alerts":1,"hud":0}' },
    keys: script([
      { when: MENU(1), key: 'sel' },
      { when: function (l) { return l.bitmaps.length >= 3; }, run: function (l) { FC.state().motion = 1; FC.state().lv = 20; l.motionAt = l.urls.length; } },
      { when: function (l) { return l.urls.length > l.motionAt + 8; }, key: 'prev' },
      { when: MENU(2), key: 'esc' }
    ])
  });
  check('a saved Fast default is used from the first picture on', L.bitmaps.length >= 3 && L.jpgs.length === 0 && countUrls(L, /\/d\?f=j/) === 0);
  check('a saved Info line Off hides the info chip', !anyText(L, /^(FAST|PHOTO) /));
  check('a saved LED-only alert level blinks without beeping', L.blinks === 1 && L.tones.length === 0, '(' + L.blinks + ' blinks, ' + L.tones.length + ' tones)');

  // a damaged or out-of-range file is ignored, not trusted
  var bad = ['{oops', '', '[]', '{"v":1,"photo":7,"alerts":9,"hud":2}', '{"photo":"yes"}'];
  var okAll = true;
  for (var i = 0; i < bad.length; i++) {
    FC.reset();
    L = runApp({ files: { '/MiniCCTV.cfg': bad[i] }, keys: script([{ when: MENU(1), key: 'sel' }, { when: function (l) { return l.jpgs.length >= 3; }, key: 'prev' }, { when: MENU(2), key: 'esc' }]) });
    if (L.error !== '' || L.jpgs.length < 3 || L.bitmaps.length > 0 || L.writes !== 0 || photo !== true || hud !== true || alertLevel !== 2) {
      okAll = false;
      out('  bad config ' + JSON.stringify(bad[i]) + ' -> error "' + L.error + '", ' + L.jpgs.length + ' strips, ' + L.bitmaps.length + ' bands');
    }
  }
  check('damaged or out-of-range settings files fall back to the defaults (Photo) without crashing', okAll);

  // storage that throws must not break the app, and the setting still applies for this run
  FC.reset({ autoMotion: true });
  L = runApp({ storageBroken: true, keys: script(toFastWatch().concat([{ when: function (l) { return l.bitmaps.length >= 3; }, key: 'prev' }, { when: null, key: 'esc' }])) });
  check('with unusable storage the app still runs and the change applies for now', L.error === '' && L.bitmaps.length >= 3 && L.jpgs.length === 0, L.error);
};

SCENARIOS.settings_without_camera = function () {
  FC.reset({ down: true });
  var L = runApp({
    keys: script(toSettings().concat([
      { when: null, key: 'sel' },                                               // Picture works offline
      { when: null, key: 'prev' }, { when: null, key: 'sel' },                  // Auto-record needs the camera
      { when: function (l) { return anyText(l, /Joined WiFi, camera silent/); }, key: 'prev' },   // back out of the error
      { when: null, key: 'esc' },
      { when: MENU(2), key: 'esc' }
    ]))
  });
  check('app ran without throwing', L.error === '', L.error);
  check('Stick-side settings change and save with the camera off', L.writes === 1 && anyText(L, /^Fast$/));
  check('camera-side rows wait ("...") until the camera has answered', anyText(L, /^\.\.\.$/));
  check('pressing one tries to connect and explains when it cannot', anyText(L, /Joined WiFi, camera silent/) && countUrls(L, /\/ctl\?auto/) === 0);
  check('...and leaves you in Settings, then the main menu', L.menuDraws >= 2);
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
      { when: MENU(2), key: 'sel' },
      { when: function (l) { return has(l.brightness, 2); }, run: function () { FC.state().mseq = 1; FC.state().motion = 1; } },
      { when: function (l) { return l.irs.length >= 1; }, run: function () { FC.state().motion = 0; } },
      { when: function (l) { return countUrls(l, /\/d\?f=j/) > 100; }, run: function () { FC.state().mseq = 2; FC.state().motion = 1; } },   // a second event, seconds later
      { when: function (l) { return l.tones.length >= 2; }, run: function () { FC.state().motion = 0; } },
      { when: function (l) { return countUrls(l, /\/d\?f=j/) > 300; }, key: 'prev' },
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
  check('a config mismatch is reported instead of drawing garbage', anyText(L, /Camera sends 320x240/) && L.jpgs.length === 0);
  FC.reset();
  L = runApp({ keys: script([{ when: MENU(1), key: 'sel' }, { when: function (l) { return l.jpgs.length >= 3; }, key: 'esc' }]) });
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
  check('a truncated reply is rejected and nothing half-drawn', L.jpgs.length === 0 && L.bitmaps.length === 0 && L.error === '');

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
  check('a reply shorter than its declared length is rejected even if it parses', L.jpgs.length === 0 && L.error === '');

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
    var m = /\/d\?f=j&s=(\d+)$/.exec(L.urls[i]);
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
    keys: script(toFastWatch().concat([
      { when: function (l) { return countUrls(l, /\/d\?f=8&s=1$/) >= 3; }, run: function (l) { l.snap = new Uint8Array(l.fb); }, key: 'esc' }
    ]))
  });
  check('golden raw8: app ran without throwing', L.error === '', L.error);
  check('golden raw8: 9 bands drawn, the last one 7 rows', L.bitmaps.length >= 9 && L.bitmaps[8].h === 7 && L.bitmaps[0].h === 16);
  check('golden raw8: the screen equals the frame the C++ encoder was given', frameEquals(L.snap, fb8) === -1);
  check('golden raw8: it then asks for since=1 (the seq in the reply)', countUrls(L, /\/d\?f=8&s=1$/) >= 1);
  check('golden raw8: motion level and flags from the header are read', hdrMotion === 37 && hdrFlags === 10, '(' + hdrMotion + ',' + hdrFlags + ')');

  var dj = new Uint8Array(GOLDEN.dj);
  var side = GOLDEN.djside;
  L = runApp({
    fetch: function (url) {
      if (/\/d\?/.test(url)) { return { status: 200, body: new Uint8Array(dj), length: dj.length }; }
      return null;
    },
    keys: script([{ when: MENU(1), key: 'sel' }, { when: function (l) { return l.jpgs.length >= 2; }, key: 'esc' }])
  });
  check('golden jpg: bands 2 and 8 are drawn at y=32 and y=128', L.jpgs.length >= 2 && L.jpgs[0].y === 32 && L.jpgs[1].y === 128);
  check('golden jpg: strip sizes and first bytes match what the encoder wrote',
    L.jpgs.length >= 2 && L.jpgs[0].len === side[0][1] && L.jpgs[1].len === side[1][1] && L.jpgs[0].b0 === side[0][2] && L.jpgs[1].b1 === side[1][3]);
};

SCENARIOS.long_run_memory = function () {
  // many frames on the real engine: catches leaks and heap exhaustion
  FC.reset({ autoMotion: true });
  var L = runApp({
    maxTicks: 200000,
    keys: script([{ when: MENU(1), key: 'sel' }, { when: function (l) { return l.jpgs.length >= 1500; }, key: 'prev' }, { when: MENU(2), key: 'esc' }])
  });
  check('1500 picture updates in Photo mode without running out of memory', L.error === '' && L.jpgs.length >= 1500 && !L.timeout, L.error);
  FC.reset({ autoMotion: true });
  L = runApp({
    maxTicks: 200000,
    keys: script(toFastWatch().concat([
      { when: function (l) { return l.bitmaps.length >= 1500; }, key: 'prev' }, { when: null, key: 'esc' }
    ]))
  });
  check('1500 picture updates in Fast mode without running out of memory', L.error === '' && L.bitmaps.length >= 1500 && !L.timeout, L.error);
};

SCENARIOS.footprint = function () {
  // Used by tools/mq_footprint.js, which shrinks the engine's heap until this stops working.
  // Fast mode first (it handles full 32 KB pictures), then Photo mode.
  FC.reset({ autoMotion: true });
  var L = runApp({
    light: true, maxTicks: 200000,
    keys: script(toFastWatch().concat([
      { when: function (l) { return l.bitmapCount >= 300; }, key: 'prev' }, { when: null, key: 'esc' }
    ]))
  });
  check('300 Fast updates ran', L.error === '' && L.bitmapCount >= 300, L.error);
  FC.reset({ autoMotion: true });
  L = runApp({
    light: true, maxTicks: 200000,
    keys: script([{ when: MENU(1), key: 'sel' }, { when: function (l) { return l.jpgCount >= 300; }, key: 'prev' }, { when: MENU(2), key: 'esc' }])
  });
  check('300 Photo updates ran', L.error === '' && L.jpgCount >= 300, L.error);
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
