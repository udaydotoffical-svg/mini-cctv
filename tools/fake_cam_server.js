// Serves the fake camera (tools/mq/fakecam.js) over HTTP, so a real Stick running bruce/MiniCCTV.js can be
// tried against your laptop, no camera needed. Put the Stick and the laptop on the same WiFi, set CAM_HOST in
// MiniCCTV.js to http://<laptop ip>:8080 and JOIN_CAM_WIFI = false.
//   node tools/fake_cam_server.js [port]
// Every /d request makes a few bands "move", and the Stick-facing controls (/ctl, /m, /files, /status) behave
// like the camera's. The pictures are test patterns, not video.
const http = require('http');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, 'mq', 'fakecam.js'), 'utf8'), ctx);
vm.runInContext('FC.reset({ autoMotion: true });', ctx);
const port = Number(process.argv[2] || 8080);
http.createServer((req, res) => {
  ctx.u = 'http://x' + req.url;
  ctx.json = req.url.startsWith('/ctl') || req.url.startsWith('/m') || req.url.startsWith('/status') || req.url.startsWith('/files');
  let r;
  try { r = vm.runInContext('FC.handle(u, { responseType: json ? "json" : "binary" })', ctx); } catch (e) { res.writeHead(503); return res.end(String(e)); }
  const body = r.body instanceof Uint8Array || ArrayBuffer.isView(r.body) ? Buffer.from(r.body) : Buffer.from(JSON.stringify(r.body));
  res.writeHead(r.status, { 'Content-Type': ArrayBuffer.isView(r.body) ? 'application/octet-stream' : 'application/json', 'Content-Length': body.length, Connection: 'close' });
  res.end(body);
}).listen(port, '0.0.0.0', () => console.log(`fake camera on http://0.0.0.0:${port}`));
