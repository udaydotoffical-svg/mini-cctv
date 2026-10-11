// Draws what the Stick's screen shows, as PNGs, by running the real bruce/MiniCCTV.js against a fake
// camera and a software model of Bruce's display (tools/ui/raster.js).
//
//   node tools/ui_preview.js [out_dir [scene]]        (default out_dir: docs/screens)
//
// The picture in the viewer shots is a made-up scene, not a real camera frame. Colours are close to,
// not exactly, what the panel shows.
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { Screen, makeDisplay } = require('./ui/raster');

const only = process.argv[3]; // optional: run just this scene
const outDir = process.argv[2] || path.join(__dirname, '..', 'docs', 'screens');
fs.mkdirSync(outDir, { recursive: true });
const read = (p) => fs.readFileSync(p, 'utf8');
const appSrc = read(process.env.APP || path.join(__dirname, '..', 'bruce', 'MiniCCTV.js'));
const fakecamSrc = read(path.join(__dirname, 'mq', 'fakecam.js'));
const W = 240, H = 135, NB = 9, BH = 16;

// a pleasant stand-in picture, RGB332
function scene() {
  const px = new Uint8Array(W * H);
  const pack = (r, g, b) => (r & 0xe0) | ((g & 0xe0) >> 3) | (b >> 6);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r, g, b;
      if (y < 80) { const t = y / 80; r = 30 + 90 * t; g = 40 + 80 * t; b = 90 + 110 * t; }
      else { const t = (y - 80) / 55; r = 70 - 30 * t; g = 82 - 30 * t; b = 70 - 30 * t; }
      if (x > 150 && x < 215 && y > 28 && y < 92) { r = 150; g = 130; b = 110; if ((x % 14) < 8 && (y % 16) < 9 && y > 36) { r = 230; g = 210; b = 120; } }
      if (x > 62 && x < 82 && y > 54 && y < 100) { r = 28; g = 30; b = 38; }
      if ((x - 72) * (x - 72) + (y - 48) * (y - 48) < 80) { r = 200; g = 160; b = 130; }
      px[y * W + x] = pack(r, g, b);
    }
  }
  return px;
}
const SCENE = scene();

let failed = false;

