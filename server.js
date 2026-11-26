'use strict';
// 단동샘 편집기 — 로컬 서버 (ffmpeg로 분석/내보내기/캡처 처리)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn, execFile, exec } = require('child_process');
const { pipeline } = require('stream/promises');

const PORT = +process.env.PORT || 5178;

// ---- ffmpeg / ffprobe 경로 (npm 번들 → 없으면 시스템 설치본) ----
let FFMPEG = 'ffmpeg', FFPROBE = 'ffprobe';
try { const p = require('ffmpeg-static'); if (p && fs.existsSync(p)) FFMPEG = p; } catch (e) {}
try { const p = require('ffprobe-static').path; if (p && fs.existsSync(p)) FFPROBE = p; } catch (e) {}

// ---- 폴더 ----
const ROOT = __dirname;
// 내 작업 데이터(프로젝트·가져온 파일·모델)는 프로그램 폴더 밖에 둬요 → 새 버전으로 바꿔도 그대로 남아요
const LEGACY_WS = path.join(ROOT, 'workspace');
const DATA_ROOT = process.env.DSP_DATA || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir(), '단동샘편집기') : path.join(os.homedir(), '.dandongsam-editor'));
const WS = path.join(DATA_ROOT, 'workspace');
try {
  if (!fs.existsSync(WS) && fs.existsSync(LEGACY_WS)) { fs.mkdirSync(DATA_ROOT, { recursive: true }); fs.cpSync(LEGACY_WS, WS, { recursive: true }); }
} catch (e) { console.log('이전 작업 옮기기 실패:', e.message); }
const DIRS = {
  media: path.join(WS, 'media'),
  cache: path.join(WS, 'cache'),
  out: path.join(ROOT, '내보내기'),
  cap: path.join(ROOT, '캡처'),
  fonts: path.join(WS, 'fonts'),
};
Object.values(DIRS).forEach((d) => fs.mkdirSync(d, { recursive: true }));

// ---- 미디어 목록 (재시작해도 유지) ----
const DB = path.join(WS, 'media.json');
let media = {};
try { media = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch (e) {}
for (const id of Object.keys(media)) {
  const m = media[id];
  for (const k of Object.keys(m)) { if (typeof m[k] === 'string' && /[\\/]workspace[\\/]/.test(m[k])) { const rest = m[k].split(/[\\/]workspace[\\/]/).pop(); m[k] = path.join(WS, rest); } }
  if (!fs.existsSync(m.file)) delete media[id];
}
const saveDB = () => fs.writeFileSync(DB, JSON.stringify(media));

// ---- 유틸 ----
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.jpeg': 'image/jpeg', '.ttf': 'font/ttf', '.otf': 'font/otf', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
};
const n = (x) => String(Math.round(x * 1000) / 1000);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const stamp = () => {
  const d = new Date(), p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const run = (cmd, args) => new Promise((res, rej) => {
  execFile(cmd, args, { maxBuffer: 1 << 27 }, (e, so, se) => e ? rej(new Error(String(se || e.message).slice(-800))) : res(so));
});
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((res, rej) => {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 5e7) req.destroy(); });
  req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } });
  req.on('error', rej);
});

// ---- 분석 ----
async function probe(file) {
  const o = await run(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  const j = JSON.parse(o);
  const v = j.streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = j.streams.find((s) => s.codec_type === 'audio');
  let w = v ? +v.width : 0, h = v ? +v.height : 0, sar = 1;
  if (v) {
    let rot = 0;
    const sd = (v.side_data_list || []).find((x) => x.rotation !== undefined);
    if (sd) rot = +sd.rotation; else if (v.tags && v.tags.rotate) rot = +v.tags.rotate;
    const sm = String(v.sample_aspect_ratio || '').match(/^(\d+):(\d+)$/); if (sm && +sm[1] > 0 && +sm[2] > 0) { const q = +sm[1] / +sm[2]; if (Math.abs(q - 1) > 0.01) { sar = q; w = Math.max(2, Math.round(w * q / 2) * 2); } }
    if (Math.abs(rot) % 180 === 90) [w, h] = [h, w];
  }
  let fps = 0;
  if (v && v.r_frame_rate) { const [a1, b1] = v.r_frame_rate.split('/').map(Number); fps = b1 ? a1 / b1 : a1; }
  const duration = +(j.format.duration || (v && v.duration) || (a && a.duration) || 0);
  return { duration, width: w, height: h, sar, fps, hasVideo: !!v, hasAudio: !!a, vcodec: v && v.codec_name, acodec: a && a.codec_name, pix: v && v.pix_fmt };
}

function needsProxy(info, ext) {
  if (info.hasVideo) {
    if (!['.mp4', '.m4v', '.mov', '.webm'].includes(ext)) return true;
    if (!['h264', 'vp8', 'vp9', 'av1'].includes(info.vcodec)) return true;
    if (info.pix && !['yuv420p', 'yuvj420p'].includes(info.pix)) return true;
    if (info.acodec && !['aac', 'mp3', 'opus', 'vorbis', 'flac'].includes(info.acodec)) return true;
    return false;
  }
  return !['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'].includes(ext);
}

// 소리 파형(0.1초 단위 최대 진폭)
function peaks(file) {
  return new Promise((res) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '4000', '-f', 's16le', '-']);
    const out = []; let left = null, mx = 0, c = 0;
    p.stdout.on('data', (b) => {
      if (left) { b = Buffer.concat([left, b]); left = null; }
      const len = b.length & ~1;
      for (let i = 0; i < len; i += 2) {
        const v = Math.abs(b.readInt16LE(i)); if (v > mx) mx = v;
        if (++c === 400) { out.push(Math.min(255, Math.round(mx / 32768 * 255))); mx = 0; c = 0; }
      }
      if (len < b.length) left = b.subarray(len);
    });
    p.on('close', () => { if (c) out.push(Math.min(255, Math.round(mx / 32768 * 255))); res(out); });
    p.on('error', () => res([]));
  });
}

