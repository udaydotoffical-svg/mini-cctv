// Host-side test for bruce/MiniCCTV.js.
//
// Runs the real app script in a vm with mocked Bruce modules. The mocks follow what
// Bruce's firmware really does (checked against src/modules/bjs_interpreter in pr3y/Bruce):
//   - display.drawBitmap(x, y, data, w, h, 8) requires data.length === w*h exactly
//   - display.drawJpg(Uint8Array, x, y) takes a whole JPEG
//   - wifi.httpFetch returns {status, body: Uint8Array, length}; body is a COPY with offset 0
//   - button flags are consumed when read; Prev+Next together = Esc
// wifi.httpFetch is backed by curl against tools/fake_cam.py, or by golden files written by
// the C++ test (tools/test_delta) so the firmware's real byte format is parsed by the real app.
//
//   python3 tools/fake_cam.py 8099 &
//   g++ -std=c++17 -I firmware/mini_cctv tools/test_delta.cpp -o /tmp/test_delta && /tmp/test_delta /tmp/golden
//   node tools/test_app.js 8099 /tmp/golden
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const port = process.argv[2] || '8099';
const goldenDir = process.argv[3] || '/tmp/claude-0/golden';
const src = fs.readFileSync(process.env.APP || path.join(__dirname, '..', 'bruce', 'MiniCCTV.js'), 'utf8');
const W = 240, H = 135;

let failed = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failed++;
}

// Bruce's JS_GetTypedArrayBuffer() returns the START of the underlying buffer and ignores a view's
// byteOffset (mquickjs.c), so drawing from a subarray would paint the wrong bytes. Forbid it here.
function viewCheck(data, who) {
  if (data.byteOffset !== 0) throw new Error(`${who}: array view with byteOffset ${data.byteOffset}; Bruce would read from the buffer start`);
  if (data.buffer.byteLength !== data.length) throw new Error(`${who}: view does not span its whole buffer`);
}

