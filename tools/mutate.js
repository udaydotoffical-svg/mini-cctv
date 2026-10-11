// Mutation check for the app tests: breaks bruce/MiniCCTV.js on purpose, one change at a time, and
// makes sure the scenario suite notices (a mutant that still passes means a test that proves nothing).
//
//   node tools/mutate.js <golden_dir>        (the golden dir is the one tools/run_tests.sh builds)
//
// Runs on Node only, for speed. Exit status 1 if any mutant survives.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const golden = process.argv[2];
if (!golden) { console.error('usage: node tools/mutate.js <golden_dir>'); process.exit(2); }
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'bruce', 'MiniCCTV.js'), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mutants-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

// [what is broken, text to find, text to put instead]
const MUTANTS = [
  // --- settings ---
  ['settings are appended instead of replaced', "}), 'write');", "}), 'append');"],
  ['saved alert level is loaded but not applied', '  alertLevel = cfg.alerts;\n  hud = cfg.hud;\n  if (autoUpdate()', '  hud = cfg.hud;\n  if (autoUpdate()'],
  ['saved Info line default is loaded but not applied', '  hud = cfg.hud;\n  if (autoUpdate()', '  if (autoUpdate()'],
  ['out-of-range alert level is trusted', 'if (o.alerts === 0 || o.alerts === 1 || o.alerts === 2) {', 'if (o.alerts !== undefined) {'],
  ['a damaged settings file crashes the app', 'try {\n    o = JSON.parse(raw);\n  } catch (e2) {\n    return; // damaged file: ignore it\n  }', 'o = JSON.parse(raw);'],
  ['a failing write crashes the app', "  } catch (e) {\n    lastErr = 'save ' + e;", '  } catch (e) {\n    throw e;'],
  ['changing Info line is not saved', '    cfg.hud = !cfg.hud;\n    hud = cfg.hud;\n    saveCfg();', '    cfg.hud = !cfg.hud;\n    hud = cfg.hud;'],
  ['the alert level cycle has two states', 'cfg.alerts = (cfg.alerts + 1) % 3;', 'cfg.alerts = (cfg.alerts + 1) % 2;'],
  ['auto-record always sends "on"', "r = ctl('auto=' + (cam.auto ? 0 : 1));", "r = ctl('auto=1');"],
  ['Person box always sends "on"', "r = ctl('box=' + (cam.box ? 0 : 1));", "r = ctl('box=1');"],
  ['Sharpen always sends "on"', "r = ctl('sh=' + (cam.sharp ? 0 : 1));", "r = ctl('sh=1');"],
  ['camera rows do not wait for a connection', "  if (camSeen) {\n    return 'ok';\n  }\n  return ensureConnected();", "  return 'ok';"],
  // --- no flashing, no JPEG ---
  ['the shutter flashes the screen white', '  if (takePhoto()) {\n    st.shots++;', '  display.fill(C.text);\n  if (takePhoto()) {\n    st.shots++;'],
  ['a burst flashes the screen white', '      r = snapOnce();\n      if (!r', '      display.fill(C.text);\n      r = snapOnce();\n      if (!r'],
  ['a motion event fills the screen red', '      gd.events++;\n      display.restoreBrightness();', '      gd.events++;\n      display.fill(C.bad);\n      display.restoreBrightness();'],
  ['the live picture asks for JPEG strips', "'/d?f=8&s=' + since", "'/d?f=j&s=' + since"],
  // --- camera screen ---
  ['UP+DOWN on the camera screen quits the whole app', "return kind === 'shoot' ? 'menu' : 'quit';", "return 'quit';"],
  ['a burst takes five pictures', 'var BURST_N = 6;', 'var BURST_N = 5;'],
  ['the timer does not count down', 'var TIMER_S = 3;', 'var TIMER_S = 0;'],
  ['the shutter ignores a missing SD card', "  if (!(hdrFlags & DF_SD)) {\n    toast('No SD card: cannot save', 'err');\n    return;\n  }", ''],
  // --- updates ---
  ['the app installs a download whose size does not match', `if (body.length !== m.app_size || r.length !== m.app_size) {`, `if (false) {`],
  ['the app installs a file that is not the announced version', `body.indexOf("var APP_VERSION = '" + m.app + "';") < 0 || `, ``],
  ['the app installs a file that was cut off', ` || body.lastIndexOf('main();') < body.length - 12`, ``],
  ['a download from outside the repository is accepted', `m.app_url.indexOf(UPDATE_BASE) !== 0`, `false`],
  ['a failed swap does not put the old app back', `      storage.rename(bak, __filepath); // put the old one back`, `      // (nothing)`],
  ['a half-written file is left behind', `    removeQuiet(tmp);\n    return 'could not save it';`, `    return 'could not save it';`],
  ['the old app is not moved aside before the swap', `moved = storage.rename(here, __filepath + '.bak') === true;`, `moved = true;`],
  ["the update starts at launch on the camera's own WiFi", `|| !wifi.connected() || onCamNetwork()) {\n    return '';`, `|| !wifi.connected()) {\n    return '';`],
  ['the update checks even with no WiFi', `|| !wifi.connected() || onCamNetwork()) {\n    return '';`, `|| onCamNetwork()) {\n    return '';`],
  ['the camera is visited even when it is known to be current', `if (m.fw !== '' && (cfg.camFw === '' || newer(m.fw, cfg.camFw))) {`, `if (m.fw !== '') {`],
  ['a current camera is offered an update anyway', `if (!newer(m.fw, cam.fw)) {`, `if (false) {`],
  ['the password is shown on the screen', `msgScreen('Camera', ['Sending the WiFi details...'], null, '');`, `msgScreen('Camera', ['Sending ' + pass], null, '');`],
  ['the password is sent without encoding', `'&pass=' + urlEncode(pass)`, `'&pass=' + pass`],
  ['the WiFi name is sent without encoding', `'ssid=' + urlEncode(ssid)`, `'ssid=' + ssid`],
  ["the camera's result note is never cleared", `  getJson('/ctl?otaclr=1');\n`, ``],
  ['waiting for the camera never gives up', `while (now() - t0 < CAM_UPDATE_WAIT_MS) {`, `while (true) {`],
  ['an empty password is accepted without asking', `  if (pass === '') {\n    msgScreen('No password?'`, `  if (false) {\n    msgScreen('No password?'`],
  // --- the rest of the app ---
  ['the beep patterns are swapped', 'audio.tone(big ? 2800 : 1900, 70);', 'audio.tone(big ? 1900 : 2800, 70);'],
  ['the live viewer alerts even in Live mode', " && MODE_ALERTS[cam.mode]) {\n          alertMotion", ') {\n          alertMotion'],
  ['a rebooted camera is not noticed', 'since = seq < since ? 0 : seq;', 'since = seq;'],
  ['a short reply is drawn anyway', "b.length !== res.length) {", 'false) {'],
  ['bands of the wrong size are drawn', '|| len !== FRAME_W * rows', ''],
  ['a photo is requested without checking for a card', "  if (!(hdrFlags & DF_SD)) {\n    toast('No SD card: cannot save', 'err');\n    return false;\n  }", ''],
  ['the missing-SD notice is skipped', '      if (cam.sd === 0) {', '      if (false) {'],
  ['guard leaves the screen dim', '  var r = guardLoop(st ? st.mseq : 0);\n  display.restoreBrightness();', '  var r = guardLoop(st ? st.mseq : 0);'],
  ['a restarted camera is not noticed by guard', '    if (m.ms < ms) {', '    if (false) {'],
  ['the main menu alerts in Live mode', 'st.mseq > menuMseq && MODE_ALERTS[st.mode];', 'st.mseq > menuMseq;'],
  ['leaving a photo does not put the camera back live', "      var v = viewer('play');\n      ctl('live=1');", "      var v = viewer('play');"],
  ['the timelapse interval never changes', "ctl('tl=' + TL_STEPS[(idx + 1) % TL_STEPS.length]);", "ctl('tl=' + TL_STEPS[idx]);"],
  ['recovery from an outage never reconnects', '      joinCam();\n      fails = 0;\n      since = 0;', '      fails = 0;\n      since = 0;'],
  ['Guard on a Live camera does not offer to switch', "    ctl('mode=2');\n  }\n  var st = getJson('/status');", "  }\n  var st = getJson('/status');"],
  ['the REC chip never shows', "  if (rec) {\n    box(W - 90", '  if (false) {\n    box(W - 90'],
  ['the gallery opens the first file whatever you pick', "var res = ctl((dir === 'clips' ? 'clip=' : 'photo=') + files[i][0]);", "var res = ctl((dir === 'clips' ? 'clip=' : 'photo=') + files[0][0]);"],
  ['icons are drawn with the wrong size', 'display.drawXBitmap(x, y, d, 12, 12, color);', 'display.drawXBitmap(x, y, d, 12, 11, color);'],
];

let survived = 0;
for (let i = 0; i < MUTANTS.length; i++) {
  const [what, find, repl] = MUTANTS[i];
  if (!app.includes(find)) { console.log(`?? [${i}] ${what}: the text to change is not in the app any more`); survived++; continue; }
  const file = path.join(tmp, `m${i}.js`);
  fs.writeFileSync(file, app.replace(find, repl));
  const r = spawnSync('node', [path.join(__dirname, 'test_app.js'), golden], { env: { ...process.env, APP: file }, encoding: 'utf8', timeout: 300000, maxBuffer: 1 << 26 });
  const caught = r.status !== 0;
  if (!caught) survived++;
  console.log(`${caught ? 'caught  ' : 'SURVIVED'} [${i}] ${what}`);
}
console.log(`\n${MUTANTS.length - survived} of ${MUTANTS.length} mutants caught${survived ? `, ${survived} SURVIVED` : ''}`);
process.exit(survived ? 1 : 0);
