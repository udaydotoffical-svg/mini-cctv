// Host-side test for bruce/MiniCCTV.js.
//
// Runs the real script in a vm with mocked Bruce modules (display, keyboard,
// wifi, ...). wifi.httpFetch is backed by curl against tools/fake_cam.py, so it
// exercises the same {status, body: Uint8Array, length} contract as Bruce's
// native httpFetch (see src/modules/bjs_interpreter/wifi_js.cpp in pr3y/Bruce).
//
//   python3 tools/fake_cam.py 8099 &
//   node tools/test_app.js 8099
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const port = process.argv[2] || '8099';
const src = fs.readFileSync(path.join(__dirname, '..', 'bruce', 'MiniCCTV.js'), 'utf8');

function run(scenario) {
  const log = { jpg: [], text: [], joined: 0, disconnects: 0, fetches: 0, gc: 0 };
  let esc = false;
  let connected = false;
  const cfg = scenario.camUrl || `http://127.0.0.1:${port}/jpg`;

  const modules = {
    display: {
      width: () => 240,
      height: () => 135,
      fill: () => {},
      setTextSize: () => {},
      setTextColor: () => {},
      color: (r, g, b) => (r << 16) | (g << 8) | b,
      drawString: (t) => log.text.push(t),
      drawFillRect: () => {},
      drawJpg: (data, x, y, c) => {
        if (!(data instanceof Uint8Array)) throw new TypeError('drawJpg wants Uint8Array');
        log.jpg.push({ len: data.length, x, y, c, head: [data[0], data[1]] });
        if (log.jpg.length >= scenario.frames) esc = true;
      },
    },
    keyboard: { getEscPress: () => esc, getSelPress: () => false },
    wifi: {
      connected: () => connected,
      getIPAddress: () => (connected ? '192.168.4.2' : null),
      connect: () => { log.joined++; connected = true; return true; },
      connectDialog: () => true,
      disconnect: () => { log.disconnects++; connected = false; },
      httpFetch: (url, opts) => {
        log.fetches++;
        if (opts.responseType !== 'binary') throw new Error('expected binary');
        const r = spawnSync('curl', ['-s', '-m', '2', '-D', '-', '-o', '-', url], { maxBuffer: 1 << 24 });
        if (r.status !== 0) throw new Error('connect failed');
        const buf = r.stdout;
        const split = buf.indexOf('\r\n\r\n');
        const head = buf.slice(0, split).toString();
        const body = buf.slice(split + 4);
        const status = parseInt(head.split(' ')[1], 10);
        const m = /content-length:\s*(\d+)/i.exec(head);
        return { status, body: new Uint8Array(body), length: m ? parseInt(m[1], 10) : -1 };
      },
    },
  };

  const sandbox = {
    require: (n) => modules[n],
    delay: () => {},
    now: () => Date.now(),
    gc: () => { log.gc++; },
    console,
    Math,
    Uint8Array,
  };
  vm.createContext(sandbox);
  // shim the one Bruce behaviour we rely on: the script ends when ESC is pressed
  let guard = 0;
  const origEsc = modules.keyboard.getEscPress;
  modules.keyboard.getEscPress = () => {
    if (++guard > scenario.maxLoops) esc = true;
    return origEsc();
  };
  vm.runInContext(src.replace('var CAM_URL = \'http://192.168.4.1/jpg\';', `var CAM_URL = '${cfg}';`), sandbox);
  return log;
}

let failed = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failed++;
}

// 1. happy path
let l = run({ frames: 12, maxLoops: 200 });
check('draws 12 frames', l.jpg.length === 12, `(${l.jpg.length})`);
check('every frame starts with FFD8', l.jpg.every((j) => j.head[0] === 0xff && j.head[1] === 0xd8));
check('frame sizes sane (1-30 KB)', l.jpg.every((j) => j.len > 1000 && j.len < 30000), `(${l.jpg[0].len} B)`);
check('x offset centres 240px frame on 240px screen', l.jpg.every((j) => j.x === 0 && j.y === 0 && j.c === false));
check('joined cam wifi once', l.joined === 1, `(${l.joined})`);
check('status bar text drawn', l.text.some((t) => /fps/.test(t)));

// 2. camera unreachable -> backs off, reconnects, never draws garbage, exits on ESC
l = run({ frames: 99, maxLoops: 40, camUrl: 'http://127.0.0.1:1/jpg' });
check('no frames drawn when cam is down', l.jpg.length === 0);
check('reconnect attempted after repeated failures', l.disconnects >= 1 && l.joined >= 2, `(disc ${l.disconnects}, joins ${l.joined})`);

process.exit(failed ? 1 : 0);