function curl(url) {
  const r = spawnSync('curl', ['-s', '-m', '3', '-D', '-', '-o', '-', url], { maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error('connect failed');
  const buf = r.stdout;
  const split = buf.indexOf('\r\n\r\n');
  const head = buf.slice(0, split).toString();
  const body = buf.slice(split + 4);
  const m = /content-length:\s*(\d+)/i.exec(head);
  return { status: parseInt(head.split(' ')[1], 10), body, length: m ? parseInt(m[1], 10) : -1 };
}

// opts: keys(state) -> next key or null;  fetch(url, n) -> override reply or undefined;  maxTicks
function runApp(opts) {
  const log = {
    menuDraws: 0, jpgs: [], bitmaps: [], texts: [], urls: [], joins: 0, disconnects: 0,
    fb: new Uint8Array(W * H), errors: [], gc: 0, noSignal: 0, hudOff: false, reads: 0,
  };
  let pending = null;
  let ticks = 0;
  let connected = false;

  const take = (name) => {
    ticks++;
    if (ticks > (opts.maxTicks || 20000)) { pending = 'esc'; }
    if (!pending) pending = opts.keys(log) || null;
    if (pending === name) { pending = null; return true; }
    return false;
  };

  const modules = {
    display: {
      width: () => W, height: () => H,
      fill: () => {}, setTextSize: () => {}, setTextColor: () => {},
      color: (r, g, b) => ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3),
      drawString: (t) => {
        log.texts.push(t);
        if (t === 'MiniCCTV') log.menuDraws++;
        if (t === 'No signal') log.noSignal++;
      },
      drawFillRect: () => {}, drawFillRoundRect: () => {},
      drawJpg: (data, x, y, center) => {
        if (!(data instanceof Uint8Array)) throw new TypeError('drawJpg wants a Uint8Array');
        viewCheck(data, 'drawJpg');
        if (data[0] !== 0xff || data[1] !== 0xd8) throw new Error('drawJpg: not a JPEG');
        log.jpgs.push({ x, y, len: data.length, b0: data[0], b1: data[1], center });
      },
      drawBitmap: (x, y, data, w, h, bpp) => {
        if (!(data instanceof Uint8Array)) throw new TypeError('drawBitmap wants a Uint8Array');
        viewCheck(data, 'drawBitmap');
        if (bpp !== 8) throw new Error('only 8bpp used');
        // Bruce: "Bitmap size mismatch" is a thrown TypeError
        if (data.length !== w * h) throw new TypeError(`drawBitmap: Bitmap size mismatch! Got ${data.length}, expected ${w * h}`);
        if (x < 0 || y < 0 || x + w > W || y + h > H) throw new Error('drawBitmap outside screen');
        for (let r = 0; r < h; r++) log.fb.set(data.subarray(r * w, (r + 1) * w), (y + r) * W + x);
        log.bitmaps.push({ x, y, w, h });
      },
    },
    keyboard: {
      getEscPress: () => take('esc'), getSelPress: () => take('sel'),
      getPrevPress: () => take('prev'), getNextPress: () => take('next'),
    },
    wifi: {
      connected: () => connected,
      getIPAddress: () => (connected ? '192.168.4.2' : null),
      connect: () => { log.joins++; connected = true; return opts.joinFails ? false : true; },
      connectDialog: () => true,
      disconnect: () => { log.disconnects++; connected = false; },
      httpFetch: (url, o) => {
        log.urls.push(url);
        const n = log.urls.length;
        if (opts.fetch) {
          const r = opts.fetch(url, n, log);
          if (r === 'throw') throw new Error('connect failed');
          if (r) return r;
        }
        const res = curl(url);
        if (o.responseType === 'json') return { status: res.status, body: JSON.parse(res.body.toString()), length: res.length };
        // Bruce's httpFetch hands back a fresh copy starting at offset 0
        return { status: res.status, body: new Uint8Array(res.body), length: res.length };
      },
    },
  };

  const sandbox = {
    require: (n) => modules[n], delay: () => {}, now: () => Date.now(),
    gc: () => { log.gc++; }, console, Math, Uint8Array, JSON,
  };
  vm.createContext(sandbox);
  try { vm.runInContext(src.replace("var CAM_HOST = 'http://192.168.4.1';", `var CAM_HOST = 'http://127.0.0.1:${port}';`), sandbox); }
  catch (e) { log.errors.push(String(e)); }
  log.ticks = ticks;
  return log;
}

// Press a key once the condition holds; a tiny scripting helper.
function script(steps) {
  let i = 0;
  return (log) => {
    if (i >= steps.length) return null;
    const s = steps[i];
    if (s.when(log)) { i++; return s.key; }
    return null;
  };
}

const sameFb = (log, expected) => { for (let i = 0; i < W * H; i++) if (log.fb[i] !== expected[i]) return i; return -1; };

// ---------------------------------------------------------------- 1. whole app against the fake camera
{
  const frame8 = (n) => new Uint8Array(curl(`http://127.0.0.1:${port}/frame8?n=${n}`).body);
  let snapshot = null, snapSeq = 0;
  const l = runApp({
    keys: script([
      { when: (l) => l.menuDraws >= 1, key: 'sel' },                       // Watch live (Photo is the default)
      { when: (l) => l.jpgs.length >= 12, key: 'next' },                   // DOWN: switch to Fast
      { when: (l) => l.bitmaps.length >= 36, key: 'sel' },                 // M5: hide info
      { when: (l) => l.urls.length >= 40, key: 'prev' },                   // UP: back to menu
      { when: (l) => l.menuDraws >= 2, key: 'prev' },                      // wrap to Exit
      { when: (l) => l.menuDraws >= 3, key: 'sel' },                       // Exit
    ]),
  });
  check('app ran without throwing', l.errors.length === 0, l.errors[0]);
  check('menu drawn, viewer entered, menu again, then exited via the Exit item', l.menuDraws === 3, `(menu draws ${l.menuDraws})`);
  check('Photo mode draws JPEG strips', l.jpgs.length >= 12);
  check('every strip is a whole JPEG at x=0 and a band boundary (y multiple of 16)',
    l.jpgs.every((j) => j.b0 === 0xff && j.b1 === 0xd8 && j.x === 0 && j.y % 16 === 0 && j.y <= 128));
  check('first Photo update paints all 9 bands', new Set(l.jpgs.slice(0, 9).map((j) => j.y)).size === 9);
  check('later updates send fewer bands (only the moving box rows)', l.jpgs.length < 9 * 12 + 1 && l.jpgs.length > 9);
  check('Fast mode draws raw bands', l.bitmaps.length >= 36);
  check('requests use the band protocol with a since value',
    l.urls.some((u) => /\/d\?f=j&s=0$/.test(u)) && l.urls.some((u) => /\/d\?f=8&s=0$/.test(u)) && l.urls.some((u) => /\/d\?f=8&s=[1-9]/.test(u)));
  check('status probed before streaming', /\/status$/.test(l.urls[0]));
  check('joined the camera WiFi once', l.joins === 1, `(${l.joins})`);

  // Screen content: after the mode switch the first Fast reply is a full picture (s=0), later ones deltas.
  // The framebuffer must now equal the camera's picture at the last seq the app received.
  const lastS = Math.max(...l.urls.filter((u) => /f=8/.test(u)).map((u) => parseInt(/s=(\d+)/.exec(u)[1], 10)));
  // The fake camera advances once per /d request; ask it which update it is on now.
  const finalSeq = JSON.parse(curl(`http://127.0.0.1:${port}/status`).body.toString()).seq;
  const exp = frame8(finalSeq);
  const bad = sameFb(l, exp);
  check('Fast mode: screen equals the camera picture at the final update (deltas applied correctly)', bad === -1,
    bad === -1 ? '' : `(first mismatch at pixel ${bad}, got ${l.fb[bad]} expected ${exp[bad]}; lastS ${lastS}, final ${finalSeq})`);
}

// ---------------------------------------------------------------- 2. real firmware bytes (golden files from tools/test_delta)
{
  const d8 = new Uint8Array(fs.readFileSync(path.join(goldenDir, 'd8_full.bin')));
  const fb8 = new Uint8Array(fs.readFileSync(path.join(goldenDir, 'd8_full_fb.bin')));
  const empty = (seq) => new Uint8Array([0, 0, seq & 255, (seq >> 8) & 255, 0, 0]);
  const l = runApp({
    keys: script([
      { when: (l) => l.menuDraws >= 1, key: 'next' },     // select "Mode"
      { when: (l) => l.menuDraws >= 2, key: 'sel' },      // Photo -> Fast
      { when: (l) => l.menuDraws >= 3, key: 'prev' },     // back to "Watch live"
      { when: (l) => l.menuDraws >= 4, key: 'sel' },
      { when: (l) => l.urls.length >= 6, key: 'esc' },    // UP+DOWN quits straight from the viewer
    ]),
    fetch: (url, n) => {
      if (/\/status$/.test(url)) return { status: 200, body: { w: W, h: H, bands: 9, band_h: 16 }, length: 20 };
      if (/\/d\?f=8&s=0$/.test(url)) return { status: 200, body: new Uint8Array(d8), length: d8.length };
      return { status: 200, body: empty(1), length: 6 };
    },
  });
  check('golden raw8: app ran without throwing', l.errors.length === 0, l.errors[0]);
  check('golden raw8: 9 bands drawn, last one 7 rows', l.bitmaps.length >= 9 && l.bitmaps[8].h === 7 && l.bitmaps[0].h === 16);
  check('golden raw8: screen equals the frame the C++ encoder was given', sameFb(l, fb8) === -1);
  check('golden raw8: afterwards asks for since=1 (the seq in the reply)', l.urls.some((u) => /f=8&s=1$/.test(u)));

  const dj = new Uint8Array(fs.readFileSync(path.join(goldenDir, 'dj_partial.bin')));
  const side = fs.readFileSync(path.join(goldenDir, 'dj_partial.txt'), 'utf8').trim().split('\n').map((s) => s.split(' ').map(Number));
  const l2 = runApp({
    keys: script([
      { when: (l) => l.menuDraws >= 1, key: 'sel' },
      { when: (l) => l.urls.length >= 5, key: 'esc' },
    ]),
    fetch: (url) => {
      if (/\/status$/.test(url)) return { status: 200, body: { w: W, h: H, bands: 9, band_h: 16 }, length: 20 };
      return { status: 200, body: new Uint8Array(dj), length: dj.length };
    },
  });
  const first2 = l2.jpgs.slice(0, 2);
  check('golden jpg: app ran without throwing', l2.errors.length === 0, l2.errors[0]);
  check('golden jpg: bands 2 and 8 drawn at y=32 and y=128', first2.length === 2 && first2[0].y === 32 && first2[1].y === 128);
  check('golden jpg: strip sizes and contents match what the encoder wrote',
    first2.length === 2 && first2[0].len === side[0][1] && first2[1].len === side[1][1] && first2[0].b0 === side[0][2] && first2[1].b1 === side[1][3]);
  check('golden jpg: asks for since=4 afterwards', l2.urls.some((u) => /f=j&s=4$/.test(u)));
}

// ---------------------------------------------------------------- 3. camera unreachable
{
  const l = runApp({
    keys: script([
      { when: (l) => l.menuDraws >= 1, key: 'sel' },
      { when: (l) => l.texts.some((t) => t === 'Joined WiFi, camera silent'), key: 'prev' },   // UP back
      { when: (l) => l.menuDraws >= 2, key: 'esc' },
    ]),
    fetch: () => 'throw',
  });
  check('unreachable camera: explains why and lets you back out', l.texts.includes('Joined WiFi, camera silent') && l.menuDraws >= 2);
  check('unreachable camera: nothing drawn', l.jpgs.length === 0 && l.bitmaps.length === 0);
  check('unreachable camera: probes a few times, not forever', l.urls.length === 3, `(${l.urls.length})`);
}
{
  const l = runApp({
    keys: script([{ when: (l) => l.menuDraws >= 1, key: 'sel' }, { when: (l) => l.texts.some((t) => /Couldn't join/.test(t)), key: 'prev' }, { when: (l) => l.menuDraws >= 2, key: 'esc' }]),
    joinFails: true,
  });
  check("can't join WiFi: says so and backs out", l.texts.some((t) => /Couldn't join/.test(t)) && l.urls.length === 0);
}
{
  const l = runApp({
    keys: script([{ when: (l) => l.menuDraws >= 1, key: 'sel' }, { when: (l) => l.texts.some((t) => /Camera sends/.test(t)), key: 'prev' }, { when: (l) => l.menuDraws >= 2, key: 'esc' }]),
    fetch: (url) => (/\/status$/.test(url) ? { status: 200, body: { w: 320, h: 240 }, length: 10 } : undefined),
  });
  check('config mismatch (camera 320x240): reported instead of drawing garbage', l.texts.some((t) => /Camera sends 320x240/.test(t)) && l.bitmaps.length === 0);
}

// ---------------------------------------------------------------- 4. trouble mid-stream
{
  // camera answers 6 times, then vanishes for a while, then comes back
  const good = new Uint8Array(fs.readFileSync(path.join(goldenDir, 'd8_full.bin')));
  const empty = new Uint8Array([0, 0, 1, 0, 0, 0]);
  let streamReqs = 0;
  const l = runApp({
    keys: script([
      { when: (l) => l.menuDraws >= 1, key: 'next' }, { when: (l) => l.menuDraws >= 2, key: 'sel' },   // Fast mode
      { when: (l) => l.menuDraws >= 3, key: 'prev' }, { when: (l) => l.menuDraws >= 4, key: 'sel' },
      { when: (l) => l.noSignal >= 2 && streamReqs > 30, key: 'prev' },                                // UP out of the viewer
      { when: (l) => l.menuDraws >= 5, key: 'prev' }, { when: (l) => l.menuDraws >= 6, key: 'sel' },   // Exit
    ]),
    fetch: (url) => {
      if (/\/status$/.test(url)) return { status: 200, body: { w: W, h: H }, length: 20 };
      streamReqs++;
      if (streamReqs <= 6) return { status: 200, body: streamReqs === 1 ? new Uint8Array(good) : new Uint8Array(empty), length: streamReqs === 1 ? good.length : 6 };
      if (streamReqs <= 20) return 'throw';
      return { status: 200, body: new Uint8Array(empty), length: 6 };
    },
  });
  check('mid-stream outage: shows "No signal"', l.noSignal >= 1);
  check('mid-stream outage: reconnects (and does a clean disconnect on repeated outages)', l.joins >= 2 && l.disconnects >= 1, `(joins ${l.joins}, disc ${l.disconnects})`);
  check('mid-stream outage: restarts from a full picture (s=0) once back', l.urls.slice(-12).some((u) => /s=0$/.test(u)));
  check('mid-stream outage: app still exits cleanly', l.errors.length === 0 && l.menuDraws >= 6, l.errors[0]);
}
{
  // truncated reply (body shorter than Content-Length) must not be drawn
  const good = new Uint8Array(fs.readFileSync(path.join(goldenDir, 'd8_full.bin')));
  let reqs = 0;
  const l = runApp({
    maxTicks: 400,
    keys: script([{ when: (l) => l.menuDraws >= 1, key: 'next' }, { when: (l) => l.menuDraws >= 2, key: 'sel' }, { when: (l) => l.menuDraws >= 3, key: 'prev' }, { when: (l) => l.menuDraws >= 4, key: 'sel' }]),
    fetch: (url) => {
      if (/\/status$/.test(url)) return { status: 200, body: { w: W, h: H }, length: 20 };
      reqs++;
      return { status: 200, body: new Uint8Array(good.subarray(0, 20000)), length: good.length };
    },
  });
  check('truncated reply is rejected, nothing half-drawn', l.bitmaps.length === 0 && l.errors.length === 0, `(${l.bitmaps.length} bitmaps, ${l.errors[0] || 'no error'})`);
}
{
  // camera reboot: it reports a seq lower than ours
  const good = new Uint8Array(fs.readFileSync(path.join(goldenDir, 'd8_full.bin')));
  const at = (seq) => { const b = new Uint8Array([0, 0, seq & 255, (seq >> 8) & 255, 0, 0]); return b; };
  let reqs = 0;
  const l = runApp({
    keys: script([{ when: (l) => l.menuDraws >= 1, key: 'next' }, { when: (l) => l.menuDraws >= 2, key: 'sel' }, { when: (l) => l.menuDraws >= 3, key: 'prev' }, { when: (l) => l.menuDraws >= 4, key: 'sel' }, { when: (l) => l.urls.length >= 14, key: 'esc' }]),
    fetch: (url) => {
      if (/\/status$/.test(url)) return { status: 200, body: { w: W, h: H }, length: 20 };
      reqs++;
      if (reqs === 1) { const g = new Uint8Array(good); g[2] = 50; return { status: 200, body: g, length: g.length }; } // camera at update 50
      if (reqs <= 4) return { status: 200, body: at(50), length: 6 };
      if (reqs === 5) return { status: 200, body: at(1), length: 6 };   // rebooted: now at update 1
      return { status: 200, body: at(1), length: 6 };
    },
  });
  const sVals = l.urls.filter((u) => /\/d\?/.test(u)).map((u) => parseInt(/s=(\d+)/.exec(u)[1], 10));
  check('camera reboot (seq goes backwards): app asks for a full picture again', sVals.includes(50) && sVals[sVals.indexOf(50) + 1] !== undefined && sVals.slice(sVals.lastIndexOf(50) + 1).includes(0), `(s sequence ${sVals.join(',')})`);
}

// ---------------------------------------------------------------- 5. no memory churn in Fast mode
{
  const good = new Uint8Array(fs.readFileSync(path.join(goldenDir, 'd8_full.bin')));
  const l = runApp({
    maxTicks: 3000,
    keys: script([{ when: (l) => l.menuDraws >= 1, key: 'next' }, { when: (l) => l.menuDraws >= 2, key: 'sel' }, { when: (l) => l.menuDraws >= 3, key: 'prev' }, { when: (l) => l.menuDraws >= 4, key: 'sel' }, { when: (l) => l.urls.length >= 100, key: 'esc' }]),
    fetch: (url) => (/\/status$/.test(url) ? { status: 200, body: { w: W, h: H }, length: 20 } : { status: 200, body: new Uint8Array(good), length: good.length }),
  });
  check('long run: periodic gc() is called', l.gc >= 4, `(${l.gc})`);
}

process.exit(failed ? 1 : 0);