// ---- 업로드 / 분석 ----
const IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
const alphaPathOf = (id) => path.join(DIRS.media, id + '.alpha.webm');
const hasAlpha = (m) => m && m.isImage && fs.existsSync(alphaPathOf(m.id));
async function ingest(id, name, file, ext) {
  let isImage = false;
  if (IMG_EXT.includes(ext)) {   // 사진은 30초짜리 정지 영상으로 바꿔 두면 영상처럼 편집·겹치기·내보내기가 다 돼요
    const still = path.join(DIRS.media, id + '.still.mp4');
    await run(FFMPEG, ['-y', '-loop', '1', '-framerate', '30', '-i', file, '-t', '30', '-vf', "scale='trunc(iw*sar/2)*2':'trunc(ih/2)*2',setsar=1,scale='min(1920,iw)':-2,format=yuv420p", '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '20', '-an', '-movflags', '+faststart', still]);
    try {   // 투명한 그림(PNG 등)은 투명이 살아있는 겹치기용 복사본을 따로 만들어 둬요
      const pf = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', file]);
      if (/(rgba|bgra|argb|abgr|ya8|ya16|pal8|yuva|gbrap)/.test(String(pf))) await run(FFMPEG, ['-y', '-loop', '1', '-framerate', '10', '-i', file, '-t', '30', '-vf', "scale='trunc(iw*sar/2)*2':'trunc(ih/2)*2',setsar=1,scale='min(1920,iw)':-2,format=yuva420p", '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '0', '-crf', '28', '-an', alphaPathOf(id)]);
    } catch (e) { try { fs.unlinkSync(alphaPathOf(id)); } catch (e2) {} }
    try { fs.unlinkSync(file); } catch (e) {} file = still; ext = '.mp4'; isImage = true;
  }
  const info = await probe(file);
  if (!info.hasVideo && !info.hasAudio) throw new Error('영상이나 오디오 파일이 아닙니다');
  const m = { id, name, file, size: fs.statSync(file).size, ...info, isImage };
  if (info.hasVideo) {
    const t = path.join(DIRS.cache, id + '.jpg');
    try { await run(FFMPEG, ['-y', '-ss', n(Math.min(1, info.duration / 2)), '-i', file, '-frames:v', '1', '-vf', 'scale=-2:120', t]); m.thumb = t; } catch (e) {}
  }
  if (info.hasAudio) {
    const pk = await peaks(file);
    fs.writeFileSync(path.join(DIRS.cache, id + '.peaks.json'), JSON.stringify(pk));
  }
  if (needsProxy(info, ext)) {
    const px = path.join(DIRS.cache, id + (info.hasVideo ? '.proxy.mp4' : '.proxy.mp3'));
    const args = info.hasVideo
      ? ['-y', '-i', file, '-vf', "scale='trunc(iw*sar/2)*2':ih,setsar=1,scale=-2:'min(1080,ih)'", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', px]
      : ['-y', '-i', file, '-vn', '-c:a', 'libmp3lame', '-b:a', '160k', px];
    await run(FFMPEG, args);
    m.preview = px;
  }
  return m;
}
async function handleRecord(req, res, q) {
  const name = (path.basename(q.get('name') || '녹음') || '녹음').replace(/\.[^.]*$/, '') + '.m4a';
  const id = crypto.randomBytes(6).toString('hex'), tmp = path.join(DIRS.cache || os.tmpdir(), id + '.rec'), file = path.join(DIRS.media, id + '.m4a');
  try {
    await pipeline(req, fs.createWriteStream(tmp));
    await new Promise((ok, no) => { const p = spawn(FFMPEG, ['-y', '-v', 'error', '-i', tmp, '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'aac', '-b:a', '160k', file], { windowsHide: true }); let er = ''; p.stderr.on('data', (d) => { er += d; }); p.on('error', no); p.on('close', (c) => (c === 0 ? ok() : no(new Error('녹음 파일을 변환하지 못했어요 ' + er.slice(-120))))); });
    try { fs.unlinkSync(tmp); } catch (e) {}
    const m = await ingest(id, name, file, '.m4a'); media[id] = m; saveDB(); json(res, 200, pub(m));
  } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) {} try { fs.unlinkSync(file); } catch (e2) {} json(res, 500, { error: e.message }); }
}
async function handleUpload(req, res, q) {
  const name = path.basename(q.get('name') || 'file');
  const ext = path.extname(name).toLowerCase();
  const id = crypto.randomBytes(6).toString('hex');
  const file = path.join(DIRS.media, id + ext);
  try {
    await pipeline(req, fs.createWriteStream(file));
    const m = await ingest(id, name, file, ext);
    media[id] = m; saveDB();
    json(res, 200, pub(m));
  } catch (e) {
    try { fs.unlinkSync(file); } catch (e2) {}
    json(res, 500, { error: e.message });
  }
}

const PROJ_DIR = path.join(WS, 'projects'); try { fs.mkdirSync(PROJ_DIR, { recursive: true }); } catch (e) {}
// ---- 스티커 (이미지 / GIF) ----
const STICKER_DIR = path.join(ROOT, '스티커'); const STICKER_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
try { fs.mkdirSync(STICKER_DIR, { recursive: true }); } catch (e) {}
const BUILTIN_STK = path.join(ROOT, '기본스티커');   // 편집기에 처음부터 들어 있는 스티커(지우거나 바꿀 수 없어요)
const stkPath = (n) => { const b = path.basename(String(n || '')); const a = path.join(STICKER_DIR, b); return fs.existsSync(a) ? a : path.join(BUILTIN_STK, b); };

// ---- 효과음 폴더 ----
const SETTINGS = path.join(WS, 'settings.json');
const loadSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) { return {}; } };
const getSfxDir = () => { const s = loadSettings(); return s.sfxDir !== undefined ? s.sfxDir : ''; };
const SFX_OWN = path.join(ROOT, '효과음'); fs.mkdirSync(SFX_OWN, { recursive: true });
const AUDIO_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.wma'];
function walkAudio(root, rel, depth) {
  let out = []; let ents = []; try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch (e) { return out; }
  for (const e of ents) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory() && depth < 3) out = out.concat(walkAudio(root, r, depth + 1));
    else if (e.isFile() && AUDIO_EXT.includes(path.extname(e.name).toLowerCase())) out.push({ name: e.name, rel: r });
    if (out.length > 1500) break;
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel, 'ko'));
}
function sfxPath(rel) {
  rel = String(rel || ''); let base = getSfxDir();
  if (rel.startsWith('@/')) { base = SFX_OWN; rel = rel.slice(2); }
  const root = path.resolve(base || '.'); if (!rel || !base) return null;
  const f = path.resolve(root, rel); if (!f.startsWith(root + path.sep)) return null;
  if (!AUDIO_EXT.includes(path.extname(f).toLowerCase())) return null;
  try { return fs.statSync(f).isFile() ? f : null; } catch (e) { return null; }
}

// ---- 폰트 (기본 제공 + 사용자 추가) ----
const FONT_EXT = ['.ttf', '.otf'];
const fontCache = {};
function readFontNames(buf) {
  try {
    let off = 0; if (buf.toString('ascii', 0, 4) === 'ttcf') off = buf.readUInt32BE(12);
    const num = buf.readUInt16BE(off + 4); let nt = 0;
    for (let i = 0; i < num; i++) { const r = off + 12 + i * 16; if (buf.toString('ascii', r, r + 4) === 'name') { nt = buf.readUInt32BE(r + 8); break; } }
    if (!nt) return null;
    const count = buf.readUInt16BE(nt + 2), so = nt + buf.readUInt16BE(nt + 4);
    const en = {}, ko = {};
    for (let i = 0; i < count; i++) {
      const r = nt + 6 + i * 12, plat = buf.readUInt16BE(r), lang = buf.readUInt16BE(r + 4), id = buf.readUInt16BE(r + 6), len = buf.readUInt16BE(r + 8), o = buf.readUInt16BE(r + 10);
      if (id !== 1 && id !== 2 && id !== 4 && id !== 16) continue;
      let str;
      if (plat === 3 || plat === 0) { const b = Buffer.from(buf.subarray(so + o, so + o + len)); str = b.swap16().toString('utf16le'); }
      else if (plat === 1) str = buf.toString('latin1', so + o, so + o + len); else continue;
      if (!str) continue;
      if (lang === 0x409 || (plat === 1 && lang === 0)) en[id] = en[id] || str;
      if (lang === 0x412) ko[id] = ko[id] || str;
    }
    const family = en[1] || en[16] || ko[1] || ko[16];
    if (!family) return null;
    return { family, label: ko[1] || ko[16] || family, sty: (en[17] || en[2] || '').trim(), base: en[1] || en[16] || ko[1] || ko[16], bst: (en[2] || '').trim() };
  } catch (e) { return null; }
}
function listFonts() {
  const out = [];
  for (const [dir, user, base] of [[path.join(ROOT, 'public', 'fonts'), false, '/fonts/'], [DIRS.fonts, true, '/userfonts/']]) {
    let files = []; try { files = fs.readdirSync(dir); } catch (e) {}
    files.sort().forEach((f) => {
      if (!FONT_EXT.includes(path.extname(f).toLowerCase())) return;
      const p = path.join(dir, f); let c = fontCache[p];
      if (!c) { c = fontCache[p] = readFontNames(fs.readFileSync(p)) || { family: path.basename(f, path.extname(f)), label: path.basename(f, path.extname(f)) }; }
      out.push({ family: c.family, label: c.label, sty: c.sty || '', base: c.base, bst: c.bst || '', url: base + encodeURIComponent(f), user, file: f, path: p });
    });
  }
  // 같은 이름의 글꼴이 둘 이상이면(예: 나눔명조 보통/Bold) 스타일을 붙여 따로 고를 수 있게 해요. 이름이 겹치지 않는 글꼴은 그대로 둬요.
  const cnt = {}; out.forEach((f) => { cnt[f.family] = (cnt[f.family] || 0) + 1; });
  out.forEach((f) => { if (cnt[f.family] > 1 && f.sty && !/^regular$/i.test(f.sty)) { if (!f.family.endsWith(' ' + f.sty) && !f.family.endsWith(f.sty)) f.family = f.family + ' ' + f.sty; if (!f.label.endsWith(f.sty)) f.label = f.label + ' ' + f.sty; } });
  const lc = {}; out.forEach((f) => { lc[f.label] = (lc[f.label] || 0) + 1; });
  out.forEach((f) => { if (lc[f.label] > 1 && f.sty && !f.label.endsWith(' ' + f.sty)) f.label = f.label + ' ' + f.sty; });
  return out;
}
const pubFonts = () => listFonts().map(({ path: _p, ...r }) => r);

const pub = (m) => ({ id: m.id, name: m.name, duration: m.duration, width: m.width, height: m.height, fps: m.fps, hasVideo: m.hasVideo, hasAudio: m.hasAudio, size: m.size, thumb: !!m.thumb, isImage: !!m.isImage, hasAlpha: !!hasAlpha(m) });

// ---- 파일 스트리밍(Range 지원) ----
function serveFile(req, res, file, type) {
  let st; try { st = fs.statSync(file); } catch (e) { res.writeHead(404); return res.end(); }
  type = type || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const r = req.headers.range;
  if (r) {
    const m = /bytes=(\d*)-(\d*)/.exec(r);
    let s = m && m[1] ? +m[1] : 0, e = m && m[2] ? +m[2] : st.size - 1;
    if (e >= st.size) e = st.size - 1;
    if (s > e) { res.writeHead(416); return res.end(); }
    res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${s}-${e}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1 });
    fs.createReadStream(file, { start: s, end: e }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  }
}

// ---- 내보내기 ----
const jobs = {};
const even = (x) => Math.max(2, Math.round(x / 2) * 2);
const CROP_R = { square: 1, '4:5': 0.8, '9:16': 9 / 16 };
function cropRect(c, m) {
  const W0 = m.width, H0 = m.height, r = CROP_R[c.crop];
  if (!r || !W0 || !H0) return null;
  let w = Math.min(W0, H0 * r), h = Math.min(H0, W0 / r); w = Math.floor(w / 2) * 2; h = Math.floor(h / 2) * 2;
  const pos = clamp((c.cropPos === undefined ? 50 : +c.cropPos) / 100, 0, 1);
  return { x: Math.floor((W0 - w) * pos / 2) * 2, y: Math.floor((H0 - h) / 4) * 2, w, h };
}

function enhChain(e) {
  if (!e || !e.on) return '';
  const L = clamp(+e.lvl || 2, 1, 3), f = ['highpass=f=80'];
  if (e.nr !== false) f.push(`afftdn=nr=${[8, 14, 22][L - 1]}:nf=${[-45, -40, -34][L - 1]}:tn=0`);
  if (e.clear !== false) f.push(`equalizer=f=250:width_type=q:width=1:g=${-[1, 2, 3][L - 1]}`, `equalizer=f=3200:width_type=q:width=1:g=${[2, 3, 5][L - 1]}`);
  if (e.lev !== false) f.push(`dynaudnorm=f=200:g=${[5, 7, 11][L - 1]}:p=0.9:m=${[6, 10, 16][L - 1]}`);
  return ',' + f.join(',');
}
function tempoChain(sp) {
  const parts = [];
  while (sp > 2.0001) { parts.push('atempo=2'); sp /= 2; }
  while (sp < 0.4999) { parts.push('atempo=0.5'); sp /= 0.5; }
  if (Math.abs(sp - 1) > 0.0001) parts.push(`atempo=${n(sp)}`);
  return parts.length ? ',' + parts.join(',') : '';
}

// 텍스트(제목·자막) → ASS 자막 파일
const assColor = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); const h = m ? m[1] : 'ffffff'; return (h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2)).toUpperCase(); };
const assTs = (x) => { x = Math.max(0, x); const h = Math.floor(x / 3600), m = Math.floor(x % 3600 / 60), s = x % 60; return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`; };
function buildAss(texts, W, H, total) {
  let o = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${W}\nPlayResY: ${H}\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Base,Arial,60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,0,0,0,0,100,100,0,0,1,6,2,5,${Math.round(W * 0.04)},${Math.round(W * 0.04)},40,1\nStyle: Box,Arial,60,&H00FFFFFF,&H00FFFFFF,&H00000000,&HFF000000,0,0,0,0,100,100,0,0,3,6,0,5,${Math.round(W * 0.04)},${Math.round(W * 0.04)},40,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  const k = W / 1080;
  for (const t of texts) {
    const txt = String(t.text || '').replace(/[{}]/g, (c) => (c === '{' ? '(' : ')'));
    if (!txt.trim()) continue;
    const st = Math.max(0, +t.start || 0), en = Math.min(+t.end || 0, total + 1);
    if (en <= st) continue;
    const size = Math.max(8, Math.round((+t.size || 80) * k)), bord = Math.max(0, +t.outline === 0 ? 0 : (+t.outline || 8) * k);
    const x = W * clamp(+t.x, 0, 100) / 100, y = H * clamp(+t.y, 0, 100) / 100;
    let font = String(t.font || 'Arial').replace(/[\\{},]/g, ''), bold = '';
    try { const ff = listFonts().find((f) => f.family === font); if (ff && ff.base && ff.base !== font) { font = ff.base; if (/bold/i.test(ff.bst)) bold = '\\b1'; } } catch (e) {}
    const body = txt.split(/\r?\n/).map((ln, i) => `{\\1c&H${assColor((t.colors && t.colors[i]) || t.color)}&}${ln}`).join('\\N');
    const tag = `{\\an5\\pos(${x.toFixed(1)},${y.toFixed(1)})\\fn${font}${bold}\\fs${size}\\bord${bord.toFixed(1)}\\shad${(2 * k).toFixed(1)}\\3c&H${assColor(t.outlineColor || '#000000')}&\\fad(80,60)}`;
    const lay = t.kind === 'sub' ? 0 : 2;
    if (t.box && +t.boxRadius > 0 && Array.isArray(t.boxW)) {   // 둥근 박스: 줄마다 둥근 사각형을 직접 그려요 (글자 너비는 편집기가 재서 보내 줘요)
      const op = clamp(t.boxOpacity == null ? 70 : +t.boxOpacity, 0, 100), al = Math.round((1 - op / 100) * 255).toString(16).toUpperCase().padStart(2, '0');
      const pad = Math.max(2, size * 0.16), nL = t.boxW.length, bh = size + pad, rr = clamp(+t.boxRadius, 0, 100) / 100;
      t.boxW.forEach((tw, i) => {
        const bw = Math.max(bh, (+tw || 0) + 2 * (pad + size * 0.5)), r = rr * bh / 2, kk = 0.5523 * r;
        const cx = x - bw / 2, cy = y + (i - (nL - 1) / 2) * size - bh / 2, f = (v) => v.toFixed(1);
        const d = `m ${f(r)} 0 l ${f(bw - r)} 0 b ${f(bw - r + kk)} 0 ${f(bw)} ${f(r - kk)} ${f(bw)} ${f(r)} l ${f(bw)} ${f(bh - r)} b ${f(bw)} ${f(bh - r + kk)} ${f(bw - r + kk)} ${f(bh)} ${f(bw - r)} ${f(bh)} l ${f(r)} ${f(bh)} b ${f(r - kk)} ${f(bh)} 0 ${f(bh - r + kk)} 0 ${f(bh - r)} l 0 ${f(r)} b 0 ${f(r - kk)} ${f(r - kk)} 0 ${f(r)} 0`;
        o += `Dialogue: ${lay},${assTs(st)},${assTs(en)},Base,,0,0,0,,{\\an7\\pos(${f(cx)},${f(cy)})\\bord0\\shad0\\p1\\1c&H${assColor(t.boxColor || '#000000')}&\\1a&H${al}&\\fad(80,60)}${d}{\\p0}\n`;
      });
    } else if (t.box) {   // 글자 뒤 박스: 같은 글자를 박스 스타일로 한 겹 더 깔아요 (글자색은 투명)
      const op = clamp(t.boxOpacity == null ? 70 : +t.boxOpacity, 0, 100), al = Math.round((1 - op / 100) * 255).toString(16).toUpperCase().padStart(2, '0');
      const pad = Math.max(2, size * 0.16);
      const btag = `{\\an5\\pos(${x.toFixed(1)},${y.toFixed(1)})\\fn${font}${bold}\\fs${size}\\bord${pad.toFixed(1)}\\shad0\\1a&HFF&\\3c&H${assColor(t.boxColor || '#000000')}&\\3a&H${al}&\\4a&HFF&\\fad(80,60)}`;
      o += `Dialogue: ${lay},${assTs(st)},${assTs(en)},Box,,0,0,0,,${btag}${txt.split(/\r?\n/).map((q) => '\\h\\h' + q + '\\h\\h').join('\\N')}\n`;
    }
    o += `Dialogue: ${lay + 1},${assTs(st)},${assTs(en)},Base,,0,0,0,,${tag}${body}\n`;
  }
  return o;
}

function buildExport(b) {
  const clips = b.clips || [], extra = b.audio || [];
  if (!clips.length) throw new Error('타임라인이 비어 있습니다');
  const W = (b.canvas && b.canvas.w | 0) || 1920, H = (b.canvas && b.canvas.h | 0) || 1080;
  const FPS = clamp(+b.fps || 30, 10, 60);
  const format = ['mp4', 'mp3', 'wav'].includes(b.format) ? b.format : 'mp4';
  const aOnly = format !== 'mp4';
  const tp = b.tpl && typeof b.tpl === 'object' ? b.tpl : null;
  const hex = (v, d) => /^#[0-9a-f]{6}$/i.test(v || '') ? '0x' + v.slice(1) : d;
  const thH = tp ? even(H * clamp(+tp.top || 0, 0, 60) / 100) : 0, bhH = tp ? even(H * clamp(+tp.bottom || 0, 0, 60) / 100) : 0;
  const rgH = Math.max(2, H - thH - bhH), fitMid = !!(tp && tp.fitMid);
  const blur = !tp && b.bg === 'blur';
  const inputs = [], filt = [], seg = [], tmpFiles = [];
  let total = 0;

  clips.forEach((c, k) => {
    const m = media[c.mediaId];
    if (!m) throw new Error('원본 파일을 찾을 수 없습니다: ' + c.mediaId);
    const sp = clamp(+c.speed || 1, 0.25, 4);
    const tin = Math.max(0, +c.in || 0);
    const len = Math.max(0.05, (+c.out || 0) - tin);
    const d = len / sp; total += d;
    inputs.push('-ss', n(tin), '-t', n(len), '-i', m.file);
    if (c.rev && len > 90) throw new Error('역방향 클립은 90초 이하로 잘라서 내보내 주세요 (너무 길면 컴퓨터 메모리가 모자라요)');

    if (!aOnly) {
      const rot = ((+c.rot || 0) % 360 + 360) % 360, sc = clamp(+c.scale || 100, 10, 400) / 100;
      const ox = (+c.x || 0) / 100 * W, oy = (+c.y || 0) / 100 * H;
      const cover = c.fit === 'cover', cr = cropRect(c, m);
      const pre = [`setpts=(PTS-STARTPTS)/${n(sp)}`, `fps=${FPS}`];
      if (c.rev) pre.push('reverse', 'setpts=PTS-STARTPTS');
      if (m.sar && Math.abs(m.sar - 1) > 0.01) pre.unshift(`scale=trunc(iw*${n(m.sar)}/2)*2:ih`, 'setsar=1');
      if (cr) pre.push(`crop=${cr.w}:${cr.h}:${cr.x}:${cr.y}`);
      if (rot === 90) pre.push('transpose=1'); else if (rot === 180) pre.push('hflip', 'vflip'); else if (rot === 270) pre.push('transpose=2');
      if (c.flip) pre.push('hflip');
      const fit = `scale=${W}:${H}:force_original_aspect_ratio=${cover ? 'increase' : 'decrease'}`;
      const zoom = Math.abs(sc - 1) >= 0.001 ? `scale=trunc(iw*${n(sc)}/2)*2:trunc(ih*${n(sc)}/2)*2` : null;
      const moved = Math.abs(ox) >= 0.5 || Math.abs(oy) >= 0.5;
      if (tp) {
        const rh = fitMid ? rgH : H, ry = fitMid ? thH : 0;
        const tfit = `scale=${W}:${rh}:force_original_aspect_ratio=${cover ? 'increase' : 'decrease'}`;
        const clipR = fitMid ? `crop=min(iw\\,${W}):min(ih\\,${rh})` : null;
        filt.push(`[${k}:v:0]${[...pre, tfit, zoom, clipR, 'setsar=1'].filter(Boolean).join(',')}[vs${k}]`);
        let bgc = `color=c=${hex(tp.midColor, '0x000000')}:s=${W}x${H}:r=${FPS}`;
        filt.push(`${bgc}[bg${k}]`);
        filt.push(`[bg${k}][vs${k}]overlay=x=(W-w)/2+${n(ox)}:y=${ry}+(${rh}-h)/2+${n(oy)}:shortest=1,setsar=1,format=yuv420p[v${k}]`);
      } else if (blur) {
        const bw = even(W / 4), bh = even(H / 4);
        filt.push(`[${k}:v:0]${pre.join(',')},split=2[fa${k}][ba${k}]`);
        filt.push(`[ba${k}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},gblur=sigma=7,scale=${W}:${H},eq=brightness=-0.12:saturation=0.9,setsar=1[bg${k}]`);
        filt.push(`[fa${k}]${[fit, zoom, 'setsar=1'].filter(Boolean).join(',')}[vs${k}]`);
        filt.push(`[bg${k}][vs${k}]overlay=x=(W-w)/2+${n(ox)}:y=(H-h)/2+${n(oy)},setsar=1,format=yuv420p[v${k}]`);
      } else if (!zoom && !moved) {
        pre.push(fit, cover ? `crop=${W}:${H}` : `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black`, 'setsar=1', 'format=yuv420p');
        filt.push(`[${k}:v:0]${pre.join(',')}[v${k}]`);
      } else {
        pre.push(fit); if (zoom) pre.push(zoom); pre.push('setsar=1');
        filt.push(`[${k}:v:0]${pre.join(',')}[vs${k}]`);
        filt.push(`color=c=black:s=${W}x${H}:r=${FPS}[bg${k}]`);
        filt.push(`[bg${k}][vs${k}]overlay=x=(W-w)/2+${n(ox)}:y=(H-h)/2+${n(oy)}:shortest=1,setsar=1,format=yuv420p[v${k}]`);
      }
    }
    const fade = `afade=t=in:d=0.012,afade=t=out:st=${n(Math.max(0, d - 0.02))}:d=0.02`;
    if (m.hasAudio && !c.mute) {
      const vol = clamp((c.vol === undefined ? 100 : +c.vol) / 100, 0, 4);
      filt.push(`[${k}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${c.rev ? ',areverse' : ''},asetpts=PTS-STARTPTS${enhChain(c.enh)}${tempoChain(sp)},volume=${n(vol)},apad,atrim=0:${n(d)},asetpts=PTS-STARTPTS,${fade}[a${k}]`);
    } else {
      filt.push(`anullsrc=r=48000:cl=stereo,atrim=0:${n(d)},asetpts=PTS-STARTPTS[a${k}]`);
    }
    let vv = `[v${k}]`;
    if (!aOnly) {
      const parts = [], tr = c.trans, nt = clips[k + 1] && clips[k + 1].trans;
      if (tr && tr.type && tr.type !== 'none') {
        const D = n(clamp(+tr.dur || 0.5, 0.1, Math.max(0.1, d / 2)));
        if (tr.type === 'black' || tr.type === 'white') parts.push(`fade=t=in:st=0:d=${D}:color=${tr.type}`);
        else if (tr.type === 'zoom') parts.push(`scale=w='trunc(${W}*(1+0.35*max(0,1-t/${D}))/2)*2':h='trunc(${H}*(1+0.35*max(0,1-t/${D}))/2)*2':eval=frame`, `crop=${W}:${H}`, `fade=t=in:st=0:d=${D}`);
      }
      if (nt && (nt.type === 'black' || nt.type === 'white')) { const D = n(clamp(+nt.dur || 0.5, 0.1, Math.max(0.1, d / 2))); parts.push(`fade=t=out:st=${n(Math.max(0, d - +D))}:d=${D}:color=${nt.type}`); }
      if (parts.length) { filt.push(`${vv}${parts.join(',')}[vt${k}]`); vv = `[vt${k}]`; }
    }
    seg.push(aOnly ? `[a${k}]` : `${vv}[a${k}]`);
  });

  filt.push(`${seg.join('')}concat=n=${clips.length}:v=${aOnly ? 0 : 1}:a=1${aOnly ? '' : '[vout]'}[aout]`);

  let aLabel = '[aout]';
  const ex = [];
  extra.forEach((a) => {
    const m = media[a.mediaId];
    if (!m || !m.hasAudio) return;
    const idx = clips.length + ex.length;
    const tin = Math.max(0, +a.in || 0), len = Math.max(0.05, (+a.out || 0) - tin);
    const ms = Math.max(0, Math.round((+a.start || 0) * 1000));
    const vol = clamp((a.vol === undefined ? 100 : +a.vol) / 100, 0, 4);
    inputs.push('-ss', n(tin), '-t', n(len), '-i', m.file);
    filt.push(`[${idx}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS${enhChain(a.enh)},volume=${n(vol)},adelay=${ms}|${ms}[x${ex.length}]`);
    ex.push(`[x${ex.length}]`);
  });
  const pips = aOnly && format === 'mp4' ? [] : (b.texts || []).filter((t) => t.kind === 'pip' && media[t.mediaId] && media[t.mediaId].hasVideo && (+t.end || 0) > (+t.start || 0));
  pips.forEach((t) => {   // 겹친 영상의 소리
    const m = media[t.mediaId]; if (!m.hasAudio) return;
    const idx = inputs.filter((x) => x === '-i').length, tin = Math.max(0, +t.in || 0), len = Math.max(0.05, (+t.end) - (+t.start));
    const ms = Math.max(0, Math.round((+t.start || 0) * 1000)), vol = clamp((t.vol == null ? 100 : +t.vol) / 100, 0, 2);
    inputs.push('-ss', n(tin), '-t', n(len), '-i', m.file);
    filt.push(`[${idx}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,volume=${n(vol)},adelay=${ms}|${ms}[x${ex.length}]`);
    ex.push(`[x${ex.length}]`);
  });
  if (ex.length) {
    filt.push(`[aout]${ex.join('')}amix=inputs=${ex.length + 1}:duration=first:dropout_transition=0,volume=${ex.length + 1},alimiter=limit=0.97[afinal]`);
    aLabel = '[afinal]';
  }
  if (b.normalize) { filt.push(`${aLabel}highpass=f=70,loudnorm=I=-15:TP=-1.5:LRA=11[anorm]`); aLabel = '[anorm]'; }

  let vLabel = '[vout]'; const ass = [];
  if (!aOnly && b.vhide) { filt.push(`${vLabel}drawbox=x=0:y=0:w=${W}:h=${H}:color=black:t=fill[vhide]`); vLabel = '[vhide]'; }
  const smoothE = (P) => `(${P}*${P}*(3-2*${P}))`;   // 부드럽게 시작·끝나는 곡선
  const zooms = aOnly ? [] : (b.texts || []).filter((t) => t.kind === 'zoom' && (+t.end || 0) > (+t.start || 0));
  if (zooms.length) {   // 부드러운 확대: 확대했다가 돌아오기. 확대 중심은 화면에서 제자리에 고정돼요
    let zx = '0', zy = '0', zz = '1';
    zooms.forEach((t) => {
      const st = Math.max(0, +t.start || 0), en = Math.max(st + 0.2, +t.end || 0), sc = clamp((+t.scale || 150) / 100, 1.05, 4);
      const e = Math.max(0.05, Math.min(t.ease == null ? 0.5 : +t.ease, (en - st) / 2));
      const P = `min(clip((t-${n(st)})/${n(e)},0,1),clip((${n(en)}-t)/${n(e)},0,1))`, SM = smoothE(P), fx = clamp(+t.x, 0, 100) / 100, fy = clamp(+t.y, 0, 100) / 100;
      zz += `+${n(sc - 1)}*${SM}`; zx += `+${n(fx * (sc - 1))}*${SM}*${W}`; zy += `+${n(fy * (sc - 1))}*${SM}*${H}`;
    });
    filt.push(`${vLabel}scale=w='trunc(${W}*(${zz})/2)*2':h='trunc(${H}*(${zz})/2)*2':eval=frame:flags=bilinear,crop=${W}:${H}:x='min(max(0,${zx}),iw-${W})':y='min(max(0,${zy}),ih-${H})'[vzoom]`); vLabel = '[vzoom]';
  }
  if (!aOnly) {
    (b.texts || []).filter((t) => t.kind === 'fx').forEach((t, k) => {
      const cw = Math.round(W * clamp(+t.w || 20, 1, 300) / 100 / 2) * 2, ch = Math.round(W * clamp(+t.h || 20, 1, 300) / 100 / 2) * 2;
      const cx = Math.round(W * clamp(+t.x, 0, 100) / 100 - cw / 2), cy = Math.round(H * clamp(+t.y, 0, 100) / 100 - ch / 2);
      const x0 = Math.max(0, cx), y0 = Math.max(0, cy), rw = Math.floor((Math.min(W, cx + cw) - x0) / 2) * 2, rh = Math.floor((Math.min(H, cy + ch) - y0) / 2) * 2;
      if (rw < 4 || rh < 4) return;
      const lvl = clamp(+t.level || 50, 1, 100), kf = W / 1080;
      const eff = t.mode === 'blur' ? `gblur=sigma=${n(Math.max(1, (2 + lvl * 0.5) * kf))}`
        : `scale=${Math.max(2, Math.floor(rw / Math.max(2, (4 + lvl * 0.4) * kf) / 2) * 2)}:${Math.max(2, Math.floor(rh / Math.max(2, (4 + lvl * 0.4) * kf) / 2) * 2)}:flags=bilinear,scale=${rw}:${rh}:flags=neighbor`;
      const st = Math.max(0, +t.start || 0), en = Math.max(st + 0.05, +t.end || 0);
      filt.push(`${vLabel}split[fxa${k}][fxb${k}]`);
      filt.push(`[fxb${k}]crop=${rw}:${rh}:${x0}:${y0},${eff}[fxc${k}]`);
      filt.push(`[fxa${k}][fxc${k}]overlay=x=${x0}:y=${y0}:enable='between(t,${n(st)},${n(en)})':eof_action=pass[fxd${k}]`);
      vLabel = `[fxd${k}]`;
    });
  }
  if (!aOnly && tp && (thH || bhH)) {   // 색 띠는 영상 위에 덮어 그려요 (글자·스티커보다는 아래)
    const bx = [];
    if (thH) bx.push(`drawbox=x=0:y=0:w=${W}:h=${thH}:color=${hex(tp.topColor, '0x000000')}:t=fill`);
    if (bhH) bx.push(`drawbox=x=0:y=${H - bhH}:w=${W}:h=${bhH}:color=${hex(tp.botColor, '0x000000')}:t=fill`);
    filt.push(`${vLabel}${bx.join(',')}[vband]`); vLabel = '[vband]';
  }
  const doPip = (t, k) => {   // 오버레이(영상·사진)
    const m = media[t.mediaId], idx = inputs.filter((x) => x === '-i').length, tin = Math.max(0, +t.in || 0);
    const st = Math.max(0, +t.start || 0), en = Math.max(st + 0.05, +t.end || 0), pw = even(W * clamp(+t.w || 40, 3, 300) / 100), ph = even(W * clamp(+t.h || 22, 3, 300) / 100), op = clamp((t.opacity == null ? 100 : +t.opacity) / 100, 0, 1);
    if (hasAlpha(m)) inputs.push('-c:v', 'libvpx-vp9', '-ss', n(tin), '-t', n(en - st), '-i', alphaPathOf(m.id)); else inputs.push('-ss', n(tin), '-t', n(en - st), '-i', m.file);
    filt.push(`[${idx}:v:0]fps=${FPS},scale=${pw}:${ph},format=rgba${op < 0.999 ? `,colorchannelmixer=aa=${n(op)}` : ''},setpts=PTS-STARTPTS+${n(st)}/TB[pp${k}]`);
    filt.push(`${vLabel}[pp${k}]overlay=x=${n(W * clamp(+t.x, 0, 100) / 100)}-w/2:y=${n(H * clamp(+t.y, 0, 100) / 100)}-h/2:enable='between(t,${n(st)},${n(en)})':eof_action=pass:format=auto[pv${k}]`);
    vLabel = `[pv${k}]`;
  };
  const stks = aOnly ? [] : (b.texts || []).filter((t) => t.kind === 'sticker' && t.sid && fs.existsSync(stkPath(t.sid)));
  const doStk = (t, k) => {
    const f = stkPath(t.sid), gif = /\.gif$/i.test(f);
    const idx = inputs.filter((x) => x === '-i').length;
    if (gif) inputs.push('-ignore_loop', '0', '-i', f); else inputs.push('-loop', '1', '-framerate', String(FPS), '-i', f);
    const w = even(W * clamp(+t.scale || 30, 2, 200) / 100), rot = clamp(+t.rot || 0, -360, 360);
    const st = Math.max(0, +t.start || 0), en = Math.max(st + 0.05, +t.end || 0);
    let chain = `[${idx}:v]format=rgba,scale=${w}:-2`;
    if (rot) chain += `,rotate=${n(rot)}*PI/180:ow=rotw(${n(rot)}*PI/180):oh=roth(${n(rot)}*PI/180):c=none`;
    chain += `,setpts=PTS-STARTPTS+${n(st)}/TB[sk${k}]`;
    filt.push(chain);
    filt.push(`${vLabel}[sk${k}]overlay=x=${n(W * clamp(+t.x, 0, 100) / 100)}-w/2:y=${n(H * clamp(+t.y, 0, 100) / 100)}-h/2:enable='between(t,${n(st)},${n(en)})':eof_action=pass:format=auto[sv${k}]`);
    vLabel = `[sv${k}]`;
  };
  const shapes = aOnly ? [] : (b.texts || []).filter((t) => t.kind === 'shape' && t.png);
  const doShape = (t, k) => {
    const f = path.join(DIRS.cache, `shape_${crypto.randomBytes(4).toString('hex')}_${k}.png`);
    fs.writeFileSync(f, Buffer.from(String(t.png), 'base64')); tmpFiles.push(f);
    const idx = inputs.filter((x) => x === '-i').length;
    inputs.push('-loop', '1', '-framerate', String(FPS), '-i', f);
    const st = Math.max(0, +t.start || 0), en = Math.max(st + 0.05, +t.end || 0), op = clamp((t.opacity == null ? 100 : +t.opacity) / 100, 0, 1);
    filt.push(`[${idx}:v]format=rgba${op < 0.999 ? `,colorchannelmixer=aa=${n(op)}` : ''},setpts=PTS-STARTPTS+${n(st)}/TB[sh${k}]`);
    let xe = `${n(W * clamp(+t.x, 0, 100) / 100)}-w/2`, ye = `${n(H * clamp(+t.y, 0, 100) / 100)}-h/2`;
    if (t.mv && t.x2 != null && t.y2 != null) {   // 포인터 이동: 시작 자리 → 도착 자리로 부드럽게
      const D = Math.max(0.05, +t.mvDur || 1), SM = smoothE(`clip((t-${n(st)})/${n(D)},0,1)`);
      xe = `${n(W * clamp(+t.x, 0, 100) / 100)}+${n(W * (clamp(+t.x2, 0, 100) - clamp(+t.x, 0, 100)) / 100)}*${SM}-w/2`; ye = `${n(H * clamp(+t.y, 0, 100) / 100)}+${n(H * (clamp(+t.y2, 0, 100) - clamp(+t.y, 0, 100)) / 100)}*${SM}-h/2`;
    }
    filt.push(`${vLabel}[sh${k}]overlay=x='${xe}':y='${ye}':enable='between(t,${n(st)},${n(en)})':eof_action=pass:format=auto[sg${k}]`);
    vLabel = `[sg${k}]`;
  };
  const texts = aOnly ? [] : (b.texts || []).filter((t) => (t.kind === 'text' || t.kind === 'sub') && String(t.text || '').trim());
  const zOf = (t) => ({ pip: 0, sticker: 1, shape: 1, text: 2, sub: 3 }[t.kind] ?? 1) * 1000 + (+t.lane || 0);
  const ops = [];   // 레이어 순서(z)대로 아래에서 위로 쌓아요
  if (!aOnly) { pips.forEach((t, k) => ops.push({ z: zOf(t), o: 0, f: () => doPip(t, k) })); stks.forEach((t, k) => ops.push({ z: zOf(t), o: 1, f: () => doStk(t, k) })); shapes.forEach((t, k) => ops.push({ z: zOf(t), o: 1, f: () => doShape(t, k) })); texts.forEach((t) => ops.push({ z: zOf(t), o: t.kind === 'sub' ? 3 : 2, txt: t })); }
  ops.sort((p, q) => p.z - q.z || p.o - q.o);
  let run = [];
  const flush = () => { if (!run.length) return; const nm = `sub${ass.length}.ass`; ass.push(buildAss(run, W, H, total)); filt.push(`${vLabel}ass=${nm}:fontsdir=fonts,format=yuv420p[vtxt${ass.length}]`); vLabel = `[vtxt${ass.length}]`; run = []; };
  ops.forEach((op) => { if (op.txt) run.push(op.txt); else { flush(); op.f(); } });
  flush();

  const q = { fast: ['ultrafast', 26], std: ['veryfast', 20], high: ['medium', 17] }[b.quality] || ['veryfast', 20];
  const enc = [];
  if (format === 'mp4') enc.push('-map', vLabel, '-map', aLabel, '-c:v', 'libx264', '-preset', q[0], '-crf', String(q[1]), '-pix_fmt', 'yuv420p', '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
  else if (format === 'mp3') enc.push('-map', aLabel, '-c:a', 'libmp3lame', '-b:a', '192k');
  else enc.push('-map', aLabel, '-c:a', 'pcm_s16le');
  enc.push('-t', n(total));
  return { inputs, filter: filt.join(';\n'), enc, total, format, ass, tmpFiles };
}

function startExport(b) {
  const g = buildExport(b);
  const id = crypto.randomBytes(5).toString('hex');
  let base = String(b.name || '').replace(/[\\/:*?"<>|]/g, '').trim() || ('영상_' + stamp());
  let outDir = String(b.outDir || '').trim().replace(/^"|"$/g, '') || getOutDir();
  try { fs.mkdirSync(outDir, { recursive: true }); fs.accessSync(outDir, fs.constants.W_OK); } catch (e) { throw new Error('이 폴더에는 저장할 수 없어요: ' + outDir); }
  if (b.outDir) { const st = loadSettings(); st.outDir = outDir; try { fs.writeFileSync(SETTINGS, JSON.stringify(st)); } catch (e) {} }
  let out = path.join(outDir, base + '.' + g.format), i = 1;
  while (fs.existsSync(out)) out = path.join(outDir, `${base} (${i++}).${g.format}`);
  // 작업 폴더: 필터 스크립트·자막·폰트를 여기에 두고 상대 경로로 사용 (윈도우 경로 문제 방지)
  const dir = path.join(DIRS.cache, 'job_' + id);
  fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'filter.txt'), g.filter);
  if (g.ass && g.ass.length) {
    g.ass.forEach((c, i) => fs.writeFileSync(path.join(dir, `sub${i}.ass`), c, 'utf8'));
    listFonts().forEach((f) => { try { fs.copyFileSync(f.path, path.join(dir, 'fonts', f.file)); } catch (e) {} });
  }
  const args = ['-y', '-hide_banner', '-nostats', '-progress', 'pipe:1', ...g.inputs, '-filter_complex_script', 'filter.txt', ...g.enc, out];
  const job = { id, status: 'running', progress: 0, file: out, error: '', log: '' };
  jobs[id] = job;
  const p = spawn(FFMPEG, args, { cwd: dir });
  job.proc = p;
  let buf = '';
  p.stdout.on('data', (d) => {
    buf += d; const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) {
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(l);
      if (m) job.progress = clamp(+m[1] / 1e6 / g.total, 0, 0.99);
    }
  });
  p.stderr.on('data', (d) => { job.log = (job.log + d).slice(-4000); });
  p.on('error', (e) => { job.status = 'error'; job.error = 'ffmpeg를 실행할 수 없습니다: ' + e.message; });
  p.on('close', (code) => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    (g.tmpFiles || []).forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} });
    if (job.status === 'canceled') { try { fs.unlinkSync(out); } catch (e) {} return; }
    if (code === 0) { job.status = 'done'; job.progress = 1; }
    else if (job.status !== 'error') { job.status = 'error'; job.error = job.log.split('\n').filter(Boolean).slice(-4).join('\n') || ('종료 코드 ' + code); }
  });
  return job;
}

// ---- 샘플 프로젝트 ----
const SAMPLE_DIR = path.join(ROOT, 'samples');
async function ensureSample() {
  const proj = JSON.parse(fs.readFileSync(path.join(SAMPLE_DIR, 'project.json'), 'utf8'));
  const names = proj.mediaNames || {}, list = [];
  for (const id of Object.keys(names)) {
    const src = path.join(SAMPLE_DIR, id + '.mp4');
    if (!fs.existsSync(src)) throw new Error('샘플 파일이 없습니다: ' + id + '.mp4');
    if (!media[id] || !fs.existsSync(media[id].file)) {
      const dest = path.join(DIRS.media, id + '.mp4'); fs.copyFileSync(src, dest);
      media[id] = await ingest(id, names[id], dest, '.mp4'); saveDB();
    }
    list.push(pub(media[id]));
  }
  delete proj.mediaNames;
  return { media: list, project: proj };
}

// ---- 윈도우용 폴더 선택 창: 탐색기 모양(내 PC, 다운로드, 바탕 화면…)의 새 창. 실패하면 예전 창으로 대신해요 ----
const WIN_FOLDER_CS = String.raw`
using System; using System.Runtime.InteropServices;
public static class DsFolder {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FOD {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFD {
    [PreserveSig] int Show(IntPtr h);
    void SetFileTypes(uint c, IntPtr f); void SetFileTypeIndex(uint i); void GetFileTypeIndex(out uint i);
    void Advise(IntPtr p, out uint c); void Unadvise(uint c);
    void SetOptions(uint o); void GetOptions(out uint o);
    void SetDefaultFolder(IShl s); void SetFolder(IShl s); void GetFolder(out IShl s); void GetCurrentSelection(out IShl s);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string n); void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string n);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string t); void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string t); void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string t);
    void GetResult(out IShl s);
  }
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShl {
    void BindToHandler(IntPtr p, ref Guid b, ref Guid r, out IntPtr o); void GetParent(out IShl s);
    void GetDisplayName(uint n, [MarshalAs(UnmanagedType.LPWStr)] out string s); void GetAttributes(uint m, out uint a); void Compare(IShl o, uint h, out int r);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)] static extern void SHCreateItemFromParsingName(string p, IntPtr b, ref Guid r, out IShl s);
  public static string Pick(string title, string init, IntPtr owner) {
    IFD d = (IFD)new FOD(); uint o; d.GetOptions(out o); d.SetOptions(o | 0x20 | 0x40 | 0x800);
    d.SetTitle(title);
    if (!string.IsNullOrEmpty(init) && System.IO.Directory.Exists(init)) { try { Guid g = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"); IShl f; SHCreateItemFromParsingName(init, IntPtr.Zero, ref g, out f); d.SetFolder(f); } catch { } }
    int hr = d.Show(owner);
    if (hr == unchecked((int)0x800704C7)) return "";
    if (hr != 0) Marshal.ThrowExceptionForHR(hr);
    IShl r; d.GetResult(out r); string p; r.GetDisplayName(0x80058000, out p); return p;
  }
}`;
function winFolderPS(title, init) {
  const q = (t) => String(t || '').replace(/'/g, "''");
  const ps = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms
$o=New-Object System.Windows.Forms.Form; $o.TopMost=$true; $null=$o.Handle
$cs=@'
${WIN_FOLDER_CS}
'@
$ok=$true
try { Add-Type -TypeDefinition $cs -ErrorAction Stop; $r=[DsFolder]::Pick('${q(title)}','${q(init)}',$o.Handle); if($r){ $r } } catch { $ok=$false }
if(-not $ok){ $f=New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description='${q(title)}'; $f.ShowNewFolderButton=$true; if(Test-Path -LiteralPath '${q(init)}'){$f.SelectedPath='${q(init)}'}; if($f.ShowDialog($o) -eq 'OK'){ $f.SelectedPath } }`;
  return ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')];
}
// ---- 저장 폴더 ----
const getOutDir = () => { const d = loadSettings().outDir; return d && String(d).trim() ? d : DIRS.out; };
function pickDir(cur) {
  return new Promise((resolve) => {
    const q = String(cur || '').replace(/'/g, "''");
    let cmd, args;
    if (process.platform === 'win32') {
      cmd = 'powershell'; args = winFolderPS('저장할 폴더를 고르세요', cur);
    } else if (process.platform === 'darwin') {
      cmd = 'osascript'; args = ['-e', 'POSIX path of (choose folder with prompt "저장할 폴더를 고르세요")'];
    } else { cmd = 'zenity'; args = ['--file-selection', '--directory', '--title=저장할 폴더를 고르세요']; }
    execFile(cmd, args, { timeout: 300000, windowsHide: false }, (e, so) => resolve(e ? '' : String(so).trim().replace(/[\r\n]+$/, '')));
  });
}

// ---- 브라우저 열기 ----

// ---- 자동 편집 폴더 (Claude·ChatGPT 같은 AI에게 맡길 영상/소스를 넣어 두는 곳) ----
const AUTO_CFG = path.join(WS, 'auto.json');
const AUTO_DEFAULT = path.join(os.homedir(), 'Documents', '단동샘 자동편집');
function autoCfg() { let c = {}; try { c = JSON.parse(fs.readFileSync(AUTO_CFG, 'utf8')); } catch (e) {} return { root: c.root || AUTO_DEFAULT, extra: Array.isArray(c.extra) ? c.extra : [] }; }
function autoSave(c) { try { fs.writeFileSync(AUTO_CFG, JSON.stringify(c)); } catch (e) {} }
const inside = (p, root) => { const r = path.resolve(root), q = path.resolve(p); return q === r || q.startsWith(r + path.sep); };
function autoAllowed(p) { const c = autoCfg(); return inside(p, c.root) || c.extra.some((e) => inside(p, e)); }
const MEDIA_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.png', '.jpg', '.jpeg', '.gif', '.webp'];
const DSP_GUIDE = `단동샘 편집기 프로젝트 파일(.dsp) 만드는 법
=====================================
이 폴더의 영상·소스를 편집한 뒤, 편집 내용을 "결과" 폴더에 .dsp 파일로 저장해 주세요.
.dsp 는 UTF-8 JSON 텍스트 파일입니다. 영상 자체는 넣지 않고 "어느 영상의 몇 초~몇 초를 쓰는지"만 적습니다.
영상 파일은 이 폴더에 그대로 두세요. 사용자가 편집기에서 열면 같은 이름의 파일을 자동으로 찾아 연결합니다.
※ 원본 영상은 이름도 내용도 바꾸지 말고, 편집기가 회전·픽셀 비율·화면 비율을 알아서 맞추니 비율 보정용 복사본은 만들지 마세요.

[전체 모양]
{
  "app": "dandongsam", "v": 1, "name": "프로젝트 이름",
  "data": {
    "canvas": "9:16",            // 사용자가 말한 영상 모양 그대로: "16:9"(가로 유튜브) | "9:16"(세로 쇼츠) | "original" | "1:1" | "4:3"
    "bg": "none",                // 항상 "none"
    "tpl": null,                 // 색 띠 템플릿은 9:16 에서만. 안 쓰면 null
    "media": { "m1": { "name": "영상1.mp4" } },   // 키(m1)는 아래 mediaId 와 같게, name 은 폴더 안 실제 파일 이름 (확장자·공백·괄호까지 똑같이)
    "clips": [ ... ],            // 영상 조각들. 적은 순서대로 이어 붙습니다
    "audio": [ ... ],            // 추가 소리(효과음·배경음악). 없으면 []
    "texts": [ ... ]             // 제목 글자와 자막
  }
}

[clips] 영상 조각 (순서대로 이어 붙음)
{ "id": "c1", "mediaId": "m1", "in": 3.2, "out": 10.5,     // 원본 영상의 3.2초~10.5초 구간 사용 (초 단위)
  "speed": 1, "vol": 100, "mute": false,                   // 재생 속도(0.25~4), 음량(0~200), 소리 끄기
  "fit": "contain",                                        // "contain"(전체 보기) | "cover"(화면 채우기)
  "scale": 100, "x": 0, "y": 0, "rot": 0, "flip": false }  // 확대(10~400), 위치(%), 회전(90 단위), 좌우반전
  - 자르고 싶은 구간은 쓰지 말고 건너뛰세요 (예: 0~3초, 5~9초 를 쓰면 3~5초는 컷됩니다).
  - 선택: "enh": { "on": true, "lvl": 2, "nr": true, "clear": true, "lev": true }  음성 보정(잡음 줄이기·또렷하게·볼륨 고르게)

[audio] 추가 소리 (더빙·내레이션·효과음·배경음악)
{ "id": "a1", "mediaId": "m2", "start": 0, "in": 0, "out": 20, "vol": 60 }
  start = 완성 영상에서 이 소리가 시작되는 시간(초), in/out = 소리 파일에서 쓸 구간(초)
  - 더빙을 쓰면 영상 조각(clips)은 "mute": true, "vol": 0 으로 두세요. 영상 컷과 더빙은 따로 움직일 수 있어야 하므로 합치지 마세요.
  - 같은 더빙 파일을 여러 조각으로 나눠 쓸 수 있어요 (조각마다 in/out/start). 건너뛴 구간은 사용자가 조각 끝을 늘려 되살릴 수 있습니다.

[texts] 제목 글자(kind "text") 와 자막(kind "sub")
{ "id": "t1", "kind": "sub", "text": "안녕하세요", "start": 0.5, "end": 3.0,   // start/end = 완성 영상 기준 시간(초)
  "x": 50, "y": 81,                    // 화면 위치(%) — 가운데 기준. 편집설정.json 이 있으면 그 값이 우선 (없을 때만 자막 y 81, 제목 y 10~42)
  "font": "Cafe24 Ssurround", "size": 86, "color": "#ffffff",
  "outline": 8, "outlineColor": "#000000", "colors": [] }
  - 글자 배경 박스(선택): "box": true, "boxColor": "#000000", "boxOpacity": 70 (0~100). 편집설정.json 의 subtitle 에 들어 있으면 그대로 복사.
  - 제목은 "kind": "text", size 90 정도. 줄바꿈은 \\n. 줄마다 색을 달리하려면 "colors": ["#ffffff", "#FFFD00"]
  - 자막은 한 줄에 너무 길지 않게, 문장 중간에서 끊기지 않게 나눠 주세요. (세로 쇼츠는 한 줄 14자 안팎, 가로 16:9 는 26자 안팎)
  - 자막 크기·위치는 편집설정.json 의 subtitle 값 그대로 쓰세요. 가로(16:9)라고 줄이거나 옮기지 마세요 (사용자가 롱폼·강의·숏폼별로 직접 저장한 값이에요).
  - 쓸 수 있는 글꼴: Cafe24 Ssurround, Cafe24 Dangdanghae, Cafe24 Danjunghae, Cafe24 Dongdong, Cafe24 Ohsquare, Cafe24 Syongsyong, Cafe24 Supermagic OTF Bold, Kyobo Handwriting 2019, Ownglyph PDH Regular, omyu pretty, AndongKaturi, Ownglyph yuntaeng Regular, insungit Cutelively jisu, KCC-Chassam, Single Day, NanumMyeongjo, NanumMyeongjo Bold, NanumMyeongjo ExtraBold

[편집설정.json]  (이 폴더에 있으면 꼭 읽고 그대로 따르세요)
- canvas : 영상 모양. .dsp 의 data.canvas 에 그대로 쓰세요 ("9:16" 세로 쇼츠 / "16:9" 가로 유튜브).
- portrait : 가로(16:9)로 만들 때 세로로 찍은 영상(보이는 크기가 세로인 영상)을 어떻게 할지. "rot90"(기본) = 그 영상 조각의 rot 를 90 으로, "rot270" = rot 를 270 으로 (가로 화면에 꽉 차게 돌림, fit 은 "contain"), "keep" = 돌리지 않음. 영상을 자르거나 흐리게 채우지 마세요. 이미 가로인 영상은 건드리지 마세요.
- tpl : 쇼츠 색 띠 템플릿 값. null 이 아니면 data.tpl 에 그대로 복사하세요 (null 이면 data.tpl 도 null).
  tpl.fitMid 도 그대로 복사: false = 영상이 위·아래 띠 뒤까지 전체 화면에 맞춰짐, true = 위·아래 띠 사이 가운데 칸 안에서만 보임. 임의로 바꾸지 마세요.
- title : 쇼츠 제목 글자 스타일. null 이 아니면 영상 내용에 맞는 제목을 2줄(줄바꿈 \\n)로 지어서 texts 에 kind "text" 로 넣고, 이 스타일 값(font,size,color,colors,outline,x,y 등)을 그대로 쓰세요. 영상 처음부터 끝까지 보이게 start 0, end 전체 길이.
- lecture : true 이면 강의(실습) 영상이에요. 아래 [강의·화면 녹화용 효과]의 화살표·네모·클릭 표시·체크·확대를 필요한 곳마다 꼭 넣으세요. "하단 자막만"은 제목 글자·색 띠를 빼라는 뜻이고 화면 강조를 빼라는 뜻이 아닙니다. 위치를 확신할 수 없는 곳에는 넣지 마세요. 화면 이미지는 토큰을 많이 쓰니 "누르세요·클릭·선택" 같은 말이 나온 시각에서만 640px 이하로 줄여 보고(여러 장은 한 장에 모아서) 영상 한 편에 전체 20장을 넘기지 마세요. false 이거나 없으면 자막과 컷 편집만 하세요.
- subtitle : 자막 스타일(사용자가 편집기에서 저장한 롱폼·강의·숏폼 스타일). 모든 자막(kind "sub") 항목에 이 값(font,size,color,outline,outlineColor,x,y 와 글자 배경 box,boxColor,boxOpacity 등 들어 있는 키 전부)을 한 글자도 바꾸지 말고 그대로 쓰세요. 기본값으로 덮어쓰거나 직접 고르지 마세요.

[강의·화면 녹화용 효과 (필요할 때만 texts 에 추가)]
- 부드러운 확대: {id, kind:"zoom", start, end, scale:150(110~400), ease:0.5, x, y(확대 중심, 화면 % 0~100), text:""}. 클릭·작은 글씨를 크게 보여 줄 때. 시작과 끝에서 부드럽게 커졌다 돌아와요. 서로 겹치지 않게.
- 도형: kind "shape", shape 는 "arrow"(화살표) "check"(✔) "cross"(✖) "checkbox"(☑) "pointer"(마우스 포인터) "click"(클릭 표시 원) "rect" "ellipse". x,y(중심 %), w,h(% 너비 기준), rot, fill:true, fillColor, stroke, strokeColor, strokeW, opacity, start, end, text:"".
- 포인터 이동: pointer 도형에 mv:true, x2,y2(도착 %), mvDur(이동 초). 도착 순간에 같은 자리에 "click" 도형을 0.4초쯤 추가하면 클릭처럼 보여요.

[규칙]
- 사용자가 "승인 후 진행"을 말하지 않았다면 중간에 멈추지 말고 끝까지 만들어 주세요.
- 음성 인식(Whisper 등)이 안 되면 추측해서 쓰지 말고, 결과에 "자막 못 만듦"이라고 적은 뒤 사용자에게 알려 주세요 (편집기의 "목소리로 자막 만들기"로 만들 수 있어요).
- 모든 id 는 서로 달라야 합니다.
- in < out, start < end. 모든 mediaId 는 media 에 있어야 합니다.
- "결과" 폴더에 만든 .dsp 파일 이름은 한글이어도 됩니다 (예: 내영상_편집.dsp).
`;
function prepareJob(dir) {
  fs.mkdirSync(path.join(dir, '결과'), { recursive: true });
  fs.writeFileSync(path.join(dir, '프로젝트파일_만드는법.txt'), DSP_GUIDE, 'utf8');
}
function countIn(d, re) { let n = 0; try { fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { if (e.isFile() && re.test(e.name)) n++; }); } catch (e) {} return n; }
function jobInfo(dir, kind) {
  let st; try { st = fs.statSync(dir); } catch (e) { return null; }
  const dsp = []; [path.join(dir, '결과'), dir].forEach((d) => { try { fs.readdirSync(d, { withFileTypes: true }).forEach((e) => { if (e.isFile() && /\.dsp$/i.test(e.name)) { const f = path.join(d, e.name); dsp.push({ name: e.name.replace(/\.dsp$/i, ''), file: f, mtime: fs.statSync(f).mtimeMs }); } }); } catch (e) {} });
  dsp.sort((a, b) => b.mtime - a.mtime);
  return { path: dir, name: kind === 'legacy' ? '이전 작업 (기본 폴더)' : path.basename(dir), kind, mtime: Math.max(st.mtimeMs, ...dsp.map((x) => x.mtime)), videos: countIn(dir, /\.(mp4|mov|m4v|webm|mkv|avi)$/i), results: dsp };
}
function autoJobs() {
  const c = autoCfg(), jobs = [];
  try { fs.readdirSync(c.root, { withFileTypes: true }).forEach((e) => { if (e.isDirectory() && e.name !== '결과' && !e.name.startsWith('.')) { const j = jobInfo(path.join(c.root, e.name), 'root'); if (j) jobs.push(j); } }); } catch (e) {}
  if (fs.existsSync(path.join(c.root, '결과'))) { const j = jobInfo(c.root, 'legacy'); if (j) jobs.push(j); }
  c.extra.forEach((p) => { const j = jobInfo(p, 'extra'); if (j) jobs.push(j); });
  jobs.sort((a, b) => b.mtime - a.mtime); return { root: c.root, sep: path.sep, jobs };
}
function pickFolder() {
  return new Promise((resolve) => {
    let cmd, args;
    if (process.platform === 'win32') { cmd = 'powershell.exe'; args = winFolderPS('편집할 영상이 들어 있는 폴더를 고르세요', ''); }
    else if (process.platform === 'darwin') { cmd = 'osascript'; args = ['-e', 'POSIX path of (choose folder)']; }
    else return resolve(null);
    let out = ''; const ch = spawn(cmd, args, { windowsHide: true }); ch.stdout.on('data', (d) => { out += d; }); ch.on('error', () => resolve(null)); ch.on('close', (code) => { const v = out.trim().replace(/[\\/]$/, ''); resolve(v || (code === 0 ? '' : null)); });   // '' = 취소, null = 선택 창을 못 열었음
  });
}
function pickFile(initDir) {   // 내 컴퓨터 파일 선택 창 (시작 위치 = 작업 폴더의 결과 폴더)
  return new Promise((resolve) => {
    let cmd, args; const env = { ...process.env, DSP_INIT: initDir };
    if (process.platform === 'win32') { cmd = 'powershell.exe'; args = ['-NoProfile', '-STA', '-Command', "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.Form; $f.TopMost=$true; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.InitialDirectory=$env:DSP_INIT; $d.Title='받은 결과(.dsp) 파일을 고르세요'; $d.Filter='단동샘 프로젝트 (*.dsp;*.json)|*.dsp;*.json|모든 파일 (*.*)|*.*'; if($d.ShowDialog($f) -eq 'OK'){ $d.FileName }"]; }
    else if (process.platform === 'darwin') { cmd = 'osascript'; args = ['-e', 'POSIX path of (choose file with prompt "받은 결과(.dsp) 파일을 고르세요" default location (POSIX file (system attribute "DSP_INIT")))']; }
    else return resolve(null);
    let out = ''; const ch = spawn(cmd, args, { windowsHide: true, env }); ch.stdout.on('data', (d) => { out += d; }); ch.on('error', () => resolve(null)); ch.on('close', () => resolve(out.trim().replace(/[\r\n]+$/, '')));
  });
}
function openFolder(dir) {
  if (process.platform === 'win32') spawn('explorer', [dir], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
}
function findInJob(dir, name) {
  const want = String(name || '').normalize('NFC').toLowerCase(); let hit = null;
  const walk = (d, depth) => { if (hit || depth > 2) return; let l = []; try { l = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of l) { if (hit) return; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, depth + 1); else if (e.name.normalize('NFC').toLowerCase() === want) hit = p; } };
  walk(dir, 0); return hit;
}