function run(name, opts, steps) {
  if (only && only !== name) return null;
  const scr = new Screen(W, H);
  const L = { texts: [], ticks: 0, shots: {} };
  let CLOCK = 1000000, stepNo = 0, pending = null, doneFlag = false;
  const fs0 = opts.files || {};
  const state = { flags: 2, motion: 0 };
  const ctx = vm.createContext({ print: () => {}, gc: () => {} });
  ctx.delay = (ms) => {
    CLOCK += ms;
    // a screen that is only up during a delay (the no-SD notice) is shot from here
    const s = steps[stepNo];
    if (s && s.onDelay && (!s.when || s.when(L, FC, state))) {
      stepNo++;
      if (s.shot) { fs.writeFileSync(path.join(outDir, s.shot + '.png'), scr.toPng(3)); L.shots[s.shot] = 1; }
    }
  };
  ctx.now = () => CLOCK;
  vm.runInContext(fakecamSrc, ctx);
  ctx.FC.reset(opts.fc || {});
  const FC = ctx.FC;

  const take = (key) => {
    L.ticks++; CLOCK += 1;
    if (process.env.PV_DEBUG && L.ticks % 2000 === 0) console.error(name, 'tick', L.ticks, 'step', stepNo, JSON.stringify(L.texts.slice(-3)));
    if (L.ticks > 40000 && !doneFlag) { L.stalled = stepNo; doneFlag = true; pending = 'esc'; }
    if (doneFlag && pending === null) pending = 'esc'; // leave however many menus deep the app is
    if (pending === null && !doneFlag) {
      while (stepNo < steps.length) {
        const s = steps[stepNo];
        if (s.when && !s.when(L, FC, state)) break;
        stepNo++;
        if (s.run) s.run(L, FC, state);
        if (s.shot) { fs.writeFileSync(path.join(outDir, s.shot + '.png'), scr.toPng(3)); L.shots[s.shot] = 1; }
        if (s.key) { pending = s.key; break; }
      }
      if (stepNo >= steps.length && pending === null) { doneFlag = true; pending = 'esc'; }
    }
    if (pending === key) { pending = null; return true; }
    return false;
  };
  let net = opts.home ? 'home' : opts.preconnected ? 'cam' : 'none';
  const mods = {
    display: makeDisplay(scr, { text: (t) => L.texts.push(t) }),
    keyboard: { getEscPress: () => take('esc'), getSelPress: () => take('sel'), getPrevPress: () => take('prev'), getNextPress: () => take('next') },
    wifi: {
      connected: () => net !== 'none', getIPAddress: () => (net === 'cam' ? '192.168.4.2' : net === 'home' ? '192.168.1.50' : null),
      connect: (ssid) => { CLOCK += 1000; if (opts.joinFails) return false; net = ssid === 'ESP32-CAM-S3' ? 'cam' : 'home'; return true; }, connectDialog: () => { net = 'home'; return true; }, disconnect: () => { net = 'none'; },
      httpFetch: (url, o) => {
        if (url.indexOf('https://') === 0) { // the "internet": the list of latest versions
          return { status: 200, body: { app: '2.2.0', app_url: url.replace('dist/version.json', 'bruce/MiniCCTV.js'), app_size: 66000, fw: '2.2.0' }, length: 0 };
        }
        if (/\/d\?/.test(url)) {
          const since = parseInt(/s=(\d+)/.exec(url)[1], 10);
          CLOCK += 60;
          const full = since < 1;
          const mask = full ? (1 << NB) - 1 : 0;
          let total = 8;
          if (full) total += NB * 2 + W * H;
          const out = new Uint8Array(total);
          out[0] = mask & 255; out[1] = mask >> 8; out[2] = 1; out[6] = state.motion; out[7] = state.flags;
          if (full) {
            let off = 8;
            for (let i = 0; i < NB; i++) {
              const rows = i === NB - 1 ? H - (NB - 1) * BH : BH, n = rows * W;
              out[off] = n & 255; out[off + 1] = n >> 8; off += 2;
              out.set(SCENE.subarray(i * BH * W, i * BH * W + n), off); off += n;
            }
          }
          return { status: 200, body: out, length: total };
        }
        const r = FC.handle(url, o);
        return r;
      },
    },
    audio: { tone: () => {} }, notification: { blink: () => {} }, ir: { transmitFile: () => true },
    storage: {
      read: (p) => { const k = typeof p === 'object' ? p.path : p; if (!(k in fs0)) throw new TypeError('storageRead: File: ' + k + ' does not exist'); return fs0[k]; },
      write: (p, data, mode) => { const k = typeof p === 'object' ? p.path : p; fs0[k] = (mode === 'write' || !(k in fs0)) ? data : fs0[k] + data; return true; },
    },
  };
  ctx.MODS = mods;
  ctx.require = (n) => mods[n];
  ctx.__filepath = '/BruceJS/MiniCCTV.js'; // Bruce tells a script where it lives
  ctx.__dirpath = '/BruceJS/';
  ctx.state = state;
  try { vm.runInContext(appSrc, ctx, { filename: 'MiniCCTV.js' }); } catch (e) { console.log(`  ${name}: app threw ${e.message}`); failed = true; }
  if (L.stalled !== undefined) console.log(`  ${name}: stalled at step ${L.stalled}: ${JSON.stringify(Object.keys(steps[L.stalled]))} ${steps[L.stalled].when ? steps[L.stalled].when.toString().slice(0, 80) : ''}`);
  const missing = steps.filter((s) => s.shot && !L.shots[s.shot]).map((s) => s.shot);
  if (missing.length || scr.outside) failed = true;
  console.log(`${missing.length ? 'FAIL' : 'ok  '} ${name}: ${Object.keys(L.shots).length} shots${missing.length ? ' (missing ' + missing.join(', ') + ')' : ''}${scr.outside ? `, ${scr.outside} px drawn off-screen` : ''}`);
  return L;
}

