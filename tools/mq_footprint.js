// How much of the Stick's JS heap does MiniCCTV.js need? Uses the real mquickjs engine Bruce runs.
//   node tools/mq_footprint.js <mqjs_binary>
//
// 1. Static: load the app, collect garbage, read the live heap, and subtract the same with an empty
//    app (the test rig alone). That is the cost of the app's code, strings and reusable buffers.
// 2. Peak: run 300 Fast and 300 Photo picture updates on a deliberately light rig while shrinking the
//    engine's heap until it runs out; the smallest heap that still works, minus the empty-app
//    baseline, is the app's working peak (it includes the rig's own transient copy of each reply).
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const mqjs = process.argv[2];
const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mqfp-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const w = (n, s) => { const p = path.join(tmp, n); fs.writeFileSync(p, s); return p; };
const suite = w('suite.js', fs.readFileSync(path.join(__dirname, 'mq', 'suite.js'), 'utf8'));
const fake = w('fake.js', fs.readFileSync(path.join(__dirname, 'mq', 'fakecam.js'), 'utf8'));
const gold = w('gold.js', 'var GOLDEN = {d8: [], d8fb: [], dj: [], djside: []};\n');
const appReal = path.join(root, 'bruce', 'MiniCCTV.js');
const appEmpty = w('empty.js', 'var unused = 1;\n');
const wrap = w('wrap.js', `load(${JSON.stringify(suite)}); gc(); gc();\n`);

function run(app, scenario, limit, extra) {
  const plat = w('plat.js', `var SCENARIO = ${JSON.stringify(scenario)};\nvar APP_PATH = ${JSON.stringify(app)};\nfunction loadApp() { load(APP_PATH); }\n`);
  return spawnSync(mqjs, [...extra, '--memory-limit', String(limit), '-I', fake, '-I', gold, '-I', plat, wrap], { encoding: 'utf8', timeout: 300000 });
}
function liveHeap(app) {
  const r = run(app, 'menu_and_exit', 16 * 1024 * 1024, ['-d']);
  const m = /heap size=(\d+)\//.exec(r.stdout + r.stderr);
  return m ? Number(m[1]) : NaN;
}
function worksAt(app, limit) {
  const r = run(app, 'footprint', limit, []);
  const text = r.stdout + r.stderr;
  return !/out of memory/i.test(text) && /SUMMARY passed=1 failed=0/.test(text);
}
function minimum(app) {
  let lo = 32 * 1024, hi = 4 * 1024 * 1024;
  if (!worksAt(app, hi)) return NaN;
  while (hi - lo > 2048) {
    const mid = (lo + hi) >> 1;
    if (worksAt(app, mid)) hi = mid; else lo = mid;
  }
  return hi;
}
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
const baseLive = liveHeap(appEmpty), appLive = liveHeap(appReal);
const peak = minimum(appReal);
console.log(`source file                : ${kb(fs.statSync(appReal).size)}`);
console.log(`static cost (code, strings, buffers): ~${kb(appLive - baseLive)}`);
if (Number.isNaN(peak)) {
  console.log('peak: the footprint scenario failed even with a 4 MB heap');
  process.exit(1);
}
console.log(`working peak while streaming: ~${kb(peak - baseLive)}  (includes the test rig's own copy of each reply)`);
console.log(`Bruce gives the interpreter about 250 KB with PSRAM (every Stick Plus2), only ~64 KB without.`);
