// A fake camera node for testing bruce/MiniCCTV.js without hardware. It mirrors the firmware's
// protocol (delta.h) and its /ctl, /m, /status and /files behaviour, and is written in strict ES5 so
// it runs on Node AND on the real mquickjs engine Bruce uses (see tools/mq/harness.js).
//
// It is a model, not a copy: the byte format is checked against the real C++ encoder by the golden
// files (tools/test_delta.cpp), and the behaviour is kept in step with mini_cctv.ino by hand.
var FC = (function () {
  var NB = 9;
  var W = 240;
  var H = 135;
  var BH = 16;
  // modes.h: motion, history, autoRec, continuous, timelapse, eventPhoto, alerts, needsSd
  var HISTORY = [false, true, true, true, false];
  var NEEDS_SD = [false, false, true, true, true];

  var st = {};
  var ver = [];
  var bandSeq = [];

  function reset(opts) {
    st = {
      seq: 1, reqs: 0, mseq: 0, lv: 0, big: 0, motion: 0,
      mode: 2, sd: 1, rec: 0, box: 1, sharp: 1, z: 10, px: 50, py: 50, f: 0, n: 0, fl: 1, mi: 0, br: 1, auto: 1,
      free: 12000, hist: 90, tl: 60, ov: 0, ago: 0, play: 0, cpos: 0, clen: 0, name: '', photoNo: 42,
      autoMotion: false, down: false, hook: null,
      photos: [['IMG_0041.jpg', 61440], ['IMG_0040.jpg', 59392]],
      clips: [['VID_0003.avi', 4194304], ['VID_0002.avi', 2097152]],
      log: []
    };
    if (opts) {
      for (var k in opts) {
        if (opts.hasOwnProperty(k)) {
          st[k] = opts[k];
        }
      }
    }
    ver = [];
    bandSeq = [];
    for (var i = 0; i < NB; i++) {
      ver.push(1);
      bandSeq.push(1);
    }
  }

  function rows(i) {
    return i === NB - 1 ? H - (NB - 1) * BH : BH;
  }

  // what band i looks like at its current version (and under the current override)
  function bandVer(i) {
    return ver[i] + 1000 * st.ov;
  }

  function bandRaw(i) {
    var n = rows(i) * W;
    var a = new Uint8Array(n);
    var v = bandVer(i);
    for (var k = 0; k < n; k++) {
      a[k] = (i * 37 + v * 11 + (k & 255)) & 255;
    }
    return a;
  }

  function bandJpg(i) {
    var v = bandVer(i);
    var n = 200 + ((i * 13 + v * 5) % 150);
    var a = new Uint8Array(n);
    a[0] = 0xff;
    a[1] = 0xd8;
    for (var k = 2; k < n - 2; k++) {
      a[k] = (i * 5 + v + k) & 0x7f;
    }
    a[n - 2] = 0xff;
    a[n - 1] = 0xd9;
    return a;
  }

  function bump(list) {
    st.seq++;
    for (var j = 0; j < list.length; j++) {
      ver[list[j]]++;
      bandSeq[list[j]] = st.seq;
    }
  }

  function bumpAll() {
    var all = [];
    for (var i = 0; i < NB; i++) {
      all.push(i);
    }
    bump(all);
  }

  function parseQuery(q) {
    var o = {};
    if (!q) {
      return o;
    }
    var parts = q.split('&');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].split('=');
      o[p[0]] = p.length > 1 ? p[1] : '';
    }
    return o;
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function flags() {
    var f = 0;
    if (st.rec) { f |= 1; }
    if (st.sd) { f |= 2; }
    if (st.big) { f |= 4; }
    if (st.motion) { f |= 8; }
    if (st.ov) { f |= 16; }
    return f;
  }

  function delta(since, jpg) {
    st.reqs++;
    if (st.autoMotion) {
      bump([2, 3, 4]);
    }
    var mask = 0;
    var seq = st.seq;
    if (since <= st.seq) {
      for (var i = 0; i < NB; i++) {
        if (bandSeq[i] > since) {
          mask |= 1 << i;
        }
      }
    }
    var parts = [];
    var total = 8;
    for (var b = 0; b < NB; b++) {
      if (mask & (1 << b)) {
        var data = jpg ? bandJpg(b) : bandRaw(b);
        parts.push(data);
        total += 2 + data.length;
      }
    }
    var out = new Uint8Array(total);
    out[0] = mask & 255;
    out[1] = (mask >> 8) & 255;
    out[2] = seq & 255;
    out[3] = (seq >> 8) & 255;
    out[4] = (seq >> 16) & 255;
    out[5] = (seq >> 24) & 255;
    out[6] = st.lv;
    out[7] = flags();
    var off = 8;
    for (var p = 0; p < parts.length; p++) {
      out[off] = parts[p].length & 255;
      out[off + 1] = (parts[p].length >> 8) & 255;
      out.set(parts[p], off + 2);
      off += 2 + parts[p].length;
    }
    return { status: 200, body: out, length: total };
  }

  function stateJson(msg, name) {
    return {
      z: st.z, px: st.px, py: st.py, f: st.f, n: st.n, fl: st.fl, mi: st.mi, br: st.br, rec: st.rec, auto: st.auto, box: st.box, sharp: st.sharp,
      sd: st.sd, free: st.free, ov: st.ov, ago: st.ago, hist: st.hist, play: st.play, mode: st.mode, tl: st.tl,
      cpos: st.cpos, clen: st.clen, name: name || st.name, msg: msg
    };
  }

  function ctl(q) {
    var msg = 'ok';
    var name = '';
    if (q.hasOwnProperty('z')) { st.z = clamp(parseInt(q.z, 10), 10, 40); bumpAll(); }
    if (q.hasOwnProperty('px')) { st.px = clamp(parseInt(q.px, 10), 0, 100); bumpAll(); }
    if (q.hasOwnProperty('py')) { st.py = clamp(parseInt(q.py, 10), 0, 100); bumpAll(); }
    if (q.hasOwnProperty('f')) { st.f = clamp(parseInt(q.f, 10), 0, 4); bumpAll(); }
    if (q.hasOwnProperty('n')) { st.n = parseInt(q.n, 10) ? 1 : 0; }
    if (q.hasOwnProperty('fl')) { st.fl = parseInt(q.fl, 10) ? 1 : 0; }
    if (q.hasOwnProperty('mi')) { st.mi = parseInt(q.mi, 10) ? 1 : 0; }
    if (q.hasOwnProperty('br')) { st.br = clamp(parseInt(q.br, 10), -2, 2); }
    if (q.hasOwnProperty('auto')) { st.auto = parseInt(q.auto, 10) ? 1 : 0; }
    if (q.hasOwnProperty('sh')) { st.sharp = parseInt(q.sh, 10) ? 1 : 0; bumpAll(); }
    if (q.hasOwnProperty('box')) { st.box = parseInt(q.box, 10) ? 1 : 0; bumpAll(); }
    if (q.hasOwnProperty('mode')) {
      var m = parseInt(q.mode, 10);
      if (m >= 0 && m < 5 && m !== st.mode) {
        st.mode = m;
        if (NEEDS_SD[m] && !st.sd) {
          msg = 'mode set, but no SD card';
        }
      }
    }
    if (q.hasOwnProperty('tl')) { st.tl = clamp(parseInt(q.tl, 10), 5, 3600); }
    if (q.hasOwnProperty('rec')) {
      if (!st.sd) {
        msg = 'no SD card';
      } else if (q.rec === 't') {
        st.rec = st.rec ? 0 : 1;
      } else {
        st.rec = parseInt(q.rec, 10) ? 1 : 0;
      }
    }
    if (q.hasOwnProperty('snap')) {
      if (!st.sd) {
        msg = 'no SD card';
      } else {
        st.photoNo++;
        var no = '' + st.photoNo;
        while (no.length < 4) { no = '0' + no; }
        name = 'IMG_' + no + '.jpg';
        st.photos.unshift([name, 65000]);
        msg = 'saved';
      }
    }
    if (q.hasOwnProperty('live')) { st.ov = 0; st.play = 0; bumpAll(); }
    if (q.hasOwnProperty('rw')) {
      if (!HISTORY[st.mode]) {
        msg = 'rewind needs Guard or Security';
      } else if (st.hist === 0) {
        msg = 'no history yet';
      } else {
        var secs = clamp(parseInt(q.rw, 10), 0, 3600);
        if (st.ov !== 1) { st.play = 0; }
        if (secs === 0) {
          st.ov = 0;
          st.ago = 0;
        } else {
          st.ov = 1;
          st.ago = Math.min(secs, st.hist);
        }
        bumpAll();
      }
    }
    if (q.hasOwnProperty('rwp')) { st.play = parseInt(q.rwp, 10) ? 1 : 0; }
    if (q.hasOwnProperty('photo') || q.hasOwnProperty('clip')) {
      var isClip = q.hasOwnProperty('clip');
      var nm = isClip ? q.clip : q.photo;
      if (!st.sd) {
        msg = 'no SD card';
      } else if (!/^[A-Za-z0-9_.]+$/.test(nm) || nm.indexOf('..') >= 0) {
        msg = 'bad name';
      } else {
        st.name = nm;
        name = nm;
        st.ov = isClip ? 3 : 2;
        st.cpos = 0;
        st.clen = isClip ? 48 : 0;
        st.play = isClip ? 1 : 0;
        bumpAll();
      }
    }
    if (q.hasOwnProperty('pp')) { st.play = parseInt(q.pp, 10) ? 1 : 0; }
    if (q.hasOwnProperty('sk')) { st.cpos = clamp(st.cpos + parseInt(q.sk, 10), 0, st.clen); }
    return stateJson(msg, name);
  }

  // Same shape as Bruce's wifi.httpFetch: {status, body, length}. Throws like it does when the
  // camera is unreachable.
  function handle(url, o) {
    if (st.down) {
      throw new Error('connect failed');
    }
    if (st.hook) {
      var h = st.hook(url, st);
      if (h === 'throw') {
        throw new Error('connect failed');
      }
      if (h) {
        return h;
      }
    }
    st.log.push(url);
    var qi = url.indexOf('?');
    var path = url.substring(url.indexOf('/', 8), qi < 0 ? url.length : qi);
    var q = parseQuery(qi < 0 ? '' : url.substring(qi + 1));
    var j = o && o.responseType === 'json';
    if (path === '/d') {
      return delta(q.hasOwnProperty('s') ? parseInt(q.s, 10) : 0, q.f === 'j');
    }
    var body;
    if (path === '/status') {
      body = { w: W, h: H, bands: NB, band_h: BH, mseq: st.mseq, mode: st.mode, sd: st.sd, rec: st.rec, free_mb: st.free, motion: st.lv };
    } else if (path === '/ctl') {
      body = ctl(q);
    } else if (path === '/m') {
      body = { ms: st.mseq, lv: st.lv, big: st.big, act: st.motion, rec: st.rec, mode: st.mode, sd: st.sd };
    } else if (path === '/files') {
      body = { d: q.d, sd: st.sd, free: st.free, f: st.sd ? (q.d === 'clips' ? st.clips : st.photos) : [] };
    } else {
      return { status: 404, body: j ? null : new Uint8Array(0), length: 0 };
    }
    return { status: 200, body: body, length: 0 };
  }

  // the picture a viewer should be showing right now, as raw RGB332 (for tests)
  function expectedFrame() {
    var out = new Uint8Array(W * H);
    for (var i = 0; i < NB; i++) {
      out.set(bandRaw(i), i * BH * W);
    }
    return out;
  }

  reset();
  return {
    reset: reset, handle: handle, bump: bump, bumpAll: bumpAll, expectedFrame: expectedFrame,
    state: function () { return st; }, NB: NB, W: W, H: H, BH: BH
  };
})();