// ---- 프로젝트가 적어 둔 파일 이름과 폴더의 실제 파일을 최대한 이어 줘요 ----
const MED_RE = /\.(mp4|mov|m4v|mkv|webm|avi|wmv|flv|mpg|mpeg|ts|mts|m2ts|3gp|wav|mp3|m4a|aac|flac|ogg|opus|wma)$/i;
function listMedia(dir, depth = 0, out = []) {
  let l = []; try { l = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of l) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (depth < 2) listMedia(p, depth + 1, out); } else if (MED_RE.test(e.name)) out.push(p); }
  return out;
}
const looseKey = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/\.[a-z0-9]{2,4}$/i, '').replace(/\(\d+\)|[\s_\-.,]+/g, '').replace(/[^0-9a-z\u3131-\u318e\uac00-\ud7a3]/g, '');
const numKey = (s) => (String(s || '').normalize('NFC').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/\(\d+\)/g, '').match(/\d+/g) || []).map(Number);
const isAud = (s) => /\.(wav|mp3|m4a|aac|flac|ogg|opus|wma)$/i.test(s);
function matchFiles(dir, names, linked) {
  const all = listMedia(dir), used = new Set(), res = new Map();
  const take = (nm, p, how) => { res.set(nm, p); used.add(p); if (how) linked.push({ from: nm, to: path.basename(p) }); };
  for (const nm of names) { const want = nm.normalize('NFC').toLowerCase(); const p = all.find((x) => !used.has(x) && path.basename(x).normalize('NFC').toLowerCase() === want); if (p) take(nm, p); }
  for (const nm of names) { if (res.has(nm)) continue; const k = looseKey(nm); if (!k) continue; const p = all.find((x) => !used.has(x) && looseKey(path.basename(x)) === k); if (p) take(nm, p, 1); }
  for (const kind of [false, true]) {   // 아직 못 찾은 것 → 같은 종류(영상/오디오)의 남은 파일과 번호로, 그래도 안 되면 순서로
    const left = names.filter((nm) => !res.has(nm) && isAud(nm) === kind);
    const pool = all.filter((x) => !used.has(x) && isAud(x) === kind);
    if (!left.length || !pool.length) continue;
    const byNum = new Map();
    for (const nm of left) { const nk = numKey(nm); if (!nk.length) continue; const c = pool.filter((x) => !used.has(x) && numKey(path.basename(x)).join(',') === nk.join(',')); if (c.length === 1) byNum.set(nm, c[0]); }
    const seen = new Map(); for (const [nm, p] of byNum) seen.set(p, (seen.get(p) || 0) + 1);
    for (const [nm, p] of byNum) if (seen.get(p) === 1 && !used.has(p)) take(nm, p, 1);
    const l2 = left.filter((nm) => !res.has(nm)), p2 = pool.filter((x) => !used.has(x));
    if (l2.length && l2.length === p2.length) {
      const nat = (a, b) => String(a).localeCompare(String(b), 'ko', { numeric: true });
      l2.sort(nat); p2.sort((a, b) => nat(path.basename(a), path.basename(b)));
      l2.forEach((nm, i) => take(nm, p2[i], 1));
    }
  }
  return res;
}

