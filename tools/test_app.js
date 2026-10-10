// Runs tools/mq/suite.js (the tests for bruce/MiniCCTV.js) on two engines:
//   1. Node (vm), fast, good error messages
//   2. the real mquickjs engine Bruce runs (built from BruceDevices/mquickjs), which also enforces
//      Bruce's strict ES5 subset and a memory limit like the Stick's JS heap
//
//   node tools/test_app.js <golden_dir> [mqjs_binary] [scenario ...]
// The golden dir is written by tools/test_delta (real C++ encoder output). If no mqjs binary is
// given (or it isn't found), only Node runs.
const vm = require('vm');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const goldenDir = process.argv[2];
const mqjs = process.argv[3] && fs.existsSync(process.argv[3]) ? process.argv[3] : null;
const only = process.argv.slice(4);
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(p, 'utf8');
const suiteSrc = read(path.join(__dirname, 'mq', 'suite.js'));
const fakecamSrc = read(path.join(__dirname, 'mq', 'fakecam.js'));
const appPath = process.env.APP || path.join(root, 'bruce', 'MiniCCTV.js');
const appSrc = read(appPath);
// The scenarios carry a lot of test data, so they run with a generous heap. How much memory the app itself needs
// is measured separately (tools/mq_footprint.js).
const MQ_MEMORY = Number(process.env.MQ_MEMORY || 33554432);

// per-scenario edits to the app source (config the scenario needs)
const PATCHES = {
  ir_trigger: [["var IR_FILE = '';", "var IR_FILE = '/BruceIR/lamp.ir';"]],
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mqtest-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

// golden files -> a JS file (the engine can only load JS)
const bytes = (f) => Array.from(fs.readFileSync(path.join(goldenDir, f)));
const side = read(path.join(goldenDir, 'dj_partial.txt')).trim().split('\n').map((l) => l.split(' ').map(Number));
const modeLines = read(path.join(goldenDir, 'modes.txt')).trim().split('\n').map((l) => l.split('|'));
const filters = modeLines.pop().slice(1);
const modes = modeLines.map((l) => [l[0], l[1], Number(l[2]), Number(l[3])]);
const goldenSrc = 'var GOLDEN = ' + JSON.stringify({ d8: bytes('d8_full.bin'), d8fb: bytes('d8_full_fb.bin'), dj: bytes('dj_partial.bin'), djside: side, modes, filters }) + ';\n';
const smallGoldenSrc = 'var GOLDEN = ' + JSON.stringify({ d8: [], d8fb: [], dj: [], djside: [], modes, filters }) + ';\n';

const scenarios = [...suiteSrc.matchAll(/^SCENARIOS\.(\w+) = function/gm)].map((m) => m[1]).filter((n) => !only.length || only.includes(n));

function patchedApp(name) {
  let src = appSrc;
  for (const [a, b] of PATCHES[name] || []) {
    if (!src.includes(a)) throw new Error(`patch for ${name} does not match the app source: ${a}`);
    src = src.replace(a, b);
  }
  return src;
}

function runNode(name) {
  const lines = [];
  const ctx = vm.createContext({
    print: (s) => lines.push(String(s)),
    gc: () => {},
    SCENARIO: name,
    APP_PATH: appPath,
  });
  const app = patchedApp(name);
  ctx.loadApp = () => vm.runInContext(app, ctx, { filename: 'MiniCCTV.js' });
  try {
    vm.runInContext(fakecamSrc, ctx, { filename: 'fakecam.js' });
    vm.runInContext(goldenSrc, ctx, { filename: 'golden.js' });
    vm.runInContext(suiteSrc, ctx, { filename: 'suite.js' });
  } catch (e) {
    lines.push('FAIL scenario crashed: ' + e.message);
  }
  return lines;
}

function runMq(name) {
  const appFile = path.join(tmp, `app_${name}.js`);
  fs.writeFileSync(appFile, patchedApp(name));
  const files = {
    fakecam: path.join(tmp, 'fakecam.js'), golden: path.join(tmp, 'golden.js'), platform: path.join(tmp, `platform_${name}.js`),
    suite: path.join(tmp, 'suite.js'),
  };
  fs.writeFileSync(files.fakecam, fakecamSrc);
  // the big golden arrays only matter to one scenario; keeping them out of the others makes the memory limit meaningful
  fs.writeFileSync(files.golden, name === 'real_firmware_bytes' ? goldenSrc : smallGoldenSrc);
  fs.writeFileSync(files.platform, `var SCENARIO = ${JSON.stringify(name)};\nvar APP_PATH = ${JSON.stringify(appFile)};\nfunction loadApp() { load(APP_PATH); }\n`);
  fs.writeFileSync(files.suite, suiteSrc);
  const memory = MQ_MEMORY;
  const r = spawnSync(mqjs, ['--memory-limit', String(memory), '-I', files.fakecam, '-I', files.golden, '-I', files.platform, files.suite], { encoding: 'utf8', timeout: 180000, maxBuffer: 1 << 26 });
  const lines = (r.stdout || '').split('\n').filter(Boolean);
  if (r.status !== 0) lines.push(`FAIL the engine exited with status ${r.status}: ${((r.stderr || '') + (r.error ? r.error.message : '')).trim().split('\n').slice(0, 4).join(' | ')}`);
  return lines;
}

let failures = 0, checks = 0;
function report(engine, name, lines) {
  const fails = lines.filter((l) => l.startsWith('FAIL'));
  const passes = lines.filter((l) => l.startsWith('PASS')).length;
  const summary = lines.find((l) => l.startsWith('SUMMARY'));
  checks += passes;
  failures += fails.length;
  if (!summary && !fails.length) { failures++; fails.push('FAIL no summary: the scenario did not finish'); }
  console.log(`${fails.length ? 'FAIL' : 'ok  '} [${engine}] ${name}: ${passes} checks${fails.length ? '' : ''}`);
  for (const f of fails) console.log('       ' + f);
  if (process.env.VERBOSE) for (const l of lines) console.log('       ' + l);
}

for (const name of scenarios) {
  report('node', name, runNode(name));
  if (mqjs) report('mquickjs', name, runMq(name));
}
console.log(`\n${scenarios.length} scenarios x ${mqjs ? 2 : 1} engine(s): ${checks} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
