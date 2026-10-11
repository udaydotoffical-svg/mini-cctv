// Checks that what is published for over-the-air updates (dist/) matches the source. A release that
// does not match is worse than none: the Stick refuses a file of the wrong size, and the camera
// refuses a wrong MD5, so updates would just fail. Run by tools/run_tests.sh.
//
//   node tools/check_release.js
'use strict';
const fs = require('fs');
const L = require('./release_lib');

const problems = [];
const bad = (m) => problems.push(m);
if (!fs.existsSync(L.files.manifest)) { console.log('FAIL dist/version.json is missing: run tools/release.sh <version>'); process.exit(1); }
const m = JSON.parse(fs.readFileSync(L.files.manifest, 'utf8'));
const app = fs.readFileSync(L.files.app);
const av = L.appVersion(), fv = L.fwVersion();

if (m.app !== av) bad(`manifest app ${m.app} but MiniCCTV.js says ${av}`);
if (m.fw !== fv) bad(`manifest fw ${m.fw} but config.h says ${fv}`);
if (m.app_url !== L.BASE + 'bruce/MiniCCTV.js') bad('app_url is not this repository\'s bruce/MiniCCTV.js');
if (m.app_size !== app.length) bad(`app_size ${m.app_size} but MiniCCTV.js is ${app.length} bytes (changed since the release? run tools/release.sh)`);
if (app.some((b) => b > 127)) bad('MiniCCTV.js has non-ASCII characters (the Stick checks the size in characters)');
if (!app.toString('latin1').endsWith('main();\n')) bad('MiniCCTV.js must end with "main();" and a newline (the Stick checks that it was not cut off)');
if (!app.toString('latin1').includes(`var APP_VERSION = '${m.app}';`)) bad('MiniCCTV.js lacks its version line');
if (m.fw_url !== L.BASE + 'dist/firmware-oceanlabz.bin') bad('fw_url is not dist/firmware-oceanlabz.bin of this repository');
if (!fs.existsSync(L.files.bin)) bad('dist/firmware-oceanlabz.bin is missing');
else {
  const bin = fs.readFileSync(L.files.bin);
  if (bin[0] !== 0xe9) bad('the firmware image does not start with the ESP image marker 0xE9');
  if (m.fw_size !== bin.length) bad(`fw_size ${m.fw_size} but the image is ${bin.length} bytes`);
  if (m.fw_md5 !== L.md5(bin)) bad('fw_md5 does not match the image');
  if (!bin.includes(Buffer.from(`mini-cctv camera node v${m.fw}`))) bad(`the image does not contain "mini-cctv camera node v${m.fw}": it was built from a different version`);
  if (bin.length > 3000000) bad('the image is bigger than the 3 MB app partition');
}
// the rules the Stick app applies before it believes a list (fetchLatest in MiniCCTV.js)
if (!m.app_url.startsWith(L.BASE)) bad('the Stick would refuse app_url: it is outside the repository');
if (!(m.app_size >= 1000 && m.app_size <= 400000)) bad('the Stick would refuse app_size: outside 1000..400000');
if (!/^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(m.app) || !/^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(m.fw)) bad('a version is not major.minor.patch');
if (m.fw_src !== L.sketchHash()) bad('the camera source changed since the image was built (fw_src differs): run tools/release.sh');

if (problems.length) {
  console.log('FAIL the published release does not match the source:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
console.log(`PASS release ${m.app} (app) / ${m.fw} (camera) is consistent: ${m.app_size} B app, ${m.fw_size} B image, md5 ${m.fw_md5}`);