// ---- 홈 화면용 외부 소식 (유튜브 채널 · 블로그스팟 최신 글) ----
const https = require('https');
const feedCache = {};
function httpGet(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 DandongsamEditor' }, timeout: 8000 }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects > 0) { r.resume(); return resolve(httpGet(new URL(r.headers.location, url).href, redirects - 1)); }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      const ch = []; r.on('data', (d) => ch.push(d)); r.on('end', () => resolve(Buffer.concat(ch).toString('utf8')));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); }); req.on('error', reject);
  });
}
// ---- 업데이트 도우미 ----
const APP_VER = process.env.DDS_VER || (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch (e) { return '0.0.0'; } })();
const UPD_REPO = 'dandong5864/dandongsam-editor';
const upd = { state: 'idle', pct: 0, err: '', file: '' };
const verParts = (v) => String(v || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
const verNewer = (a, b) => { const x = verParts(a), y = verParts(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
let updCache = null;
async function updCheck() {
  if (updCache && Date.now() - updCache.t < 5 * 60 * 1000) return updCache.v;
  let v;
  if (process.env.DDS_UPDATE_TEST) v = { current: APP_VER, latest: '9.9.9', newer: true, url: 'test', size: 3000000 };
  else {
    const j = JSON.parse(await httpGet(`https://api.github.com/repos/${UPD_REPO}/releases/latest`));
    const a = (j.assets || []).find((x) => /\.exe$/i.test(x.name || ''));
    const latest = String(j.tag_name || '').replace(/^v/i, '');
    v = { current: APP_VER, latest, newer: !!(a && latest && verNewer(latest, APP_VER)), url: a ? a.browser_download_url : '', size: a ? a.size : 0 };
  }
  updCache = { t: Date.now(), v }; return v;
}
function updDownload(url, dest, size, onProg, redirects = 6) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 DandongsamEditor' }, timeout: 30000 }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects > 0) { r.resume(); return resolve(updDownload(new URL(r.headers.location, url).href, dest, size, onProg, redirects - 1)); }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      const total = +r.headers['content-length'] || size || 0; let got = 0; const out = fs.createWriteStream(dest);
      r.on('data', (d) => { got += d.length; if (total) onProg(Math.min(99, Math.round(got / total * 100))); });
      r.pipe(out); out.on('finish', () => out.close(() => resolve(got))); out.on('error', reject); r.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('시간 초과'))); req.on('error', reject);
  });
}
async function updStart(i) {
  if (upd.state === 'downloading') return;
  upd.state = 'downloading'; upd.pct = 0; upd.err = '';
  try {
    if (process.env.DDS_UPDATE_TEST) { for (let k = 1; k <= 10; k++) { await new Promise((r) => setTimeout(r, 120)); upd.pct = k * 10 - (k === 10 ? 1 : 0); } upd.file = path.join(os.tmpdir(), 'dds_test_update.exe'); upd.state = 'ready'; upd.pct = 100; return; }
    if (!i.url || i.url.indexOf(`https://github.com/${UPD_REPO}/releases/download/`) !== 0) throw new Error('내려받을 주소가 올바르지 않아요');
    const dest = path.join(os.tmpdir(), 'DandongsamEditor-Setup.exe'); try { fs.unlinkSync(dest); } catch (e) {}
    const n = await updDownload(i.url, dest, i.size, (pc) => { upd.pct = pc; });
    const hd = Buffer.alloc(2); const fd = fs.openSync(dest, 'r'); fs.readSync(fd, hd, 0, 2, 0); fs.closeSync(fd);
    if (hd.toString('latin1') !== 'MZ' || (i.size && n !== i.size)) throw new Error('내려받은 파일이 올바르지 않아요');
    upd.file = dest; upd.state = 'ready'; upd.pct = 100;
  } catch (e) { upd.state = 'error'; upd.err = '내려받지 못했어요 (' + (e.message || e) + ')'; }
}
async function cachedFeed(key, fn) {
  const c = feedCache[key]; if (c && Date.now() - c.t < 10 * 60 * 1000) return c.v;
  const v = await fn(); feedCache[key] = { t: Date.now(), v }; return v;
}
const xmlText = (s) => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
async function youtubeFeed(channelId) {
  if (!/^UC[\w-]{20,24}$/.test(channelId)) throw new Error('채널 주소가 올바르지 않아요');
  const xml = await httpGet('https://www.youtube.com/feeds/videos.xml?channel_id=' + channelId);
  const out = []; const re = /<entry>([\s\S]*?)<\/entry>/g; let m;
  while ((m = re.exec(xml)) && out.length < 8) { const id = (/<yt:videoId>([^<]+)</.exec(m[1]) || [])[1]; const t = (/<title>([\s\S]*?)<\/title>/.exec(m[1]) || [])[1]; const pub = (/<published>([^<]+)</.exec(m[1]) || [])[1]; if (id) out.push({ title: xmlText(t), url: 'https://www.youtube.com/watch?v=' + id, thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, date: pub }); }
  return out;
}
async function blogFeed(blogUrl) {
  const u = new URL(/^https?:\/\//i.test(blogUrl) ? blogUrl : 'https://' + blogUrl);
  const j = JSON.parse(await httpGet(u.origin + '/feeds/posts/default?alt=json&max-results=8'));
  return ((j.feed && j.feed.entry) || []).map((e) => {
    const link = ((e.link || []).find((l) => l.rel === 'alternate') || {}).href || u.origin;
    const up = (u) => u.replace(/\/s\d+(-c)?\//, '/s640/').replace(/\/w\d+-h\d+(-[a-z]+)*\//, '/s640/');
    let th = ''; const m = /<img[^>]+src=["']([^"']+)["']/i.exec((e.content && e.content.$t) || '');
    if (m) th = up(m[1]); else if (e['media$thumbnail']) th = up(e['media$thumbnail'].url);
    if (th.startsWith('//')) th = 'https:' + th;
    return { title: (e.title && e.title.$t) || '', url: link, thumb: th, date: e.published && e.published.$t };
  });
}

// ---- 음성 → 자막 (Whisper large-v3-turbo, 내 컴퓨터에서 실행) ----
const STT_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin';
const STT_DIR = path.join(WS, 'models'), STT_FILE = path.join(STT_DIR, 'ggml-large-v3-turbo-q5_0.bin'), STT_MIN = 400 * 1024 * 1024;
const stt = { dl: { state: 'idle', pct: 0, msg: '' }, job: { state: 'idle', pct: 0, msg: '', segs: [], err: '' } };
let sttCtx = null, sttStop = false, sttCur = null;
const sttHave = () => { try { return fs.statSync(STT_FILE).size > STT_MIN; } catch (e) { return false; } };
function sttDownload() {
  if (stt.dl.state === 'running') return; stt.dl = { state: 'running', pct: 0, msg: '내려받는 중…' };
  try { fs.mkdirSync(STT_DIR, { recursive: true }); } catch (e) {}
  const part = STT_FILE + '.part';
  const get = (url, hops) => {
    https.get(url, { headers: { 'User-Agent': 'DandongsamEditor' } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops > 0) { r.resume(); return get(new URL(r.headers.location, url).href, hops - 1); }
      if (r.statusCode !== 200) { r.resume(); stt.dl = { state: 'error', pct: 0, msg: '내려받지 못했어요 (HTTP ' + r.statusCode + '). 인터넷 연결을 확인해 주세요' }; return; }
      const total = +r.headers['content-length'] || 0; let got = 0; const ws = fs.createWriteStream(part);
      r.on('data', (d) => { got += d.length; if (total) stt.dl.pct = Math.min(99, Math.floor(got / total * 100)); stt.dl.msg = `내려받는 중… ${Math.round(got / 1048576)}MB`; });
      r.pipe(ws);
      ws.on('finish', () => { try { fs.renameSync(part, STT_FILE); stt.dl = { state: 'done', pct: 100, msg: '준비 완료' }; } catch (e) { stt.dl = { state: 'error', pct: 0, msg: e.message }; } });
      r.on('error', (e) => { stt.dl = { state: 'error', pct: 0, msg: '연결이 끊겼어요: ' + e.message }; });
    }).on('error', (e) => { stt.dl = { state: 'error', pct: 0, msg: '인터넷에 연결할 수 없어요: ' + e.message }; });
  };
  get(STT_URL, 5);
}
function pcmOf(file, tin, len) {
  return new Promise((resolve, reject) => {
    const ch = []; const p = spawn(FFMPEG, ['-v', 'error', '-ss', String(tin), '-t', String(len), '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { windowsHide: true });
    p.stdout.on('data', (d) => ch.push(d)); p.on('error', reject); p.on('close', () => resolve(Buffer.concat(ch)));
  });
}
async function sttRun(clips, lang) {
  const J = stt.job = { state: 'running', pct: 0, msg: '준비하는 중…', segs: [], err: '' }; sttStop = false;
  try {
    if (!sttCtx) {
      let mod; try { mod = require('@fugood/whisper.node'); } catch (e) { throw new Error('음성 인식 구성요소를 불러오지 못했어요 (' + e.message.split('\n')[0] + ')'); }
      J.msg = '음성 인식 모델을 켜는 중… (처음엔 조금 걸려요)'; sttCtx = await mod.initWhisper({ filePath: STT_FILE, useGpu: false });
    }
    const totalDur = clips.reduce((a, c) => a + Math.max(0, (c.out - c.in)), 0) || 1; let done = 0;
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i], m = media[c.mediaId]; const len = Math.max(0, c.out - c.in);
      if (!m || !m.hasAudio || c.mute || len < 0.3) { done += len; continue; }
      if (sttStop) break;
      J.msg = `목소리를 글로 바꾸는 중… (${i + 1}/${clips.length})`;
      const pcm = await pcmOf(m.file, c.in, len); if (pcm.length < 3200) { done += len; continue; }
      const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
      const base = done, sp = c.speed || 1;
      const job = sttCtx.transcribeData(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength), { language: lang || 'ko', temperature: 0, maxLen: 1, splitOnWord: true, tokenTimestamps: true, onProgress: (p) => { J.pct = Math.min(99, Math.floor((base + len * p / 100) / totalDur * 100)); } });
      sttCur = job; const res = await job.promise; sttCur = null;
      (res.segments || []).forEach((s) => { const raw = String(s.text || ''), t = raw.trim(); if (!t) return; const a = Math.max(0, s.t0 / 1000), b = Math.min(len, s.t1 / 1000); if (b <= a) return; J.segs.push({ sp: /^\s/.test(raw), text: t, start: +(c.start + a / sp).toFixed(2), end: +(c.start + b / sp).toFixed(2) }); });
      done += len; J.pct = Math.min(99, Math.floor(done / totalDur * 100));
    }
    J.state = sttStop ? 'stopped' : 'done'; J.pct = 100; J.msg = sttStop ? '중단했어요' : '끝!';
  } catch (e) { J.state = 'error'; J.err = String(e.message || e); J.msg = '문제가 생겼어요'; }
}
function revealPath(p) {
  const abs = path.resolve(p);
  if (!abs.startsWith(DIRS.out) && !abs.startsWith(DIRS.cap) && !Object.values(jobs).some((j) => j && path.resolve(j.file) === abs)) return;
  if (process.platform === 'win32') spawn('explorer', ['/select,', abs], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', ['-R', abs], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [path.dirname(abs)], { detached: true, stdio: 'ignore' }).unref();
}
function openApp(url) {
  if (process.env.NO_OPEN) return;
  if (process.platform === 'win32') {
    exec(`start "" msedge --app="${url}"`, (e) => { if (e) exec(`start "" "${url}"`); });
  } else if (process.platform === 'darwin') {
    exec(`open -na "Google Chrome" --args --app="${url}" || open "${url}"`);
  } else exec(`xdg-open "${url}"`);
}

// ---- 창을 닫으면 자동 종료 (exe 실행 때만) ----
let lastPing = 0, byeAt = 0;
if (process.env.AUTO_QUIT) {
  const busy = () => Object.values(jobs).some((j) => j && (j.status === 'running' || j.status === 'queued'));
  setInterval(() => {
    if (busy()) { byeAt = 0; return; }
    const now = Date.now();
    if (byeAt && now - byeAt > 10000) process.exit(0);
    if (lastPing && now - lastPing > 180000) process.exit(0);
  }, 3000).unref();
}

// ---- 라우터 ----
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname);
  try {
    if (req.method === 'POST' && p === '/api/upload') return handleUpload(req, res, u.searchParams);
    if (req.method === 'POST' && p === '/api/record') return handleRecord(req, res, u.searchParams);
    if (req.method === 'GET' && p === '/api/media') return json(res, 200, Object.values(media).map(pub));
    let m;
    if (req.method === 'GET' && (m = /^\/media\/(\w+)$/.exec(p))) {
      const it = media[m[1]]; if (!it) { res.writeHead(404); return res.end(); }
      if (u.searchParams.get('a') && hasAlpha(it)) return serveFile(req, res, alphaPathOf(it.id), 'video/webm');
      return serveFile(req, res, it.preview || it.file);
    }
    if (req.method === 'GET' && (m = /^\/api\/thumb\/(\w+)$/.exec(p))) {
      const it = media[m[1]]; if (!it || !it.thumb) { res.writeHead(404); return res.end(); }
      return serveFile(req, res, it.thumb, 'image/jpeg');
    }
    if (req.method === 'GET' && (m = /^\/api\/peaks\/(\w+)$/.exec(p))) {
      const f = path.join(DIRS.cache, m[1] + '.peaks.json');
      if (!fs.existsSync(f)) return json(res, 200, []);
      return serveFile(req, res, f, 'application/json');
    }
    if (req.method === 'DELETE' && (m = /^\/api\/media\/(\w+)$/.exec(p))) {
      const it = media[m[1]];
      if (it) {
        [it.file, it.thumb, it.preview, path.join(DIRS.cache, it.id + '.peaks.json')].forEach((f) => { try { f && fs.unlinkSync(f); } catch (e) {} });
        delete media[m[1]]; saveDB();
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/auto/jobs') return json(res, 200, autoJobs());
    if (req.method === 'POST' && p === '/api/auto/new') {
      const b = await readBody(req); const nm = String(b.name || '').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 60);
      if (!nm || nm === '결과') return json(res, 400, { error: '작업 이름을 적어 주세요' });
      const dir = path.join(autoCfg().root, nm);
      if (fs.existsSync(dir)) return json(res, 400, { error: '같은 이름의 작업이 이미 있어요' });
      try { prepareJob(dir); } catch (e) { return json(res, 500, { error: '폴더를 만들지 못했어요: ' + e.message }); }
      openFolder(dir); return json(res, 200, { path: dir });
    }
    if (req.method === 'POST' && p === '/api/auto/pick') {
      const dir = await pickFolder(); if (!dir) return json(res, 200, { path: '', canceled: dir === '' }); return json(res, 200, { path: dir });
    }
    if (req.method === 'POST' && p === '/api/auto/add') {
      const b = await readBody(req); const dir = path.resolve(String(b.path || '').replace(/^"|"$/g, ''));
      let ok = false; try { ok = fs.statSync(dir).isDirectory(); } catch (e) {}
      if (!ok) return json(res, 400, { error: '그 폴더를 찾을 수 없어요' });
      const c = autoCfg(); if (!inside(dir, c.root) && !c.extra.includes(dir)) { c.extra.push(dir); autoSave(c); }
      try { prepareJob(dir); } catch (e) { return json(res, 500, { error: '폴더에 쓸 수 없어요: ' + e.message }); }
      return json(res, 200, { path: dir });
    }
    if (req.method === 'POST' && p === '/api/auto/root') {
      const b = await readBody(req); const dir = path.resolve(String(b.path || '').replace(/^"|"$/g, ''));
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return json(res, 400, { error: '그 위치에 폴더를 만들 수 없어요' }); }
      const c = autoCfg(); c.root = dir; autoSave(c); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/auto/settings') {
      const b = await readBody(req); const d = path.resolve(String(b.path || ''));
      if (!autoAllowed(d) || !fs.existsSync(d)) return json(res, 400, { error: '폴더를 찾을 수 없어요' });
      try { fs.writeFileSync(path.join(d, '편집설정.json'), JSON.stringify(b.settings || {}, null, 2), 'utf8'); fs.writeFileSync(path.join(d, '프로젝트파일_만드는법.txt'), DSP_GUIDE, 'utf8'); } catch (e) { return json(res, 500, { error: e.message }); }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/auto/import') {
      const dir = path.resolve(String(u.searchParams.get('path') || '')); if (!autoAllowed(dir) || !fs.existsSync(dir)) return json(res, 400, { error: '작업 폴더를 찾을 수 없어요' });
      let txt = ''; await new Promise((ok) => { const ch = []; req.on('data', (c) => ch.push(c)); req.on('end', () => { txt = Buffer.concat(ch).toString('utf8').replace(/^\uFEFF/, ''); ok(); }); });
      let j; try { j = JSON.parse(txt); } catch (e) { return json(res, 400, { error: '프로젝트 파일(.dsp) 형식이 아니에요. AI가 만든 파일을 그대로 올려 주세요' }); }
      if (!j || typeof j !== 'object') return json(res, 400, { error: '프로젝트 파일을 읽을 수 없어요' });
      const nm = (path.basename(String(u.searchParams.get('name') || '결과')).replace(/\.(dsp|json|txt)$/i, '').replace(/[\\/:*?"<>|]/g, '') || '결과') + '.dsp';
      fs.mkdirSync(path.join(dir, '결과'), { recursive: true }); const f = path.join(dir, '결과', nm); fs.writeFileSync(f, JSON.stringify(j), 'utf8'); return json(res, 200, { file: f });
    }
    if (req.method === 'POST' && p === '/api/auto/pickfile') {   // 작업 폴더의 결과 폴더를 연 상태로 파일 고르기
      const b = await readBody(req); const dir = path.resolve(String(b.path || '')); if (!autoAllowed(dir) || !fs.existsSync(dir)) return json(res, 400, { error: '작업 폴더를 찾을 수 없어요' });
      const R = path.join(dir, '결과'); fs.mkdirSync(R, { recursive: true });
      const f = await pickFile(R); if (f === null) return json(res, 200, { unsupported: true }); if (!f) return json(res, 200, { canceled: true });
      let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return json(res, 400, { error: '프로젝트 파일(.dsp) 형식이 아니에요. AI가 만든 파일을 그대로 골라 주세요' }); }
      if (!j || typeof j !== 'object') return json(res, 400, { error: '프로젝트 파일을 읽을 수 없어요' });
      let dest = path.resolve(f);
      if (path.dirname(dest) !== path.resolve(R) || !/\.dsp$/i.test(dest)) { const nm = (path.basename(f).replace(/\.(dsp|json|txt)$/i, '').replace(/[\\/:*?"<>|]/g, '') || '결과') + '.dsp'; dest = path.join(R, nm); fs.writeFileSync(dest, JSON.stringify(j), 'utf8'); }
      return json(res, 200, { file: dest });
    }
    if (req.method === 'POST' && p === '/api/auto/openfolder') {
      const b = await readBody(req); if (!autoAllowed(String(b.path || ''))) return json(res, 400, { error: '열 수 없는 폴더예요' });
      openFolder(path.resolve(b.path)); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/auto/terminal') {
      const b = await readBody(req); const d = path.resolve(String(b.path || ''));
      if (!autoAllowed(d) || /["%&|<>^]/.test(d)) return json(res, 400, { error: '열 수 없는 폴더예요' });
      if (process.platform !== 'win32') return json(res, 400, { error: '윈도우에서만 쓸 수 있어요. 폴더 주소창에 cmd 를 입력해 열어 주세요' });
      spawn('cmd.exe', ['/c', `start "" /D "${d}" cmd /k claude`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref(); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/auto/delete') {
      const b = await readBody(req); const f = path.resolve(String(b.path || '')); const c = autoCfg();
      if (b.what === 'result') {
        if (!autoAllowed(f) || !/\.dsp$/i.test(f)) return json(res, 400, { error: '지울 수 없어요' });
        try { fs.unlinkSync(f); } catch (e) { return json(res, 500, { error: e.message }); } return json(res, 200, { ok: true });
      }
      if (b.what === 'unlink') { c.extra = c.extra.filter((e) => path.resolve(e) !== f); autoSave(c); return json(res, 200, { ok: true }); }
      if (b.what === 'job') {
        if (!inside(f, c.root) || f === path.resolve(c.root) || path.dirname(f) !== path.resolve(c.root)) return json(res, 400, { error: '이 폴더는 여기서 지울 수 없어요 (직접 지워 주세요)' });
        try { fs.rmSync(f, { recursive: true, force: true }); } catch (e) { return json(res, 500, { error: '지우지 못했어요: ' + e.message }); } return json(res, 200, { ok: true });
      }
      return json(res, 400, { error: '잘못된 요청' });
    }
    if (req.method === 'POST' && p === '/api/auto/open') {
      const b = await readBody(req); const f = path.resolve(String(b.file || ''));
      if (!autoAllowed(f) || !/\.dsp$/i.test(f) || !fs.existsSync(f)) return json(res, 400, { error: '프로젝트 파일을 찾을 수 없어요' });
      let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return json(res, 400, { error: '프로젝트 파일을 읽을 수 없어요 (형식이 맞지 않아요)' }); }
      const data = j.data || j; const names = new Set(); { let mm = data.media || {}; (Array.isArray(mm) ? mm : Object.values(mm)).forEach((m) => { const nm = typeof m === 'string' ? m : (m && (m.name || m.file)); if (nm) names.add(String(nm)); }); (data.clips || []).concat(data.audio || []).forEach((c) => { const nm = c && (c.name || c.file); if (nm) names.add(String(nm)); }); }
      const added = [], missing = [], linked = []; const jobDir = path.basename(path.dirname(f)) === '결과' ? path.dirname(path.dirname(f)) : path.dirname(f);
      const todo = [...names].filter((nm) => { const N = nm.normalize('NFC'); if (Object.values(media).find((m) => String(m.name).normalize('NFC') === N)) return false;
        const al = Object.values(media).find((m) => (m.alias || []).some((x) => String(x).normalize('NFC') === N)); if (al) { linked.push({ from: nm, to: al.name }); return false; } return true; });
      const found = matchFiles(jobDir, todo, linked);
      for (const nm of todo) {
        const src = found.get(nm); if (!src) { missing.push(nm); continue; }
        const ext = path.extname(src).toLowerCase(); const id = crypto.randomBytes(6).toString('hex'), dest = path.join(DIRS.media, id + ext);
        try { fs.copyFileSync(src, dest); const m = await ingest(id, path.basename(src), dest, ext); if (path.basename(src).normalize('NFC') !== nm.normalize('NFC')) m.alias = [nm]; media[id] = m; saveDB(); added.push(pub(m)); } catch (e) { try { fs.unlinkSync(dest); } catch (e2) {} missing.push(nm); }
      }
      try {   // 가로(16:9) 작업에서 세로 영상은 설정대로 90° 돌려 가로 화면에 맞춰요 (AI가 빠뜨려도 편집기가 챙겨요)
        let por = 'rot90'; try { const sj = JSON.parse(fs.readFileSync(path.join(jobDir, '편집설정.json'), 'utf8').replace(/^\uFEFF/, '')); if (sj.portrait) por = sj.portrait; } catch (e) {}
        if (data.canvas === '16:9' && por !== 'keep' && data.media && !Array.isArray(data.media)) {
          const byName = (nm) => Object.values(media).find((m) => String(m.name).normalize('NFC') === String(nm).normalize('NFC') || (m.alias || []).some((x) => String(x).normalize('NFC') === String(nm).normalize('NFC')));
          const por2 = new Set(Object.keys(data.media).filter((k) => { const mm = data.media[k]; const r = byName(typeof mm === 'string' ? mm : (mm && (mm.name || mm.file))); return r && r.hasVideo && r.height > r.width; }));
          (data.clips || []).forEach((c) => { if (por2.has(c.mediaId) && !(+c.rot)) { c.rot = por === 'rot270' ? 270 : 90; if (!c.fit) c.fit = 'contain'; } });
        }
      } catch (e) {}
      if (linked.length) { const mp = new Map(linked.map((x) => [x.from.normalize('NFC'), x.to])); const fix = (m) => { if (typeof m === 'string') return mp.get(m.normalize('NFC')) || m; if (m && typeof m === 'object') { const k = m.name || m.file; if (k && mp.has(String(k).normalize('NFC'))) { m.name = mp.get(String(k).normalize('NFC')); if (m.file) m.file = m.name; } } return m; };
        if (Array.isArray(data.media)) data.media = data.media.map(fix); else if (data.media) Object.keys(data.media).forEach((k) => { data.media[k] = fix(data.media[k]); }); }
      return json(res, 200, { data, name: j.name || path.basename(f, '.dsp'), media: added, missing, linked });
    }
    if (req.method === 'GET' && p === '/api/feed/youtube') {
      const ch = String(new URL(req.url, 'http://x').searchParams.get('channel') || '');
      try { return json(res, 200, { list: await cachedFeed('yt' + ch, () => youtubeFeed(ch)) }); } catch (e) { return json(res, 200, { list: [], error: e.message }); }
    }
    if (req.method === 'GET' && p === '/api/feed/blog') {
      const bu = String(new URL(req.url, 'http://x').searchParams.get('url') || '');
      try { return json(res, 200, { list: await cachedFeed('bl' + bu, () => blogFeed(bu)) }); } catch (e) { return json(res, 200, { list: [], error: '블로그 글을 불러오지 못했어요' }); }
    }
    // ---- 새 버전 알림 · 자동 업데이트 (GitHub 릴리스) ----
    if (req.method === 'GET' && p === '/api/update/check') { try { return json(res, 200, await updCheck()); } catch (e) { return json(res, 200, { newer: false, error: '확인 못 함' }); } }
    if (req.method === 'POST' && p === '/api/update/start') { try { const i = await updCheck(); if (!i.newer) return json(res, 200, { ok: false, error: '이미 최신 버전이에요' }); updStart(i); return json(res, 200, { ok: true }); } catch (e) { return json(res, 200, { ok: false, error: e.message }); } }
    if (req.method === 'GET' && p === '/api/update/status') return json(res, 200, { state: upd.state, pct: upd.pct, err: upd.err });
    if (req.method === 'POST' && p === '/api/update/install') {
      if (upd.state !== 'ready') return json(res, 200, { ok: false, error: '아직 내려받는 중이에요' });
      if (process.env.DDS_UPDATE_TEST) return json(res, 200, { ok: true, test: true });
      if (process.platform !== 'win32') return json(res, 200, { ok: false, error: '윈도우에서만 자동 설치돼요' });
      try { const c = spawn(upd.file, [], { detached: true, stdio: 'ignore' }); c.unref(); } catch (e) { return json(res, 200, { ok: false, error: '설치 프로그램을 열 수 없어요' }); }
      json(res, 200, { ok: true }); setTimeout(() => process.exit(0), 1500); return;
    }
    if (req.method === 'GET' && p === '/api/stt/status') return json(res, 200, { have: sttHave(), dl: stt.dl, job: { state: stt.job.state, pct: stt.job.pct, msg: stt.job.msg, err: stt.job.err, count: stt.job.segs.length, segs: stt.job.state === 'done' ? stt.job.segs : undefined } });
    if (req.method === 'POST' && p === '/api/stt/download') { if (!sttHave()) sttDownload(); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && p === '/api/stt/start') {
      if (!sttHave()) return json(res, 400, { error: '먼저 음성 인식 모델을 내려받아 주세요' }); if (stt.job.state === 'running') return json(res, 400, { error: '이미 만드는 중이에요' });
      const b = await readBody(req); const clips = (b.clips || []).map((c) => ({ mediaId: c.mediaId, in: +c.in || 0, out: +c.out || 0, speed: +c.speed || 1, start: +c.start || 0, mute: !!c.mute }));
      sttRun(clips, b.lang); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/stt/stop') { sttStop = true; try { sttCur && sttCur.stop && sttCur.stop(); } catch (e) {} return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && p === '/api/enh-preview') {
      const b = await readBody(req); const m = media[b.mediaId]; if (!m || !m.hasAudio) return json(res, 400, { error: '소리가 없어요' });
      const st = Math.max(0, +b.start || 0), len = clamp(+b.len || 8, 1, 20), out = path.join(DIRS.cache, 'enhp_' + crypto.randomBytes(4).toString('hex') + '.mp3');
      try {
        await run(FFMPEG, ['-y', '-ss', n(st), '-t', n(len), '-i', m.file, '-vn', '-af', 'aresample=48000,aformat=channel_layouts=stereo' + (b.raw ? '' : enhChain(b.enh)) + ',volume=' + n(clamp((+b.vol || 100) / 100, 0, 4)), '-c:a', 'libmp3lame', '-b:a', '128k', out]);
        const buf = fs.readFileSync(out); try { fs.unlinkSync(out); } catch (e) {}
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store' }); return res.end(buf);
      } catch (e) { try { fs.unlinkSync(out); } catch (e2) {} return json(res, 500, { error: '미리 듣기를 만들지 못했어요' }); }
    }
    if (req.method === 'POST' && p === '/api/export') {
      const job = startExport(await readBody(req));
      return json(res, 200, { id: job.id });
    }
    if (req.method === 'GET' && (m = /^\/api\/job\/(\w+)$/.exec(p))) {
      const j = jobs[m[1]]; if (!j) return json(res, 404, { error: '작업 없음' });
      return json(res, 200, { status: j.status, progress: j.progress, file: j.file, error: j.error });
    }
    if (req.method === 'POST' && (m = /^\/api\/job\/(\w+)\/cancel$/.exec(p))) {
      const j = jobs[m[1]]; if (j && j.status === 'running') { j.status = 'canceled'; j.proc.kill(); }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/capture') {
      const b = await readBody(req); const it = media[b.mediaId];
      if (!it || !it.hasVideo) return json(res, 400, { error: '영상이 없습니다' });
      const out = path.join(DIRS.cap, `캡처_${stamp()}.png`);
      await run(FFMPEG, ['-y', '-ss', n(Math.max(0, +b.t || 0)), '-i', it.file, '-frames:v', '1', out]);
      return json(res, 200, { file: out });
    }
    if (req.method === 'POST' && p === '/api/reveal') {
      const b = await readBody(req); revealPath(String(b.file || '')); return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/fonts') return json(res, 200, pubFonts());
    if (req.method === 'POST' && p === '/api/font') {
      const raw = path.basename(u.searchParams.get('name') || 'font.ttf'); const ext = path.extname(raw).toLowerCase();
      if (!FONT_EXT.includes(ext)) { await pipeline(req, fs.createWriteStream(path.join(DIRS.cache, 'discard'))); return json(res, 400, { error: 'TTF 또는 OTF 폰트 파일만 추가할 수 있어요' }); }
      const dest = path.join(DIRS.fonts, raw);
      await pipeline(req, fs.createWriteStream(dest));
      const c = readFontNames(fs.readFileSync(dest));
      if (!c) { fs.unlinkSync(dest); return json(res, 400, { error: '폰트 파일을 읽을 수 없어요' }); }
      fontCache[dest] = c;
      return json(res, 200, { added: c.family, fonts: pubFonts() });
    }
    if (req.method === 'GET' && (m = /^\/userfonts\/(.+)$/.exec(p))) {
      const f = path.join(DIRS.fonts, path.basename(m[1])); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      return serveFile(req, res, f);
    }
    if (req.method === 'GET' && p === '/api/sample') return json(res, 200, await ensureSample());
    if (p === '/api/outdir' && req.method === 'GET') return json(res, 200, { dir: getOutDir() });
    if (p === '/api/pickdir' && req.method === 'POST') { const d = await pickDir(getOutDir()); return json(res, 200, { dir: d }); }
    if (p === '/api/ping') { lastPing = Date.now(); byeAt = 0; return json(res, 200, { ok: true }); }
    if (p === '/api/bye') { byeAt = Date.now(); res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && p === '/api/caps') return json(res, 200, caps);
    if (p === '/api/sfx' && req.method === 'GET') {
      const dir = getSfxDir(); let files = [], exists = false;
      try { exists = fs.statSync(dir).isDirectory(); } catch (e) {}
      if (exists) files = walkAudio(dir, '', 0);
      const own = walkAudio(SFX_OWN, '', 0).map((x) => ({ name: x.name, rel: '@/' + x.rel, own: true }));
      const ownSet = new Set(own.map((x) => x.rel.slice(2)));
      const pending = files.filter((x) => !ownSet.has(x.rel)).length;
      return json(res, 200, { dir, exists, files: [...own, ...files.filter((x) => !ownSet.has(x.rel))], ownDir: SFX_OWN, pending });
    }
    if (p === '/api/sfx/import' && req.method === 'POST') {
      const dir = getSfxDir(); let n = 0, skip = 0;
      for (const f of (dir ? walkAudio(dir, '', 0) : [])) {
        const src = path.join(dir, f.rel), dst = path.join(SFX_OWN, f.rel);
        try { fs.mkdirSync(path.dirname(dst), { recursive: true }); if (fs.existsSync(dst) && fs.statSync(dst).size === fs.statSync(src).size) { skip++; continue; } fs.copyFileSync(src, dst); n++; } catch (e) {}
      }
      return json(res, 200, { copied: n, skipped: skip });
    }
    if (p === '/api/sfx/upload' && req.method === 'POST') {
      const raw = path.basename(u.searchParams.get('name') || 'sound.mp3'); const ext = path.extname(raw).toLowerCase();
      if (!AUDIO_EXT.includes(ext)) { await pipeline(req, fs.createWriteStream(path.join(DIRS.cache, 'discard'))); return json(res, 400, { error: '소리 파일(mp3, wav 등)만 추가할 수 있어요' }); }
      await pipeline(req, fs.createWriteStream(path.join(SFX_OWN, raw))); return json(res, 200, { ok: true, rel: '@/' + raw });
    }
    if (p === '/api/projects' && req.method === 'GET') {
      let l = []; try { l = fs.readdirSync(PROJ_DIR).filter((f) => f.endsWith('.json')).map((f) => { try { const j = JSON.parse(fs.readFileSync(path.join(PROJ_DIR, f), 'utf8')); return { id: j.id, name: j.name, updated: j.updated, clips: ((j.data || {}).clips || []).length }; } catch (e) { return null; } }).filter(Boolean); } catch (e) {}
      return json(res, 200, l.sort((a, b) => b.updated - a.updated));
    }
    if (p === '/api/project/save' && req.method === 'POST') {
      const b = await readBody(req); const id = /^[a-z0-9]{6,16}$/.test(b.id || '') ? b.id : crypto.randomBytes(5).toString('hex');
      const rec = { id, name: String(b.name || '').trim().slice(0, 80) || '이름 없는 프로젝트', updated: Date.now(), data: b.data || {} };
      fs.writeFileSync(path.join(PROJ_DIR, id + '.json'), JSON.stringify(rec)); return json(res, 200, { id, name: rec.name, updated: rec.updated });
    }
    if (p === '/api/project' && (req.method === 'GET' || req.method === 'DELETE')) {
      const id = String(u.searchParams.get('id') || ''); if (!/^[a-z0-9]{6,16}$/.test(id)) return json(res, 400, { error: '잘못된 프로젝트' });
      const f = path.join(PROJ_DIR, id + '.json'); if (!fs.existsSync(f)) return json(res, 404, { error: '프로젝트를 찾을 수 없어요' });
      if (req.method === 'DELETE') { fs.unlinkSync(f); return json(res, 200, { ok: true }); }
      return json(res, 200, JSON.parse(fs.readFileSync(f, 'utf8')));
    }
    if (p === '/api/stickers' && req.method === 'GET') {
      let fl = []; try { fl = fs.readdirSync(STICKER_DIR).filter((f) => STICKER_EXT.includes(path.extname(f).toLowerCase())).sort(); } catch (e) {}
      let bl = []; try { bl = fs.readdirSync(BUILTIN_STK).filter((f) => STICKER_EXT.includes(path.extname(f).toLowerCase())).sort(); } catch (e) {}
      return json(res, 200, fl.map((f) => ({ id: f, name: f.replace(/\.[^.]+$/, ''), gif: /\.gif$/i.test(f) })).concat(bl.filter((f) => !fl.includes(f)).map((f) => ({ id: f, name: f.replace(/\.[^.]+$/, ''), gif: false, builtin: true, name: f.replace(/\.[^.]+$/, '').replace(/^단축키_(.*)$/, '$1 (키보드)').replace(/^텍스트_(.*)$/, '$1 (글자)') }))));
    }
    if (p === '/api/sticker/upload' && req.method === 'POST') {
      const raw = path.basename(u.searchParams.get('name') || 'sticker.png'); const ext = path.extname(raw).toLowerCase();
      if (!STICKER_EXT.includes(ext)) { await pipeline(req, fs.createWriteStream(path.join(DIRS.cache, 'discard'))); return json(res, 400, { error: 'PNG · JPG · GIF · WEBP 이미지만 추가할 수 있어요' }); }
      let nm = raw.replace(/[\\/:*?"<>|]/g, '') || ('sticker' + ext), dest = path.join(STICKER_DIR, nm), i = 1;
      while (fs.existsSync(dest)) { nm = raw.replace(/(\.[^.]+)$/, ` (${i++})$1`); dest = path.join(STICKER_DIR, nm); }
      await pipeline(req, fs.createWriteStream(dest));
      return json(res, 200, { ok: true, id: nm });
    }
    if (p === '/api/sticker/delete' && req.method === 'POST') {
      const f = path.join(STICKER_DIR, path.basename(u.searchParams.get('n') || '')); if (!fs.existsSync(f)) return json(res, 404, { error: '없는 스티커예요' });
      try { fs.unlinkSync(f); } catch (e) { return json(res, 500, { error: '지우지 못했어요' }); }
      return json(res, 200, { ok: true });
    }
    if (p === '/api/sticker/file' && req.method === 'GET') {
      const f = stkPath(u.searchParams.get('n')); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      return serveFile(req, res, f);
    }
    if (p === '/api/help' && req.method === 'GET') {
      let url = String(loadSettings().helpUrl || '').trim();
      if (!url) { try { url = fs.readFileSync(path.join(ROOT, '사용법 링크.txt'), 'utf8').split(/\r?\n/).map((x) => x.trim()).find((x) => /^https?:\/\//i.test(x)) || ''; } catch (e) {} }
      return json(res, 200, { url });
    }
    if (p === '/api/help' && req.method === 'POST') {
      const b = await readBody(req); const v = String(b.url || '').trim(); if (v && !/^https?:\/\//i.test(v)) return json(res, 400, { error: 'http:// 또는 https:// 로 시작하는 주소를 넣어 주세요' });
      const st = loadSettings(); st.helpUrl = v; fs.writeFileSync(SETTINGS, JSON.stringify(st)); return json(res, 200, { ok: true });
    }
    if (p === '/api/sfx/dir' && req.method === 'POST') {
      const b = await readBody(req); const s = loadSettings(); s.sfxDir = String(b.dir || '').trim().replace(/^"|"$/g, ''); fs.writeFileSync(SETTINGS, JSON.stringify(s)); return json(res, 200, { ok: true });
    }
    if (p === '/api/sfx/file' && req.method === 'GET') {
      const f = sfxPath(u.searchParams.get('p')); if (!f) { res.writeHead(404); return res.end(); } return serveFile(req, res, f);
    }
    if (p === '/api/sfx/add' && req.method === 'POST') {
      const b = await readBody(req); const f = sfxPath(b.rel); if (!f) return json(res, 404, { error: '파일을 찾을 수 없어요' });
      const ext = path.extname(f).toLowerCase(), id = crypto.randomBytes(6).toString('hex'), dest = path.join(DIRS.media, id + ext);
      try { fs.copyFileSync(f, dest); const m = await ingest(id, path.basename(f), dest, ext); media[id] = m; saveDB(); return json(res, 200, pub(m)); }
      catch (e) { try { fs.unlinkSync(dest); } catch (e2) {} return json(res, 500, { error: e.message }); }
    }
    if (req.method === 'GET') {
      let f = path.join(ROOT, 'public', p === '/' ? 'index.html' : p);
      if (!f.startsWith(path.join(ROOT, 'public'))) { res.writeHead(403); return res.end(); }
      if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
      res.setHeader('Cache-Control', 'no-cache');
      return serveFile(req, res, f);
    }
    res.writeHead(404); res.end();
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message }); else res.end();
  }
});

const caps = { ass: true };
execFile(FFMPEG, ['-hide_banner', '-filters'], (e, so) => { if (!e) caps.ass = /\bass\b/.test(so); });

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.log('이미 실행 중입니다. 열려 있는 창을 사용하세요.'); openApp(`http://localhost:${PORT}`); setTimeout(() => process.exit(0), 800); }
  else { console.error(e); process.exit(1); }
});
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log('==============================================');
  console.log('  단동샘 편집기 실행 중  →  ' + url);
  console.log('  이 창을 닫으면 프로그램이 종료됩니다.');
  console.log('==============================================');
  openApp(url);
});