const seen = (re) => (L) => L.texts.some((t) => re.test(t));
const frames = (n) => { let base = null; return (L) => { if (base === null) base = L.ticks; return L.ticks - base > n; }; };

// ---- the tour: menus, viewer, camera screen, settings, guard ----
run('tour', { files: { '/MiniCCTV.cfg': '{"v":3,"alerts":2,"hud":1}' }, fc: { autoMotion: false, free: 12000 } }, [
  { shot: 'menu_main', key: 'sel', when: () => true },                                 // Watch live
  { when: frames(25), run: (L, FC, s) => { s.flags = 2 | 1; s.motion = 38; } },       // recording + motion
  { when: frames(2), shot: 'viewer_live' },
  { when: () => true, key: 'next' },                                                    // photo
  { when: seen(/Saved IMG/), shot: 'viewer_toast', key: 'sel' },                       // actions
  { shot: 'actions', key: 'esc', when: () => true },                                   // close it
  { when: frames(8), key: 'prev' },                                                    // back to the main menu
  { shot: 'menu_connected', key: 'next', when: () => true },
  { key: 'sel' },                                                                       // Camera (the viewfinder)
  { when: frames(25), shot: 'camera_photo' },
  { key: 'next', when: () => true }, { key: 'next' }, { key: 'next' },                  // Burst, Timer, Video
  { when: frames(6), shot: 'camera_video' },
  { key: 'sel', when: () => true },                                                     // start a clip
  { when: frames(10), shot: 'camera_recording', key: 'esc' },                           // UP+DOWN: back to the menu
  { key: 'next', when: () => true }, { key: 'next' }, { key: 'next' }, { key: 'next' }, // Settings
  { key: 'sel' },
  { shot: 'settings', key: 'next', when: () => true },
  { key: 'next' }, { key: 'next' },
  { shot: 'settings_mode', key: 'sel', when: () => true },                             // Mode picker
  { shot: 'mode_picker', key: 'esc', when: () => true },
  { key: 'next', when: () => true }, { key: 'next' }, { key: 'next' },
  { shot: 'settings_more', key: 'next', when: () => true },
  { key: 'next' }, { key: 'next' }, { key: 'next' },
  { shot: 'settings_versions', key: 'esc', when: () => true },
  { key: 'prev', when: () => true }, { key: 'prev' }, { key: 'prev' },                  // up to Guard mode
  { key: 'sel' },
  { when: frames(40), shot: 'guard' },
]);

// the update flow, started at launch on a home WiFi
run('update', { home: true, files: { '/MiniCCTV.cfg': '{"v":4,"alerts":2,"hud":1,"camFw":"2.1.0","homeSsid":"Home"}' }, fc: { fw: '2.1.0' } }, [
  { onDelay: true, when: seen(/Installing in 3 s/), shot: 'update_app' },
  { key: 'prev', when: () => true },                                                   // skip the app update
  { shot: 'update_camera', key: 'sel', when: seen(/Check and update it now/) },        // yes
  { shot: 'update_confirm', key: 'prev', when: seen(/Next: your home WiFi name/) },    // later
]);

// camera not reachable
run('cannot_connect', { fc: { down: true } }, [
  { key: 'sel', when: () => true },
  { when: seen(/Joined WiFi, camera silent/), shot: 'cannot_connect' },
]);
// no SD card notice
run('no_sd', { fc: { sd: 0 } }, [
  { key: 'sel', when: () => true },
  { onDelay: true, when: seen(/Insert a FAT32/), shot: 'no_sd' },
]);
// gallery
run('gallery', { fc: {}, preconnected: true }, [
  { key: 'next', when: () => true }, { key: 'next' }, { key: 'next' },
  { key: 'sel' },
  { when: seen(/^PHOTOS$/i), key: 'sel', shot: 'gallery_menu' },
  { when: seen(/^IMG_0041$/), shot: 'gallery_files' },
]);
process.exit(failed ? 1 : 0);
