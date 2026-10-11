// Shared by tools/release.sh and tools/check_release.js: what a release is made of.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const BASE = 'https://raw.githubusercontent.com/udaydotoffical-svg/mini-cctv/main/';
const files = {
  app: path.join(root, 'bruce', 'MiniCCTV.js'),
  config: path.join(root, 'firmware', 'mini_cctv', 'config.h'),
  sketchDir: path.join(root, 'firmware', 'mini_cctv'),
  bin: path.join(root, 'dist', 'firmware-oceanlabz.bin'),
  manifest: path.join(root, 'dist', 'version.json'),
};

const appVersion = () => /var APP_VERSION = '([0-9]+\.[0-9]+\.[0-9]+)';/.exec(fs.readFileSync(files.app, 'utf8'))?.[1];
const fwVersion = () => /#define FW_VERSION\s+"([0-9]+\.[0-9]+\.[0-9]+)"/.exec(fs.readFileSync(files.config, 'utf8'))?.[1];
const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex');

// A fingerprint of everything that goes into the camera firmware, so a stale image is noticed.
function sketchHash() {
  const h = crypto.createHash('sha256');
  for (const f of fs.readdirSync(files.sketchDir).sort()) {
    const p = path.join(files.sketchDir, f);
    if (fs.statSync(p).isFile()) { h.update(f + '\0'); h.update(fs.readFileSync(p)); h.update('\0'); }
  }
  return h.digest('hex').slice(0, 16);
}

module.exports = { root, BASE, files, appVersion, fwVersion, md5, sketchHash };
