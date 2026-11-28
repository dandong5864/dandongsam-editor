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

// ---- 지킴이: 편집기가 오류로 꺼지면 저절로 다시 켜요 (exe 실행 때만) ----
if (process.env.AUTO_QUIT && !process.env.DDS_CHILD) {
  let starts = [];
  const run = (again) => {
    const env = Object.assign({}, process.env, { DDS_CHILD: '1' });
    if (again) env.NO_OPEN = '1';   // 다시 켤 때는 창을 또 열지 않아요 (열려 있는 창이 저절로 이어져요)
    const c = spawn(process.execPath, process.argv.slice(1), { env, stdio: 'inherit', windowsHide: true });
    c.on('exit', (code) => {
      if (code === 0) return process.exit(0);   // 창을 닫아서 정상으로 끝난 경우
      const now = Date.now(); starts = starts.filter((t) => now - t < 60000); starts.push(now);
      if (starts.length > 5) return process.exit(1);   // 1분에 5번 넘게 꺼지면 멈춰요
      setTimeout(() => run(true), 1000);
    });
  };
  run(false);
  return;
}

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
  if (!fs.existsSync(WS) && fs.existsSync(LEGACY_WS)) { fs.mkdirSync(DATA_ROOT, { recursive: true }); copyDir(LEGACY_WS, WS); }
} catch (e) { console.log('이전 작업 옮기기 실패:', e.message); }
// ---- 사용자가 찾아야 하는 파일(내보낸 영상·캡처·자동 편집 폴더)은 '다운로드\단동샘 편집기' 안에 둬요 (초보도 찾기 쉽게) ----
// 다운로드 폴더를 다른 곳(D 드라이브·원드라이브 등)으로 옮긴 PC도 윈도우가 알고 있는 실제 위치를 찾아요. 한 번 찾으면 기억해 둬요.
function findDownloads() {
  const def = path.join(os.homedir(), 'Downloads');
  if (process.platform !== 'win32') return def;
  try {
    const o = require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding=[Text.Encoding]::UTF8; (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path"], { encoding: 'utf8', windowsHide: true, timeout: 8000 }).trim();
    if (o && path.isAbsolute(o) && fs.existsSync(o)) return o;
  } catch (e) {}
  return def;
}
const writable = (d) => { try { fs.mkdirSync(d, { recursive: true }); const t = path.join(d, '.dds_write_test'); fs.writeFileSync(t, ''); fs.unlinkSync(t); return true; } catch (e) { return false; } };
const hasFiles = (d) => { try { return fs.readdirSync(d).some((n) => !n.startsWith('.')); } catch (e) { return false; } };
// 윈도우 '저장 공간 센스'가 다운로드 폴더의 오래된 파일을 지우게 켜져 있는지 (켜져 있으면 지우는 날짜 수, 아니면 0)
function storageSenseDays() {
  if (process.platform !== 'win32') return 0;
  try {
    const o = require('child_process').execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\StorageSense\\Parameters\\StoragePolicy'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const v = (k) => { const m = new RegExp('^\\s*' + k + '\\s+REG_DWORD\\s+0x([0-9a-f]+)', 'im').exec(o); return m ? parseInt(m[1], 16) : 0; };
    return v('01') ? v('512') : 0;
  } catch (e) { return 0; }
}
function findVideos() {
  const def = path.join(os.homedir(), 'Videos');
  try {
    const o = require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath('MyVideos')"], { encoding: 'utf8', windowsHide: true, timeout: 8000 }).trim();
    if (o && path.isAbsolute(o) && fs.existsSync(o)) return o;
  } catch (e) {}
  return def;
}
const USER_BASE = (() => {
  const sf = path.join(WS, 'settings.json'); let st = {}; try { st = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch (e) {}
  if (st.userBase && fs.existsSync(path.dirname(st.userBase))) return st.userBase;
  let dl = findDownloads(); if (!writable(dl)) dl = os.homedir();
  if (storageSenseDays() > 0) { const vd = findVideos(); if (writable(vd)) dl = vd; }   // 다운로드를 자동으로 비우는 PC면 처음부터 '동영상' 폴더에 둬요
  const b = path.join(dl, '단동샘 편집기'); st.userBase = b;
  try { fs.mkdirSync(WS, { recursive: true }); fs.writeFileSync(sf, JSON.stringify(st)); } catch (e) {}
  return b;
})();
// 예전 버전에서 프로그램 폴더 안에 파일을 만들어 둔 사람은 그 자리를 그대로 써요 (찾던 곳이 갑자기 바뀌지 않게)
const userDir = (name) => { const old = path.join(ROOT, name); return hasFiles(old) && writable(old) ? old : path.join(USER_BASE, name); };
// 이미 다운로드 폴더를 쓰는 PC에서 저장 공간 센스가 켜져 있으면, 편집기를 켤 때마다 파일을 '열어 본 것'으로 표시해서 지워지지 않게 해요
// (저장 공간 센스는 오래 안 연 파일을 지워요. 수정한 날짜는 그대로 둬요)
function keepFresh(list) {
  if (process.platform !== 'win32') return;
  setTimeout(async () => {
    try {
      const dl = findDownloadsCached(), dirs = [...new Set(list().filter((d) => d && inside(d, dl) && path.resolve(d) !== path.resolve(dl)).map((d) => path.resolve(d)))];
      if (!dirs.length || storageSenseDays() <= 0) return;
      const now = new Date(), fp = fs.promises; let n = 0;
      const walk = async (d, depth) => { if (depth > 6 || n > 20000) return; let es; try { es = await fp.readdir(d, { withFileTypes: true }); } catch (e) { return; }
        for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) await walk(f, depth + 1); else if (e.isFile() && n++ < 20000) { try { const st = await fp.stat(f); await fp.utimes(f, now, st.mtime); } catch (x) {} } } };
      for (const d of dirs.filter((d) => !dirs.some((o) => o !== d && inside(d, o)))) await walk(d, 0);
    } catch (e) {}
  }, 15000).unref();
}
const DIRS = {
  media: path.join(WS, 'media'),
  cache: path.join(WS, 'cache'),
  out: userDir('내보내기'),
  cap: userDir('캡처'),
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
  if (m.lite && !fs.existsSync(m.lite)) delete m.lite;
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
// 큰 영상(1080p 넘음, 30프레임 넘음)은 미리보기만 가벼운 사본으로 보여 줘요. 내보내기는 항상 원본으로 해요.
function isHeavy(info) {
  if (!info || !info.hasVideo || info.isImage) return false;
  const w = info.width || 0, h = info.height || 0;
  return Math.max(w, h) > 1920 || Math.min(w, h) > 1080 || (info.fps || 0) > 31;
}
const proxyVf = (info) => "scale='trunc(iw*sar/2)*2':ih,setsar=1,scale='if(gte(iw,ih),-2,min(1080,iw))':'if(gte(iw,ih),min(1080,ih),-2)'" + ((info.fps || 0) > 31 ? ',fps=30' : '');
const proxyArgs = (file, info, out) => ['-y', '-i', file, '-vf', proxyVf(info), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out];
// 가벼운 사본은 뒤에서 하나씩 만들어요 (가져오기는 바로 끝나고, 다 만들어지면 그때부터 사본으로 재생)
let liteQ = Promise.resolve();
function makeLite(id, file, info) {
  liteQ = liteQ.then(async () => {
    if (!fs.existsSync(file)) return;
    const out = path.join(DIRS.cache, id + '.lite.mp4'), tmp = path.join(DIRS.cache, id + '.lite.part.mp4');
    try {
      await run(FFMPEG, proxyArgs(file, info, tmp)); fs.renameSync(tmp, out);
      if (media[id]) { media[id].lite = out; saveDB(); } else fs.unlinkSync(out);
    } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) {} }
  });
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
const hasAlpha = (m) => m && (m.isImage || m.mg) && fs.existsSync(alphaPathOf(m.id));   // 투명 사진, 투명 모션그래픽
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
    const args = info.hasVideo ? proxyArgs(file, info, px) : ['-y', '-i', file, '-vn', '-c:a', 'libmp3lame', '-b:a', '160k', px];
    await run(FFMPEG, args);
    m.preview = px;
  } else if (isHeavy(m)) makeLite(id, file, info);
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
// ---- 작업 백업: 저장할 때마다 이전 상태를 backups/<동영상>/ 에 돌려 가며 보관해요 (편집 정보만, 영상 원본은 아님) ----
const BAK_DIR = path.join(WS, 'backups'); try { fs.mkdirSync(BAK_DIR, { recursive: true }); } catch (e) {}
const AUTO_FILE = path.join(WS, 'autosave.json');   // 저장하지 않은 지금 작업도 여기에 계속 남겨 둬요
function writeSafe(f, text) { const tmp = f + '.tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, f); }   // 쓰다가 꺼져도 파일이 깨지지 않게
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const bakKey = (id) => (/^[a-z0-9]{6,16}$/.test(id || '') ? id : '_auto');
function listBak(id) {
  const d = path.join(BAK_DIR, bakKey(id)); let l = [];
  try { l = fs.readdirSync(d).filter((f) => /^\d+\.json$/.test(f)).map((f) => +f.slice(0, -5)).sort((a, b) => b - a); } catch (e) {}
  return l;
}
// 최근 10개 + 그보다 오래된 건 하루 1개씩 7일치만 남겨요
function pruneBak(id) {
  const d = path.join(BAK_DIR, bakKey(id)), l = listBak(id), keep = new Set(l.slice(0, 10)), days = new Set();
  for (const t of l.slice(10)) { const day = new Date(t).toDateString(); if (Date.now() - t < 7 * 864e5 && !days.has(day)) { days.add(day); keep.add(t); } }
  for (const t of l) if (!keep.has(t)) { try { fs.unlinkSync(path.join(d, t + '.json')); } catch (e) {} }
}
// 바뀌기 전 내용을 백업으로 남겨요 (너무 자주 쌓이지 않게 5분에 한 번까지)
function backupBefore(id, file, force) {
  const old = readJson(file); if (!old || !old.data) return;
  const l = listBak(id); if (!force && l.length && Date.now() - l[0] < 5 * 60 * 1000) return;
  const d = path.join(BAK_DIR, bakKey(id)); try { fs.mkdirSync(d, { recursive: true }); writeSafe(path.join(d, Date.now() + '.json'), JSON.stringify(old)); pruneBak(id); } catch (e) { console.error('백업', e.message); }
}
// ---- 스티커 (이미지 / GIF) ----
// 내가 추가한 스티커·효과음은 프로그램 폴더가 아니라 '단동샘 편집기' 사용자 폴더(내보내기 옆)에 둬요 → 다시 설치하거나 지워도 남아요
const STICKER_DIR = path.join(USER_BASE, '스티커'), STICKER_OLD = path.join(ROOT, '스티커'); const STICKER_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const SFX_OWN = path.join(USER_BASE, '효과음'), SFX_APP = path.join(ROOT, '효과음');   // SFX_APP: 편집기에 들어 있는 효과음 (예전에 추가한 것도 여기 있을 수 있어요)
try { fs.mkdirSync(STICKER_DIR, { recursive: true }); fs.mkdirSync(SFX_OWN, { recursive: true }); } catch (e) {}
(function moveOldUserFiles() {   // 예전 버전이 프로그램 폴더에 저장한 것을 한 번 옮겨요 (스티커는 옮긴 뒤 원래 것을 지우고, 효과음은 복사만)
  const flag = path.join(WS, 'moved-user-files.json'); if (fs.existsSync(flag)) return;
  const cp = (src, dst, rel, del, depth) => { let es = []; try { es = fs.readdirSync(path.join(src, rel), { withFileTypes: true }); } catch (e) { return true; } let ok = true;
    for (const e of es) { const r = path.join(rel, e.name), a = path.join(src, r), b = path.join(dst, r);
      if (e.isDirectory()) { if (depth < 3 && !(depth === 0 && e.name === '기본 효과음')) ok = cp(src, dst, r, del, depth + 1) && ok; continue; }
      if (!e.isFile() || /\.txt$/i.test(e.name)) continue;
      try { fs.mkdirSync(path.dirname(b), { recursive: true }); if (!fs.existsSync(b)) fs.copyFileSync(a, b); if (fs.statSync(b).size !== fs.statSync(a).size) { ok = false; continue; } if (del) try { fs.unlinkSync(a); } catch (x) {} } catch (x) { ok = false; } }
    return ok; };
  const ok = cp(STICKER_OLD, STICKER_DIR, '', true, 3) & cp(SFX_APP, SFX_OWN, '', false, 0);
  if (ok) try { fs.writeFileSync(flag, JSON.stringify({ at: Date.now() })); } catch (e) {}
})();
const BUILTIN_STK = path.join(ROOT, '기본스티커');   // 편집기에 처음부터 들어 있는 스티커(지우거나 바꿀 수 없어요)
const stkPath = (n) => { const b = path.basename(String(n || '')); return [STICKER_DIR, STICKER_OLD, BUILTIN_STK].map((d) => path.join(d, b)).find((f) => fs.existsSync(f)) || path.join(BUILTIN_STK, b); };

// ---- 효과음 폴더 ----
const SETTINGS = path.join(WS, 'settings.json');
const loadSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) { return {}; } };
const getSfxDir = () => { const s = loadSettings(); return s.sfxDir !== undefined ? s.sfxDir : ''; };
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
  if (rel.startsWith('@/')) { rel = rel.slice(2); base = SFX_OWN; const own = path.resolve(SFX_OWN, rel); if (!fs.existsSync(own) && own.startsWith(path.resolve(SFX_OWN) + path.sep)) base = SFX_APP; }   // 내 폴더에 없으면 편집기에 들어 있는 효과음
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

const pub = (m) => ({ id: m.id, name: m.name, duration: m.duration, width: m.width, height: m.height, fps: m.fps, hasVideo: m.hasVideo, hasAudio: m.hasAudio, size: m.size, thumb: !!m.thumb, lite: !!m.lite, liteWait: !m.lite && !m.preview && isHeavy(m), isImage: !!m.isImage, hasAlpha: !!hasAlpha(m), mg: !!m.mg, color: m.color || null, hide: !!m.hide });

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
    const tag = `{\\an5${t.one ? '\\q2' : ''}\\pos(${x.toFixed(1)},${y.toFixed(1)})\\fn${font}${bold}\\fs${size}\\bord${bord.toFixed(1)}\\shad${(2 * k).toFixed(1)}\\3c&H${assColor(t.outlineColor || '#000000')}&\\fad(80,60)}`;
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
    // 테두리·둥근 모서리: 두께는 가로 1080 기준, 둥글기는 짧은 변의 절반 기준 % (미리보기와 같은 계산)
    const bw = t.border ? Math.min(Math.floor(Math.min(pw, ph) / 2) - 2, Math.max(1, Math.round(clamp(+t.bw || 8, 1, 40) * W / 1080))) : 0;
    const R = clamp(+t.br || 0, 0, 100) / 100 * Math.min(pw, ph) / 2, Ri = Math.max(0, R - bw);
    const bcol = /^#[0-9a-f]{6}$/i.test(t.bc || '') ? t.bc.slice(1) : 'ffffff', [cr, cg, cb] = [0, 2, 4].map((i) => parseInt(bcol.slice(i, i + 2), 16));
    const cov = (x0, y0, w, h, r) => `clip(${n(r)}-hypot(max(${n(x0 + r)}-X-0.5,0)+max(X+0.5-${n(x0 + w - r)},0),max(${n(y0 + r)}-Y-0.5,0)+max(Y+0.5-${n(y0 + h - r)},0))+0.5,0,1)`;
    let shape = bw > 0 ? `,scale=${pw - 2 * bw}:${ph - 2 * bw},format=rgba,pad=${pw}:${ph}:${bw}:${bw}:color=0x${bcol}FF` : `,scale=${pw}:${ph},format=rgba`;
    if (R >= 1) {
      const out = cov(0, 0, pw, ph, R), inn = bw > 0 && Ri >= 1 ? cov(bw, bw, pw - 2 * bw, ph - 2 * bw, Ri) : '1';
      shape += inn === '1' ? `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${out}'`
        : `,geq=r='r(X,Y)*${inn}+${cr}*(1-${inn})':g='g(X,Y)*${inn}+${cg}*(1-${inn})':b='b(X,Y)*${inn}+${cb}*(1-${inn})':a='(alpha(X,Y)*${inn}+255*(1-${inn}))*${out}'`;
    }
    filt.push(`[${idx}:v:0]fps=${FPS}${shape}${op < 0.999 ? `,colorchannelmixer=aa=${n(op)}` : ''},setpts=PTS-STARTPTS+${n(st)}/TB[pp${k}]`);
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
  const bgs = aOnly ? [] : (b.texts || []).filter((t) => t.kind === 'bg');
  const doBg = (t, k) => {   // 단계가 바뀔 때 깔리는 색 화면
    const st = Math.max(0, +t.start || 0), en = Math.max(st + 0.05, +t.end || 0), op = clamp((t.opacity == null ? 100 : +t.opacity) / 100, 0, 1);
    filt.push(`${vLabel}drawbox=x=0:y=0:w=${W}:h=${H}:color=${hex(t.color, '0x1f6feb')}@${n(op)}:t=fill:enable='between(t,${n(st)},${n(en)})'[bgb${k}]`);
    vLabel = `[bgb${k}]`;
  };
  const zOf = (t) => ({ bg: -1, pip: 0, sticker: 1, shape: 1, text: 2, sub: 3 }[t.kind] ?? 1) * 1000 + (+t.lane || 0);
  const ops = [];   // 레이어 순서(z)대로 아래에서 위로 쌓아요
  if (!aOnly) { bgs.forEach((t, k) => ops.push({ z: zOf(t), o: 0, f: () => doBg(t, k) })); pips.forEach((t, k) => ops.push({ z: zOf(t), o: 0, f: () => doPip(t, k) })); stks.forEach((t, k) => ops.push({ z: zOf(t), o: 1, f: () => doStk(t, k) })); shapes.forEach((t, k) => ops.push({ z: zOf(t), o: 1, f: () => doShape(t, k) })); texts.forEach((t) => ops.push({ z: zOf(t), o: t.kind === 'sub' ? 3 : 2, txt: t })); }
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
    // 자막에 실제로 쓴 글꼴만 복사해요 (모두 복사하면 내보내기 시작이 느려요). 모르는 글꼴 이름이 있으면 예전처럼 모두 복사해요.
    const used = new Set([...g.ass.join('\n').matchAll(/\\fn([^\\}]+)/g)].map((m) => m[1])), fl = listFonts();
    const known = (nm) => fl.some((f) => f.family === nm || f.base === nm), all = [...used].some((nm) => !known(nm));
    fl.forEach((f) => { if (!all && !used.has(f.family) && !used.has(f.base)) return; try { fs.copyFileSync(f.path, path.join(dir, 'fonts', f.file)); } catch (e) {} });
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
  p.on('error', (e) => { job.status = 'error'; job.error = 'ffmpeg를 실행할 수 없습니다: ' + e.message; console.error('내보내기', job.error); });
  p.on('close', (code) => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    (g.tmpFiles || []).forEach((f) => { try { fs.unlinkSync(f); } catch (e) {} });
    if (job.status === 'canceled') { try { fs.unlinkSync(out); } catch (e) {} return; }
    if (code === 0) { job.status = 'done'; job.progress = 1; }
    else if (job.status !== 'error') { job.status = 'error'; job.error = job.log.split('\n').filter(Boolean).slice(-4).join('\n') || ('종료 코드 ' + code); console.error('내보내기 실패', job.error); }
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
const AUTO_OLD = path.join(os.homedir(), 'Documents', '단동샘 자동편집');   // 예전 기본 위치 (이미 쓰던 사람은 그대로)
const AUTO_DEFAULT = hasFiles(AUTO_OLD) ? AUTO_OLD : path.join(USER_BASE, '자동편집');
function autoCfg() { let c = {}; try { c = JSON.parse(fs.readFileSync(AUTO_CFG, 'utf8')); } catch (e) {} return { root: c.root || AUTO_DEFAULT, extra: Array.isArray(c.extra) ? c.extra : [] }; }
function autoSave(c) { try { fs.writeFileSync(AUTO_CFG, JSON.stringify(c)); } catch (e) {} }
const inside = (p, root) => { const r = path.resolve(root), q = path.resolve(p); return q === r || q.startsWith(r + path.sep); };
// 지우면 안 되는 중요한 폴더들: 저장 위치(root)가 이 폴더이거나 이 폴더를 품고 있으면 안 되고, 작업 폴더로 지울 수도 없어요
function keepDirs() {
  const h = os.homedir(), l = [h, ROOT, DATA_ROOT, USER_BASE, getOutDir(), findDownloadsCached(), ...['Downloads', 'Desktop', 'Documents', 'Pictures', 'Videos', 'Music', 'OneDrive', '바탕 화면', '문서', '다운로드'].map((n) => path.join(h, n))];
  return l.filter(Boolean).map((d) => path.resolve(d));
}
let dlCache = null; const findDownloadsCached = () => dlCache || (dlCache = findDownloads());
const tooBroad = (dir) => keepDirs().some((k) => inside(k, dir));   // dir 이 중요한 폴더 자신이거나 그 위 폴더
const looksLikeJob = (dir) => ['결과', '편집파일_만드는법.txt', '단동샘스킬'].some((n) => fs.existsSync(path.join(dir, n)));   // 편집기가 만든 작업 폴더 표시
function autoAllowed(p) { const c = autoCfg(); return inside(p, c.root) || c.extra.some((e) => inside(p, e)); }
const MEDIA_EXT = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.png', '.jpg', '.jpeg', '.gif', '.webp'];
const DSP_GUIDE = `단동샘 편집기 프로젝트 파일(.dsp) 만드는 법
=====================================
이 폴더의 영상·소스를 편집한 뒤, 편집 내용을 "결과" 폴더에 .dsp 파일로 저장해 주세요.
.dsp 는 UTF-8 JSON 텍스트 파일입니다. 영상 자체는 넣지 않고 "어느 영상의 몇 초~몇 초를 쓰는지"만 적습니다.
영상 파일은 이 폴더에 그대로 두세요. 사용자가 편집기에서 열면 같은 이름의 파일을 자동으로 찾아 연결합니다.
※ 원본 영상은 이름도 내용도 바꾸지 말고, 편집기가 회전·픽셀 비율·화면 비율을 알아서 맞추니 비율 보정용 복사본은 만들지 마세요.
※ 아래 예시의 // 뒤는 설명이에요. 실제 .dsp 에는 설명을 넣지 말고 순수 JSON 만 쓰세요. 시간은 모두 초 단위 숫자(예: 12.5)로 쓰세요.

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
  - 쓸 수 있는 글꼴: Cafe24 Ssurround, Cafe24 Dangdanghae, Cafe24 Danjunghae, Cafe24 Dongdong, Cafe24 Ohsquare, Cafe24 Syongsyong, Cafe24 Supermagic OTF Bold, Kyobo Handwriting 2019, Ownglyph PDH Regular, omyu pretty, AndongKaturi, Ownglyph yuntaeng Regular, insungit Cutelively jisu, KCC-Chassam, Single Day, NanumMyeongjo, NanumMyeongjo Bold, NanumMyeongjo ExtraBold, Black Han Sans, Do Hyeon

[편집설정.json]  (이 폴더에 있으면 꼭 읽고 그대로 따르세요)
- canvas : 영상 모양. .dsp 의 data.canvas 에 그대로 쓰세요 ("9:16" 세로 쇼츠 / "16:9" 가로 유튜브).
- portrait : 가로(16:9)로 만들 때 세로로 찍은 영상(보이는 크기가 세로인 영상)을 어떻게 할지. "rot90"(기본) = 그 영상 조각의 rot 를 90 으로, "rot270" = rot 를 270 으로 (가로 화면에 꽉 차게 돌림, fit 은 "contain"), "keep" = 돌리지 않음. 영상을 자르거나 흐리게 채우지 마세요. 이미 가로인 영상은 건드리지 마세요.
- tpl : 쇼츠 색 띠 템플릿 값. null 이 아니면 data.tpl 에 그대로 복사하세요 (null 이면 data.tpl 도 null).
  tpl.fitMid 도 그대로 복사: false = 영상이 위·아래 띠 뒤까지 전체 화면에 맞춰짐, true = 위·아래 띠 사이 가운데 칸 안에서만 보임. 임의로 바꾸지 마세요.
- title : 쇼츠 제목 글자 스타일. null 이 아니면 영상 내용에 맞는 제목을 2줄(줄바꿈 \\n)로 지어서 texts 에 kind "text" 로 넣고, 이 스타일 값(font,size,color,colors,outline,x,y 등)을 그대로 쓰세요. 영상 처음부터 끝까지 보이게 start 0, end 전체 길이.
- lecture : true 이면 강의(실습) 영상이에요. 아래 [강의·화면 녹화용 효과]의 화살표·네모·클릭 표시·체크·확대를 필요한 곳마다 꼭 넣으세요. "하단 자막만"은 제목 글자·색 띠를 빼라는 뜻이고 화면 강조를 빼라는 뜻이 아닙니다. 위치를 확신할 수 없는 곳에는 넣지 마세요. 화면 이미지는 토큰을 많이 쓰니 "누르세요·클릭·선택" 같은 말이 나온 시각에서만 640px 이하로 줄여 보고(여러 장은 한 장에 모아서) 영상 한 편에 전체 20장을 넘기지 마세요. false 이거나 없으면 자막과 컷 편집만 하세요.
- genre : 만들 영상 종류. "tips"(생활 꿀팁) "docu"(다큐 쇼핑) "product"(상품 소개) "aigen"(AI 생성 영상) "overseas"(해외 영상 요약) "lecture"(강의). 폴더 안 "단동샘스킬/장르/" 의 그 장르 파일을 읽고 따르세요. null 이면 컷 편집과 자막만.
- mode : 진행 방식. "auto"(끝까지) "step"(기획·대본·컷 계획마다 확인받기) "text"(.dsp 없이 글만: 결과/대본.txt, AI 생성 영상이면 결과/프롬프트.txt).
- voice : AI 목소리. null 이 아니면 {"name": "ko-KR-SunHiNeural"(여자) 또는 "ko-KR-InJoonNeural"(남자), "rate": "+10%"(빠르기)}. 대본을 한 줄에 한 문장씩 결과/대본.txt 로 저장하고, 단동샘스킬/scripts/narrate.py 로 이 폴더에 "내레이션.mp3"를 만들어 audio 에 넣으세요(영상 조각은 소리 끄기). 파이썬이나 인터넷이 안 되면 대본만 주고 알려 주세요. null 이면 사용자가 녹음한 내레이션만 씁니다.
- subSplit : "fast" 이면 빠른 자막(무조건 한 줄, 조사·어미 뒤에서 1~2어절씩, 공백 포함 8자 이내, 한 컷 0.5~1초), "slow" 이면 느린 자막(무조건 한 줄, 연결어미·종결어미 기준의 구·짧은 절, 공백 포함 8~13자·최대 14자, 한 컷 2초 이상). 꾸미는 말("따뜻한")과 조사 없는 말("아침", "물 한")은 뒤 말과 붙이세요. 이때 자막 항목마다 "one": true 를 넣으세요(한 줄 고정). null 이면 평소대로.
- subtitle : 자막 스타일(사용자가 편집기에서 저장한 롱폼·강의·숏폼 스타일). 모든 자막(kind "sub") 항목에 이 값(font,size,color,outline,outlineColor,x,y 와 글자 배경 box,boxColor,boxOpacity 등 들어 있는 키 전부)을 한 글자도 바꾸지 말고 그대로 쓰세요. 기본값으로 덮어쓰거나 직접 고르지 마세요.

[강의·화면 녹화용 효과 (필요할 때만 texts 에 추가)]
- 부드러운 확대: {id, kind:"zoom", start, end, scale:150(110~400), ease:0.5, x, y(확대 중심, 화면 % 0~100), text:""}. 클릭·작은 글씨를 크게 보여 줄 때. 시작과 끝에서 부드럽게 커졌다 돌아와요. 서로 겹치지 않게.
- 도형: kind "shape", shape 는 "arrow"(화살표) "check"(✔) "cross"(✖) "checkbox"(☑) "pointer"(마우스 포인터) "click"(클릭 표시 원) "rect" "ellipse". x,y(중심 %), w,h(% 너비 기준), rot, fill:true, fillColor, stroke, strokeColor, strokeW, opacity, start, end, text:"".
- 포인터 이동: pointer 도형에 mv:true, x2,y2(도착 %), mvDur(이동 초). 도착 순간에 같은 자리에 "click" 도형을 0.4초쯤 추가하면 클릭처럼 보여요.

- motion : 모션그래픽. null 이면 넣지 마세요(일반 자동 편집). 값이 있으면 폴더 안 "모션그래픽스킬/SKILL.md"를 읽고 따르세요.
  {"mode": "mix"(촬영 영상 + 필요한 곳만 모션그래픽) | "only"(모션그래픽만으로 영상 전체) | "multi"(실사·AI 영상·사진·모션그래픽 섞기: 폴더에 있는 파일만),
   "style": "auto"(내용 보고 고르기) 또는 아래 스타일 이름, "amount": "low"(1분에 1~2개) | "mid"(2~3개) | "high"(4~5개)}

[모션그래픽] (편집설정.json 의 motion 이 있을 때, 또는 사용자가 모션그래픽을 넣어 달라고 할 때)
모션그래픽은 영상 파일을 직접 만들지 말고 "설계도"(mg)만 적으세요. 편집기가 열 때 그 설계도로 영상을 그려 "추가 미디어" 줄에 올리고, 결과/모션그래픽/ 폴더에도 저장해요.
- 촬영 영상 위에 덮기(내레이션은 계속 이어짐): texts 에 {"id":"g1","kind":"mg","start":12.0,"end":16.5,"mg":{ ...설계도... }}
- 모션그래픽만으로 된 장면(영상 줄에 차례로): clips 에 {"id":"c5","mg":{ ...설계도... },"dur":4.5}  (mediaId·in·out 은 쓰지 않아요. 소리는 audio 의 내레이션으로)
- 설계도 모양 (type 하나를 고르세요. 화면 글자는 짧게, 강조할 말은 [ ] 로 감싸요):
  {"type":"steps","title":"김치찌개 끓이는 순서","items":["고기 먼저 [달달] 볶기","김치 넣고 5분","물 붓고 20분"]}      순서 (2~5개)
  {"type":"number","title":"한 달 전기요금","value":"37%","label":"평균 [절약]"}                                      숫자 하나 (0부터 세어 올라감)
  {"type":"compare","title":"일반 vs 실리콘 수세미","left":{"label":"일반","value":"2주","text":"세균 번식"},"right":{"label":"실리콘","value":"6개월","text":"[오래] 써요"},"win":"right"}   비교
  {"type":"flow","title":"챗GPT가 답을 만드는 법","items":["질문을 조각으로","다음 말 예측","한 글자씩 이어 쓰기"]}   작동 원리 (2~5개)
  {"type":"quote","label":"핵심","text":"물은 목마르기 전에 [하루 2리터]"}                                              핵심 문장
  {"type":"list","title":"여행 전 챙길 것","items":["여권","상비약","충전기"]}                                          체크리스트 (2~6개)
  공통 선택 값: "style" (아래 6개 중 하나), "at":[0.6,1.8,3.0] (항목이 나오는 시각, 그 모션그래픽 시작부터 초 — 말하는 순간에 맞추면 좋아요), "clear":true (바탕 없이 영상 위에 투명하게)
- style: "howto"(단계별 따라하기·밝음) "lineicon"(라인 아이콘·검정+연두) "newsshorts"(뉴스 카드·검정+노랑) "pptpen"(인강 PPT 첨삭·흰 슬라이드+빨간 펜) "cardnews"(카드뉴스·연보라 파스텔) "broadcast"(방송 뉴스 그래픽·남색)
  편집설정.json 의 motion.style 이 "auto" 가 아니면 모든 모션그래픽에 그 스타일을 쓰세요. "auto" 면 영상 전체에서 1~2개만 골라 통일하세요.
- 직접 그린 HTML (Codex·Claude Code 처럼 파일을 만들 수 있을 때만): "결과/모션그래픽/장면1.html" 에 <canvas id="c"> 와 window.draw(t)(t=초, 같은 t 면 같은 그림), window.DUR 을 두고 {"mg":{"html":"모션그래픽/장면1.html"}} 로 적어요. 화면 크기는 window.W, window.H 로 알 수 있어요. 인터넷(글꼴·그림·주소)은 막혀 있으니 쓰지 말고, 글꼴은 "Black Han Sans"(제목) "Do Hyeon"(본문)을 쓰세요.
- 규칙: 같은 모양을 연달아 쓰지 말고, 같은 내용을 두 번 보여 주지 마세요. 한 모션그래픽은 3~8초. 자막·제목과 겹쳐도 되지만(화면 아래 22%는 비워 둬요) 화면을 따라 해야 하는 장면(클릭·결과 화면)은 덮지 마세요. 지어낸 숫자·통계는 쓰지 말고 예시 숫자면 [예시]라고 적으세요.

[받아적기 폴더] (있으면 꼭 쓰세요)
- 편집기의 "🎤 받아 적기"로 만든 파일이에요: 받아적기/<영상 파일 이름>.words.json (예: 받아적기/영상1.mp4.words.json)
- 모양: { "file": "영상1.mp4", "duration": 62.4, "segments": [ { "start": 0.5, "end": 3.1, "text": "안녕하세요 오늘은", "words": [ { "w": " 안녕하세요", "s": 0.5, "e": 1.2 }, ... ] } ] }
  시각(초)은 그 영상 파일 기준이에요. 음성 인식을 따로 하지 말고 이 시각을 그대로 쓰세요.
- 컷 편집: 단어 사이가 3초 이상 비는 곳, 군말, 같은 말을 되풀이한 앞부분은 잘라 내고, 말하는 구간만 clips 의 in/out 으로 여러 조각으로 나눠 이어 붙이세요. 자를 때 앞뒤로 0.15초쯤 여유를 두세요. (영상 하나를 통째로 한 조각만 넣지 마세요)
- 자막: 남긴 조각 안의 단어만, 완성 영상 시각(조각 시작 시각 + (단어 시각 - in) ÷ speed)으로 바꿔 texts 에 넣으세요.
- 파일 이름(media 의 name)은 경로 없이 영상 파일 이름만 그대로 쓰세요 (예: "/mnt/data/영상1.mp4" 가 아니라 "영상1.mp4").

[규칙]
- 사용자가 "승인 후 진행"을 말하지 않았다면 중간에 멈추지 말고 끝까지 만들어 주세요.
- 받아적기 폴더가 없고 음성 인식(Whisper 등)도 안 되면 추측해서 쓰지 말고, 결과에 "자막 못 만듦"이라고 적은 뒤 사용자에게 알려 주세요 (편집기의 "목소리로 자막 만들기"로 만들 수 있어요).
- 모든 id 는 서로 달라야 합니다.
- in < out, start < end. 모든 mediaId 는 media 에 있어야 합니다.
- "결과" 폴더에 만든 .dsp 파일 이름은 한글이어도 됩니다 (예: 내영상_편집.dsp).
`;
const SKILL_SRC = path.join(ROOT, '스킬', 'dandongsam-shorts-codex');
const MOTION_SRC = path.join(ROOT, '스킬', 'dandongsam-motion');   // 모션그래픽 스킬 (따로 실행 가능, 작업 폴더의 모션그래픽스킬/ 로 복사)   // 편집기에 들어 있는 AI용 스킬(작업 폴더에 복사해 줘요)
// 폴더 복사는 한 파일씩 직접 해요 (윈도우에서 한글 경로를 한꺼번에 복사하면 편집기가 통째로 꺼지는 경우가 있어요)
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '__pycache__' || e.name.endsWith('.pyc')) continue;   // 파이썬 임시 파일은 작업 폴더에 복사하지 않아요
    const a = path.join(src, e.name), b = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else if (e.isFile()) { try { const sa = fs.statSync(a), sb = fs.statSync(b); if (sa.size === sb.size && sb.mtimeMs >= sa.mtimeMs) continue; } catch (er) {} try { fs.copyFileSync(a, b); } catch (er) {} }
  }
}
const skillDone = new Set();
// 스킬의 파이썬 도구가 ffmpeg 를 따로 설치하지 않아도 되게, 편집기 안의 ffmpeg/ffprobe 위치를 스킬 폴더에 적어 둬요
function putTools(sd) {
  const t = {}; [['ffmpeg', FFMPEG], ['ffprobe', FFPROBE]].forEach(([k, v]) => { if (path.isAbsolute(v) && fs.existsSync(v)) t[k] = v; });
  if (!Object.keys(t).length) return; const f = path.join(sd, '도구위치.json'), txt = JSON.stringify(t, null, 1);
  try { if (fs.readFileSync(f, 'utf8') === txt) return; } catch (e) {} try { fs.writeFileSync(f, txt, 'utf8'); } catch (e) {}
}
const SKILL_NAMES = ['단동샘스킬', '모션그래픽스킬'];
const skillOffFile = (dir) => path.join(dir, '.지운스킬.json');   // 예전에 지운 스킬 기록 (이제는 지우는 버튼이 없어서 보이면 치우고 늘 다시 넣어요)
function putSkill(dir) { if (skillDone.has(dir) && SKILL_NAMES.every((n) => fs.existsSync(path.join(dir, n, 'SKILL.md')))) return; try { try { fs.unlinkSync(skillOffFile(dir)); } catch (e) {} if (fs.existsSync(SKILL_SRC)) { const sd = path.join(dir, '단동샘스킬'); copyDir(SKILL_SRC, sd); putTools(sd); } if (fs.existsSync(MOTION_SRC)) { const md = path.join(dir, '모션그래픽스킬'); copyDir(MOTION_SRC, md); putTools(md); } skillDone.add(dir); } catch (e) { console.warn('스킬 복사 실패:', e.message); } }   // 스킬은 작업 폴더에 늘 자동으로 넣어 둬요 (사용자가 따로 관리하지 않아요)
function prepareJob(dir) {
  fs.mkdirSync(path.join(dir, '결과'), { recursive: true });
  fs.writeFileSync(path.join(dir, '편집파일_만드는법.txt'), DSP_GUIDE, 'utf8');
  putSkill(dir);
}
// AI(특히 ChatGPT)가 준 .dsp 는 설명 주석(//)·코드 블록(```)·끝 쉼표가 섞여 있는 경우가 많아요 → 최대한 고쳐서 읽어요
function parseDsp(txt) {
  let t = String(txt || '').replace(/^\uFEFF/, '').trim();
  try { return JSON.parse(t); } catch (e) {}
  const fence = t.match(/```(?:json|dsp)?\s*([\s\S]*?)```/i); if (fence) t = fence[1].trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a >= 0 && b > a) t = t.slice(a, b + 1);
  let o = '', q = false;   // 문자열 밖의 // 주석과 /* */ 주석을 지워요
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { o += c; if (c === '\\') { o += t[i + 1] || ''; i++; } else if (c === '"') q = false; continue; }
    if (c === '"') { q = true; o += c; continue; }
    if (c === '/' && t[i + 1] === '/') { while (i < t.length && t[i] !== '\n') i++; o += '\n'; continue; }
    if (c === '/' && t[i + 1] === '*') { const e = t.indexOf('*/', i + 2); i = e < 0 ? t.length : e + 1; continue; }
    o += c;
  }
  o = o.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(o);
}
// AI가 시각을 "00:12.5", "1:02:03", "12.5s" 처럼 글자로 적었으면 초(숫자)로 바꿔요
function secOf(v) {
  if (typeof v === 'number') return v; if (typeof v !== 'string') return v; const s = v.trim().replace(/,/g, '.').replace(/\s*(s|sec|초)$/i, '');
  if (/^-?\d+(\.\d+)?$/.test(s)) return +s;
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/); if (m) return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]);
  return v;
}
// AI 결과를 편집기가 알아듣는 모양으로 맞춰요: 경로가 붙은 파일 이름("/mnt/data/영상.mp4") → 이름만, 글자 시각 → 초, in/out 대신 start/end 로 적은 영상 조각
function tidyAiDsp(data) {
  const base = (x) => String(x).split(/[\\/]/).pop();
  let mm = data.media; if (mm && typeof mm === 'object') (Array.isArray(mm) ? mm.map((m, i) => [i, m]) : Object.entries(mm)).forEach(([k, m]) => { if (typeof m === 'string') mm[k] = base(m); else if (m) { if (m.name) m.name = base(m.name); if (m.file) m.file = base(m.file); } });
  else data.media = mm = {};
  const T = ['in', 'out', 'start', 'end', 'mvDur'];
  const clips = Array.isArray(data.clips) ? data.clips : [], audio = Array.isArray(data.audio) ? data.audio : [];
  [...clips, ...audio, ...(Array.isArray(data.texts) ? data.texts : [])].forEach((c) => { if (!c || typeof c !== 'object') return; T.forEach((k) => { if (k in c) c[k] = secOf(c[k]); }); ['name', 'file'].forEach((k) => { if (typeof c[k] === 'string') c[k] = base(c[k]); }); });
  clips.forEach((c) => { if (c && c.in === undefined && c.out === undefined && c.start !== undefined && c.end !== undefined) { c.in = c.start; c.out = c.end; delete c.start; delete c.end; } });
  if (!Array.isArray(mm)) {   // mediaId 가 media 에 없을 때: 파일 이름이면 media 에 넣고, 영상이 하나뿐이면 그것으로 이어요
    const keys = Object.keys(mm), nameOf = (k) => { const m = mm[k]; return typeof m === 'string' ? m : (m && (m.name || m.file)) || ''; };
    const vids = keys.filter((k) => !isAud(nameOf(k))), auds = keys.filter((k) => isAud(nameOf(k)));
    const fix = (c, pool) => { if (!c || c.mediaId === undefined || c.mediaId === null || keys.includes(String(c.mediaId))) return;
      const id = String(c.mediaId); if (MED_RE.test(id)) { const nm = base(id), k = keys.find((q) => nameOf(q).normalize('NFC') === nm.normalize('NFC')); if (k) c.mediaId = k; else { mm[nm] = { name: nm }; keys.push(nm); c.mediaId = nm; } return; }
      if (pool.length === 1) c.mediaId = pool[0]; };
    clips.forEach((c) => fix(c, vids)); audio.forEach((c) => fix(c, auds));
  }
  return data;
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
  try { fs.readdirSync(c.root, { withFileTypes: true }).forEach((e) => { if (e.isDirectory() && e.name !== '결과' && e.name !== AUTO_STT_DIR && !SKILL_NAMES.includes(e.name) && !e.name.startsWith('.')) { const j = jobInfo(path.join(c.root, e.name), 'root'); if (j) jobs.push(j); } }); } catch (e) {}
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
    if (process.platform === 'win32') { cmd = 'powershell.exe'; args = ['-NoProfile', '-STA', '-Command', "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.Form; $f.TopMost=$true; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.InitialDirectory=$env:DSP_INIT; $d.Title='받은 결과(.dsp) 파일을 고르세요'; $d.Filter='단동샘 프로젝트 (*.dsp;*.json;*.txt)|*.dsp;*.json;*.txt|모든 파일 (*.*)|*.*'; if($d.ShowDialog($f) -eq 'OK'){ $d.FileName }"]; }
    else if (process.platform === 'darwin') { cmd = 'osascript'; args = ['-e', 'POSIX path of (choose file with prompt "받은 결과(.dsp) 파일을 고르세요" default location (POSIX file (system attribute "DSP_INIT")))']; }
    else return resolve(null);
    let out = ''; const ch = spawn(cmd, args, { windowsHide: true, env }); ch.stdout.on('data', (d) => { out += d; }); ch.on('error', () => resolve(null)); ch.on('close', () => resolve(out.trim().replace(/[\r\n]+$/, '')));
  });
}
function openFolder(dir) {
  try { if (!fs.statSync(dir).isDirectory()) return; } catch (e) { return; }   // 폴더만 열어요 (파일이면 실행돼 버려요)
  if (process.platform === 'win32') spawn('explorer', [dir], { detached: true, stdio: 'ignore' }).unref();
  else if (process.platform === 'darwin') spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
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
      const ch = []; r.on('data', (d) => ch.push(d)); r.on('end', () => resolve(Buffer.concat(ch).toString('utf8'))); r.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); }); req.on('error', reject);
  });
}
// ---- 업데이트 도우미 ----
// ---- 오류 보내기: 최근 기록을 모아 두었다가, 사용자가 동의하면 구글 설문지로 보내요 ----
const LOG_RING = [];
const ringPush = (lvl, args) => { try { const t = new Date().toTimeString().slice(0, 8); LOG_RING.push(t + ' ' + lvl + ' ' + args.map((a) => a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a)).join(' ').slice(0, 600)); if (LOG_RING.length > 40) LOG_RING.shift(); } catch (e) {} };
for (const lvl of ['error', 'warn']) { const orig = console[lvl].bind(console); console[lvl] = (...a) => { ringPush(lvl.toUpperCase(), a); orig(...a); }; }
const CRASH_LOG = path.join(WS, 'last-crash.log');
try { const t = fs.readFileSync(CRASH_LOG, 'utf8'); t.split('\n').filter(Boolean).slice(-15).forEach((l) => LOG_RING.push('(지난번 실행) ' + l.slice(0, 600))); fs.unlinkSync(CRASH_LOG); } catch (e) {}
process.on('uncaughtException', (e) => {   // 갑자기 꺼질 때 남긴 기록은 다음에 켤 때 오류 보내기에 같이 담겨요
  try { fs.writeFileSync(CRASH_LOG, LOG_RING.concat(new Date().toTimeString().slice(0, 8) + ' CRASH ' + String(e && e.stack || e).slice(0, 1500)).join('\n')); } catch (e2) {}
  try { process.stderr.write(String(e && e.stack || e) + '\n'); } catch (e2) {}
  ringPush('CRASH', [e]);   // 한 가지 작업이 잘못돼도 편집기는 꺼지지 않고 계속 켜져 있어요
});
process.on('unhandledRejection', (e) => ringPush('REJECT', [e]));
// 개인 정보 가리기: 사용자 이름·집 폴더 경로
function maskPrivate(t) {
  let s = String(t || '');
  try { const h = os.homedir(); if (h) s = s.split(h).join('~').split(h.replace(/\\/g, '/')).join('~'); } catch (e) {}
  try { const u = os.userInfo().username; if (u && u.length > 1) s = s.split(u).join('<사용자>'); } catch (e) {}
  return s.replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"']+/gi, '$1<사용자>').replace(/\/(home|Users)\/[^/\s"']+/g, '/$1/<사용자>').replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<이메일>');
}
const REPORT_URL = 'https://raw.githubusercontent.com/dandong5864/dandongsam-editor/main/public/report.json';
async function reportForm() {
  let cfg = null;
  try { cfg = JSON.parse(await httpGet(REPORT_URL)); } catch (e) {}
  if (!cfg) { try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'report.json'), 'utf8')); } catch (e) { cfg = {}; } }
  return { form: /^https:\/\/docs\.google\.com\/forms\//.test(cfg.form || '') && /XXX/.test(cfg.form) ? cfg.form : '' };
}
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
    v = { current: APP_VER, latest, newer: !!(a && latest && verNewer(latest, APP_VER)), url: a ? a.browser_download_url : '', size: a ? a.size : 0, sha256: a && /^sha256:[0-9a-f]{64}$/i.test(a.digest || '') ? a.digest.slice(7).toLowerCase() : '' };
  }
  updCache = { t: Date.now(), v }; return v;
}
function updDownload(url, dest, size, onProg, redirects = 6) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 DandongsamEditor' }, timeout: 30000 }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects > 0) { r.resume(); return resolve(updDownload(new URL(r.headers.location, url).href, dest, size, onProg, redirects - 1)); }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      const total = +r.headers['content-length'] || size || 0; let got = 0; const out = fs.createWriteStream(dest), hash = crypto.createHash('sha256');
      r.on('data', (d) => { got += d.length; hash.update(d); if (total) onProg(Math.min(99, Math.round(got / total * 100))); });
      r.pipe(out); out.on('finish', () => out.close(() => resolve({ got, sha256: hash.digest('hex') }))); out.on('error', reject); r.on('error', reject);
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
    const dest = path.join(os.tmpdir(), `DandongsamEditor-Setup-${crypto.randomBytes(4).toString('hex')}.exe`);   // 매번 다른 이름으로 받아요 (다른 프로그램이 미리 바꿔 치기 못 하게)
    const { got: n, sha256 } = await updDownload(i.url, dest, i.size, (pc) => { upd.pct = pc; });
    if (i.sha256 && sha256 !== i.sha256) { try { fs.unlinkSync(dest); } catch (e) {} throw new Error('내려받은 파일의 지문이 맞지 않아요'); }   // 깃허브가 알려 준 지문(sha256)과 같은지 확인
    const hd = Buffer.alloc(2); const fd = fs.openSync(dest, 'r'); fs.readSync(fd, hd, 0, 2, 0); fs.closeSync(fd);
    if (hd.toString('latin1') !== 'MZ' || (i.size && n !== i.size)) throw new Error('내려받은 파일이 올바르지 않아요');
    upd.file = dest; upd.state = 'ready'; upd.pct = 100;
  } catch (e) { upd.state = 'error'; upd.err = '내려받지 못했어요 (' + (e.message || e) + ')'; console.error('업데이트', upd.err); }
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

// ---- 홈 화면 "자동 편집 예시" 영상 목록 ----
// 목록은 public/examples.json 하나만 고치면 돼요. 깃허브 main에 올리면 이미 설치한 편집기에도 10분 안에 반영돼요.
const EX_URL = 'https://raw.githubusercontent.com/dandong5864/dandongsam-editor/main/public/examples.json';
const ytId = (u) => { const m = /(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/.exec(String(u || '')); return m ? m[1] : (/^[\w-]{11}$/.test(String(u || '').trim()) ? String(u).trim() : ''); };
async function ytTitle(id) { try { return JSON.parse(await httpGet('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id))).title || ''; } catch (e) { return ''; } }
// 구글 시트 주소(공유 링크든 "웹에 게시" 링크든)를 CSV 주소로 바꿔요
function sheetCsvUrl(u) {
  u = String(u).trim(); if (/output=csv|format=csv/.test(u)) return u;
  const pub = /\/spreadsheets\/d\/e\/([\w-]+)/.exec(u); const gid = (/[#&?]gid=(\d+)/.exec(u) || [])[1];
  if (pub) return `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?output=csv` + (gid ? '&gid=' + gid : '');
  const id = /\/spreadsheets\/d\/([\w-]+)/.exec(u); if (id) return `https://docs.google.com/spreadsheets/d/${id[1]}/export?format=csv` + (gid ? '&gid=' + gid : '');
  return u;
}
function parseCsv(t) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) { const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; } else cur += c; }
  if (cur || row.length) { row.push(cur); rows.push(row); } return rows;
}
// ---- 홈 화면 유튜브·자료실 칸 "맨 앞 고정" ----
// public/home.json 의 youtube / blog 목록(또는 sheet 시트의 "칸, 링크")에 적은 순서대로 맨 앞에 보여 줘요. 나머지는 최신 순.
const HOME_URL = 'https://raw.githubusercontent.com/dandong5864/dandongsam-editor/main/public/home.json';
const normUrl = (u) => ytId(u) ? 'yt:' + ytId(u) : String(u || '').trim().replace(/^https?:\/\/(www\.|m\.)?/i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
async function homePins() {
  return cachedFeed('homepins', async () => {
    let cfg = null; try { cfg = JSON.parse(await httpGet(HOME_URL)); } catch (e) {}
    if (!cfg) { try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'home.json'), 'utf8')); } catch (e) { cfg = {}; } }
    const pins = { youtube: [].concat(cfg.youtube || []), blog: [].concat(cfg.blog || []) };
    if (cfg.sheet) { try { const rows = parseCsv(await httpGet(sheetCsvUrl(cfg.sheet), 5)); const head = (rows.shift() || []).map((h) => String(h).trim());
      const ki = head.findIndex((h) => /칸|위치|종류/.test(h)), li = head.findIndex((h) => /링크|주소|url/i.test(h)), ti = head.findIndex((h) => /제목/.test(h));
      const oi = head.findIndex((h) => /순서|번호|순위/.test(h)), num = (r) => { const n = parseFloat(String(oi >= 0 ? r[oi] : '').replace(/[^\d.]/g, '')); return isFinite(n) ? n : Infinity; };
      rows.map((r, i) => [r, i]).sort((a, b) => num(a[0]) - num(b[0]) || a[1] - b[1]).forEach((x, i) => { rows[i] = x[0]; });   // "순서" 칸 숫자가 작은 것부터, 번호 없으면 뒤로
      for (const r of rows) { const u = String(r[li >= 0 ? li : 1] || '').trim(); if (!/^https?:\/\//i.test(u)) continue; const k = String(r[ki >= 0 ? ki : 0] || ''); const it = { url: u, title: ti >= 0 ? String(r[ti] || '').trim() : '' };
        (/자료|블로그|blog/i.test(k) ? pins.blog : ytId(u) || /유튜브|youtube/i.test(k) ? pins.youtube : pins.blog).push(it); } } catch (e) {} }
    return pins;
  });
}
async function pinItem(v, feed) {
  const it = typeof v === 'string' ? { url: v } : (v || {}); const u = String(it.url || '').trim(); if (!/^https?:\/\//i.test(u)) return null;
  const id = ytId(u);
  if (id) return { title: it.title || (await cachedFeed('yt-t' + id, () => ytTitle(id))) || '유튜브 영상', url: /\/shorts\//.test(u) ? 'https://www.youtube.com/shorts/' + id : 'https://www.youtube.com/watch?v=' + id, thumb: it.thumb || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, pin: true };
  const f = (feed || []).find((x) => normUrl(x.url) === normUrl(u)); if (f) return { ...f, title: it.title || f.title, thumb: it.thumb || f.thumb, pin: true };
  const meta = await cachedFeed('pg' + u, async () => { try { const h = await httpGet(u); const og = (p) => ((new RegExp(`<meta[^>]+property=["']og:${p}["'][^>]+content=["']([^"']+)`, 'i').exec(h) || new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${p}["']`, 'i').exec(h) || [])[1] || '');
    return { title: xmlText(og('title') || (/<title>([^<]*)<\/title>/i.exec(h) || [])[1] || ''), thumb: og('image') }; } catch (e) { return {}; } });
  return { title: it.title || meta.title || u, url: u, thumb: it.thumb || meta.thumb || '', pin: true };
}
async function withPins(kind, feed) {
  let pins = []; try { pins = (await homePins())[kind] || []; } catch (e) {}
  const out = []; for (const v of pins) { const x = await pinItem(v, feed); if (x && !out.some((o) => normUrl(o.url) === normUrl(x.url))) out.push(x); }
  return out.concat((feed || []).filter((f) => !out.some((o) => normUrl(o.url) === normUrl(f.url) || (ytId(o.url) && ytId(o.url) === ytId(f.url)))));
}
// ---- 영상 갤러리 좋아요 · 올리기 (구글 설문지로 보내고, 응답 시트로 모아요) ----
let exCfg = null; const lkCache = { t: 0, v: {} };
const vkey = (u) => ytId(u) || String(u || '').trim();
const LIKE_FILE = () => path.join(DATA_ROOT, 'likes.json');
const myLikes = () => { try { return JSON.parse(fs.readFileSync(LIKE_FILE(), 'utf8')) || {}; } catch (e) { return {}; } };
const formPostUrl = (u) => { const m = /\/forms\/d\/e\/([\w-]+)/.exec(String(u || '')); return m ? `https://docs.google.com/forms/d/e/${m[1]}/formResponse` : ''; };
function httpPostForm(url, fields) {
  const body = new URLSearchParams(fields).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0 DandongsamEditor', 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }, timeout: 10000 }, (r) => {
      r.on('error', () => {}); r.resume(); (r.statusCode >= 200 && r.statusCode < 400) ? resolve(r.statusCode) : reject(new Error('HTTP ' + r.statusCode)); });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end(body);
  });
}
// 좋아요 시트의 "영상" 칸을 세어요. "-영상키"는 좋아요 취소예요
async function likeCounts() {
  const sh = exCfg && exCfg.like && exCfg.like.sheet; if (!sh) return {};
  if (Date.now() - lkCache.t < 2 * 60 * 1000) return lkCache.v;
  const c = {};
  try { const rows = parseCsv(await httpGet(sheetCsvUrl(sh), 5)); rows.shift();
    for (const r of rows) { const v = String(r[1] || '').trim(); if (!v) continue; const neg = v[0] === '-', k = neg ? v.slice(1) : v; c[k] = (c[k] || 0) + (neg ? -1 : 1); }
    lkCache.t = Date.now(); lkCache.v = c; } catch (e) { return lkCache.v; }
  return c;
}
async function examplesWithLikes() {
  const base = await cachedFeed('ex', examplesFeed); const cnt = await likeCounts(); const mine = myLikes();
  const items = base.list.map((it, i) => { const k = vkey(it.url); return { ...it, key: k, n: Math.max(0, cnt[k] || 0), liked: !!mine[k], i }; });
  items.sort((a, b) => b.n - a.n || a.i - b.i);
  let rank = 0, prev = -1; items.forEach((it) => { if (it.n > 0) { if (it.n !== prev) { rank++; prev = it.n; } it.rank = rank; } });
  const lk = exCfg && exCfg.like || {}, sd = exCfg && exCfg.send || {};
  const tx = (v) => String(v || '').replace(/[<>]/g, '').trim().slice(0, 40);
  return { title: tx(exCfg && exCfg.title), hint: tx(exCfg && exCfg.hint), sendLabel: tx(exCfg && exCfg.sendLabel), sendText: String((exCfg && exCfg.sendText) || '').replace(/[<>]/g, '').trim().slice(0, 200), form: base.form, more: base.more, canLike: !!(formPostUrl(lk.form) && lk.video), canSend: !!(formPostUrl(sd.form || base.form) && sd.link),
    list: items.slice(0, 12).map(({ n, i, ...x }) => x) };   // 숫자는 보내지 않고 순위만 보내요
}
async function examplesFeed() {
  let cfg = null;
  try { cfg = JSON.parse(await httpGet(EX_URL)); } catch (e) {}
  if (!cfg) { try { cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'examples.json'), 'utf8')); } catch (e) { cfg = {}; } }
  const list = [];
  for (const v of (Array.isArray(cfg.videos) ? cfg.videos : [])) {
    const it = typeof v === 'string' ? { url: v } : (v || {}); const id = ytId(it.url);
    if (!id && !/^https?:\/\//i.test(it.url || '')) continue;
    let title = it.title || '';
    if (!title && id) { try { title = JSON.parse(await httpGet('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id))).title || ''; } catch (e) {} }
    list.push({ title: title || '자동 편집 예시', url: id ? (/\/shorts\//.test(it.url) ? 'https://www.youtube.com/shorts/' + id : 'https://www.youtube.com/watch?v=' + id) : it.url, thumb: it.thumb || (id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : '') });
  }
  // 구글 설문지로 받은 영상: 응답 시트에서 "승인"에 체크한 줄만, 최근 것부터 보여 줘요
  if (cfg.sheet) {
    try {
      const csv = await httpGet(sheetCsvUrl(cfg.sheet), 5); const rows = parseCsv(csv); const head = (rows.shift() || []).map((h) => String(h).trim());
      const ai = head.findIndex((h) => /승인/.test(h)), ti = head.findIndex((h) => /제목/.test(h)), ni = head.findIndex((h) => /이름|닉네임/.test(h));
      const ok = (v) => /^(true|o|y|yes|v|✔|✅|☑|승인|예|네|ㅇ|1)$/i.test(String(v || '').trim());
      for (const r of rows.reverse()) {
        if (ai < 0 || !ok(r[ai])) continue;
        const link = r.find((c) => ytId(c) || /^https?:\/\/\S+\.(mp4|webm|mov)(\?\S*)?$/i.test(String(c).trim())); if (!link) continue;
        const u = String(link).trim(), id = ytId(u); if (list.some((x) => id ? x.url.includes(id) : x.url === u)) continue;
        let title = ti >= 0 ? String(r[ti] || '').trim() : ''; if (!title && id) title = await ytTitle(id);
        const by = ni >= 0 ? String(r[ni] || '').trim() : '';
        list.push({ title: (title || '자동 편집 예시') + (by ? ' · ' + by : ''), url: id ? (/\/shorts\//.test(u) ? 'https://www.youtube.com/shorts/' : 'https://www.youtube.com/watch?v=') + id : u, thumb: id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : '' });
        if (list.length >= 24) break;
      }
    } catch (e) {}
  }
  // 사이트 주소(page)를 넣으면 그 페이지에 있는 동영상 링크(유튜브·mp4 등)만 골라서 순서대로 보여 줘요
  for (const pg of [].concat(cfg.page || [])) {
    try {
      const html = (await httpGet(/^https?:\/\//i.test(pg) ? pg : 'https://' + pg)).replace(/\\\//g, '/').replace(/&amp;/g, '&');
      const re = /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^"'\s<>]*?&)?v=|shorts\/|embed\/|live\/))([\w-]{11})|(https?:\/\/[^"'\s<>]+\.(?:mp4|webm|mov)(?:\?[^"'\s<>]*)?)/gi; let m;
      while ((m = re.exec(html)) && list.length < 24) {
        if (m[1]) { const id = m[1]; if (list.some((x) => x.url.includes(id))) continue; let title = ''; try { title = JSON.parse(await httpGet('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id))).title || ''; } catch (e) {}
          list.push({ title: title || '자동 편집 예시', url: (/shorts\//i.test(m[0]) ? 'https://www.youtube.com/shorts/' : 'https://www.youtube.com/watch?v=') + id, thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` }); }
        else if (!list.some((x) => x.url === m[2])) list.push({ title: decodeURIComponent(m[2].split('?')[0].split('/').pop()).replace(/\.\w+$/, ''), url: m[2], thumb: '' });
      }
    } catch (e) {}
  }
  const pl = String(cfg.playlist || '').match(/(?:list=)?((?:PL|UU|OL|FL)[\w-]{10,})/);
  if (pl) {
    try { const xml = await httpGet('https://www.youtube.com/feeds/videos.xml?playlist_id=' + pl[1]); const re = /<entry>([\s\S]*?)<\/entry>/g; let m;
      while ((m = re.exec(xml))) { const id = (/<yt:videoId>([^<]+)</.exec(m[1]) || [])[1]; const t = (/<title>([\s\S]*?)<\/title>/.exec(m[1]) || [])[1]; if (id && !list.some((x) => x.url.includes(id))) list.push({ title: xmlText(t), url: 'https://www.youtube.com/watch?v=' + id, thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` }); } } catch (e) {}
  }
  const form = /^https:\/\/(docs\.google\.com\/forms|forms\.gle)\//.test(String(cfg.form || '')) ? cfg.form : '';
  exCfg = cfg;
  return { form, list: list.slice(0, 24), more: pl ? 'https://www.youtube.com/playlist?list=' + pl[1] : (cfg.more || [].concat(cfg.page || [])[0] || '') };
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
      r.pipe(ws); ws.on('error', (e) => { stt.dl = { state: 'error', pct: 0, msg: e.message }; });
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
  } catch (e) { J.state = 'error'; J.err = String(e.message || e); J.msg = '문제가 생겼어요'; console.error('자동 자막', J.err); }
}
// ---- 자동 편집: 작업 폴더의 영상·소리를 편집기가 먼저 받아 적어 "받아적기" 폴더에 둬요 ----
// AI는 이 파일로 말 없는 구간을 찾아 자르고 자막을 만들어요. 파이썬 음성 인식이 없는 AI(ChatGPT 등)도 첨부해서 쓸 수 있어요.
// 모양은 스킬의 transcribe.py 결과와 같아요: { file, src:{size,mtime}, duration, segments:[{start,end,text,words:[{w,s,e}]}] }
const AUTO_STT_DIR = '받아적기';
const fileStamp = (f) => { const st = fs.statSync(f); return { size: st.size, mtime: Math.floor(st.mtimeMs / 1000) }; };
function autoSttTargets(dir) {
  let l = []; try { l = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {}
  return l.filter((e) => e.isFile() && MED_RE.test(e.name) && !/_edited\.wav$/i.test(e.name)).map((e) => path.join(dir, e.name)).sort();
}
function autoSttOut(f) { return path.join(path.dirname(f), AUTO_STT_DIR, path.basename(f) + '.words.json'); }
function autoSttDone(f) { try { const j = JSON.parse(fs.readFileSync(autoSttOut(f), 'utf8')); const a = j.src || {}, b = fileStamp(f); return a.size === b.size && a.mtime === b.mtime; } catch (e) { return false; } }
function toWordJson(raw, len) {   // 낱말 조각(앞 공백 = 새 낱말) → 낱말 → 문장 단위 구간
  const words = []; raw.forEach((q) => { if (q.sp || !words.length) words.push({ w: q.text, s: q.start, e: q.end }); else { const w = words[words.length - 1]; w.w += q.text; w.e = q.end; } });
  const segs = []; let cur = null;
  words.forEach((w) => {
    if (cur && (w.s - cur.end > 0.8 || /[.?!。…]$/.test(cur.words[cur.words.length - 1].w) || cur.text.length + 1 + w.w.length > 40)) { segs.push(cur); cur = null; }
    if (!cur) cur = { start: w.s, end: w.e, text: w.w, words: [] }; else { cur.text += ' ' + w.w; cur.end = w.e; }
    cur.words.push({ w: ' ' + w.w, s: +w.s.toFixed(3), e: +Math.min(len, w.e).toFixed(3) });
  });
  if (cur) segs.push(cur);
  return segs.map((g) => ({ start: +g.start.toFixed(3), end: +Math.min(len, g.end).toFixed(3), text: g.text, words: g.words }));
}
async function autoSttRun(dir, force) {
  const J = stt.job = { state: 'running', pct: 0, msg: '준비하는 중…', segs: [], err: '', auto: dir, made: 0, skipped: 0, silent: 0, idx: 0, total: 0 }; sttStop = false;
  try {
    const files = autoSttTargets(dir).filter((f) => { if (!force && autoSttDone(f)) { J.skipped++; return false; } return true; });
    J.total = files.length;   // 몇 번째 파일인지 버튼에 보여 줘요 (0%에 오래 머물러도 멈춘 게 아닌 걸 알 수 있게)
    const save = (f, len, segs, extra) => { const op = autoSttOut(f); fs.mkdirSync(path.dirname(op), { recursive: true }); fs.writeFileSync(op, JSON.stringify({ file: path.basename(f), src: fileStamp(f), duration: +(+len || 0).toFixed(3), by: '단동샘 편집기', ...extra, segments: segs }, null, 1), 'utf8'); };
    const infos = []; for (const f of files) { if (sttStop) break; let i = null; try { i = await probe(f); } catch (e) {} if (i && i.hasAudio && i.duration > 0.3) infos.push({ f, len: i.duration }); else { J.silent++; try { save(f, i && i.duration, [], { noAudio: true }); } catch (e) {} } }   // 소리 없는 영상도 "소리 없음"으로 적어 둬요
    J.total = infos.length;
    if (infos.length && !sttCtx && !sttStop) {
      let mod; try { mod = require('@fugood/whisper.node'); } catch (e) { throw new Error('음성 인식 구성요소를 불러오지 못했어요 (' + e.message.split('\n')[0] + ')'); }
      J.msg = '음성 인식 모델을 켜는 중… (처음엔 조금 걸려요)'; try { sttCtx = await mod.initWhisper({ filePath: STT_FILE, useGpu: false }); } catch (e) { throw new Error('음성 인식 모델을 켜지 못했어요. 편집기를 다시 켜 보세요 (' + String(e.message || e).split('\n')[0] + ')'); }
    }
    const total = infos.reduce((a, x) => a + x.len, 0) || 1; let done = 0;
    for (let i = 0; i < infos.length; i++) {
      if (sttStop) break;
      const { f, len } = infos[i]; J.idx = i + 1; J.msg = `받아 적는 중… ${path.basename(f)} (${i + 1}/${infos.length})`;
      const pcm = await pcmOf(f, 0, len); const raw = [];
      if (pcm.length >= 3200) {
        const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2)), base = done;
        const job = sttCtx.transcribeData(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength), { language: 'ko', temperature: 0, maxLen: 1, splitOnWord: true, tokenTimestamps: true, onProgress: (p) => { J.pct = Math.min(99, Math.floor((base + len * p / 100) / total * 100)); } });
        sttCur = job; const res = await job.promise; sttCur = null;
        if (sttStop) break;
        (res.segments || []).forEach((sg) => { const r = String(sg.text || ''), t = r.trim(); if (!t) return; const a = Math.max(0, sg.t0 / 1000), b = Math.min(len, sg.t1 / 1000); if (b <= a) return; raw.push({ sp: /^\s/.test(r), text: t, start: a, end: b }); });
      }
      save(f, len, toWordJson(raw, len)); J.made++;
      done += len; J.pct = Math.min(99, Math.floor(done / total * 100));
    }
    J.state = sttStop ? 'stopped' : 'done'; J.pct = 100; J.msg = sttStop ? '중단했어요' : '끝!';
  } catch (e) { J.state = 'error'; J.err = String(e.message || e); J.msg = '문제가 생겼어요'; console.error('받아 적기', J.err); }
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
    const win = process.env.DDS_WINDOW;   // 실행 프로그램이 위쪽 회색 줄 없는 창을 띄울 수 있으면 그걸 써요
    if (win && fs.existsSync(win)) { try { const c = spawn(win, ['--window', url], { detached: true, stdio: 'ignore' }); c.on('error', () => exec(`start "" msedge --app="${url}"`)); c.unref(); return; } catch (e) {} }
    exec(`start "" msedge --app="${url}"`, (e) => { if (e) exec(`start "" "${url}"`); });
  } else if (process.platform === 'darwin') {
    exec(`open -na "Google Chrome" --args --app="${url}" || open "${url}"`);
  } else exec(`xdg-open "${url}"`);
}

// ---- 창을 닫으면 자동 종료 (exe 실행 때만) ----
let lastPing = 0, byeAt = 0;
if (process.env.AUTO_QUIT) {
  const busy = () => Object.values(jobs).some((j) => j && (j.status === 'running' || j.status === 'queued'));
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now(), gap = now - lastTick; lastTick = now;
    if (gap > 20000) { lastPing = now; byeAt = 0; return; }   // 컴퓨터가 잠들었다 깬 직후엔 화면이 다시 신호를 보낼 때까지 기다려요
    if (busy()) { byeAt = 0; return; }
    if (byeAt && now - byeAt > 10000) process.exit(0);
    if (lastPing && now - lastPing > 12 * 3600000) process.exit(0);   // 12시간 동안 아무 신호가 없을 때만 (창이 비정상으로 닫힌 경우)
  }, 3000).unref();
}

// ---- 모션그래픽: 편집기 화면이 그린 그림(프레임)을 받아 영상 파일로 만들어요 ----
// 화면 → /api/mg/start → /api/mg/frame (JPEG·PNG 를 이어 붙여 여러 장씩) → /api/mg/finish
// 같은 설계도로 만든 영상은 다시 만들지 않고 그대로 써요 (mgHash). 작업 폴더가 있으면 결과/모션그래픽/ 에도 저장해요.
const mgRuns = {};
const MG_HASH = /^[0-9a-z]{6,40}$/;
const mgJobDir = (job) => { if (!job || typeof job !== 'string') return null; try { const d = path.resolve(job); if (autoAllowed(d) && fs.statSync(d).isDirectory()) return d; } catch (e) {} return null; };
const mgSaveDir = (jd) => path.join(jd, '결과', '모션그래픽');
const mgClean = (nm) => String(nm || '모션그래픽').replace(/[\\/:*?"<>|\r\n]/g, '').trim().slice(0, 60) || '모션그래픽';
async function mgIngest(file, alphaFile, name, hash) {
  const id = crypto.randomBytes(6).toString('hex'), dest = path.join(DIRS.media, id + '.mp4');
  fs.copyFileSync(file, dest);
  if (alphaFile && fs.existsSync(alphaFile)) fs.copyFileSync(alphaFile, alphaPathOf(id));
  const m = await ingest(id, name, dest, '.mp4'); m.mg = true; m.mgHash = hash; media[id] = m; saveDB(); return m;
}
// AI가 만든 HTML 은 편집기와 다른 주소(127.0.0.1 ↔ localhost)에서 열어요. 그래야 브라우저가 따로 떼어 돌려서,
// HTML 이 무한 반복에 빠져도 편집기 화면은 멈추지 않고, 시간이 지나면 그 칸만 꺼요.
const mgBoxes = {};
function mgBoxGet(req, res, p) {
  const r = mgBoxes[p.slice(8)]; delete mgBoxes[p.slice(8)];
  if (!r || Date.now() - r.at > 120000) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; sandbox allow-scripts" });
  res.end(r.doc);
}
async function handleMg(req, res, p, u) {
  if (req.method === 'GET' && p === '/api/mg/html') {   // AI가 작업 폴더에 만든 모션그래픽 HTML 읽기 (작업 폴더 안의 .html 만)
    const jd = mgJobDir(u.searchParams.get('job')); const rel = String(u.searchParams.get('f') || '');
    if (!jd) return json(res, 400, { error: '작업 폴더를 찾을 수 없어요' });
    const cands = [path.resolve(jd, '결과', rel), path.resolve(jd, rel)];
    const f = cands.find((x) => inside(x, jd) && /\.html?$/i.test(x) && fs.existsSync(x) && fs.statSync(x).isFile());
    if (!f) return json(res, 404, { error: '모션그래픽 파일을 찾을 수 없어요: ' + rel });
    if (fs.statSync(f).size > 3e6) return json(res, 400, { error: '모션그래픽 파일이 너무 커요' });
    return json(res, 200, { html: fs.readFileSync(f, 'utf8').replace(/^﻿/, '') });
  }
  if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
  if (p === '/api/mg/frame') {
    const r = mgRuns[u.searchParams.get('id')]; if (!r) { req.resume(); return json(res, 400, { error: '영상 만들기가 끝났거나 없어요' }); }
    r.at = Date.now();
    try {
      for await (const c of req) { if (r.dead) break; if (!r.proc.stdin.write(c)) await new Promise((ok) => { const go = () => { r.proc.stdin.off('drain', go); r.proc.off('close', go); ok(); }; r.proc.stdin.once('drain', go); r.proc.once('close', go); }); }
    } catch (e) {}
    return json(res, r.dead ? 500 : 200, r.dead ? { error: '영상 만들기에 실패했어요' + (r.err ? ': ' + r.err.slice(-300) : '') } : { ok: true });
  }
  const b = await readBody(req).catch(() => ({}));
  if (p === '/api/mg/box') {
    const doc = String(b.doc || ''); if (!doc || doc.length > 4e6) return json(res, 400, { error: '모션그래픽 파일이 너무 커요' });
    Object.keys(mgBoxes).forEach((k) => { if (Date.now() - mgBoxes[k].at > 120000) delete mgBoxes[k]; });
    if (Object.keys(mgBoxes).length >= 5) return json(res, 429, { error: '모션그래픽을 이미 만들고 있어요. 잠시 뒤에 다시 해 주세요' });
    const id = crypto.randomBytes(12).toString('hex'); mgBoxes[id] = { doc, at: Date.now() }; return json(res, 200, { id });
  }
  if (p === '/api/mg/find') {   // 이미 만든 같은 모션그래픽이 있으면 그대로 써요
    const h = String(b.hash || ''); if (!MG_HASH.test(h)) return json(res, 200, {});
    const hit = Object.values(media).find((m) => m.mg && m.mgHash === h && fs.existsSync(m.file));
    if (hit) return json(res, 200, { media: pub(hit) });
    const jd = mgJobDir(b.job); if (!jd) return json(res, 200, {});
    const f = path.join(mgSaveDir(jd), 'mg_' + h + '.mp4');
    if (!fs.existsSync(f)) return json(res, 200, {});
    try { const m = await mgIngest(f, path.join(mgSaveDir(jd), 'mg_' + h + '.webm'), mgClean(b.name) + '.mp4', h); return json(res, 200, { media: pub(m) }); } catch (e) { return json(res, 200, {}); }
  }
  if (p === '/api/mg/start') {
    const W = Math.round(+b.w || 0), H = Math.round(+b.h || 0), fps = Math.round(clamp(+b.fps || 30, 10, 60)), h = String(b.hash || '');
    if (!(W >= 64 && H >= 64 && W <= 3840 && H <= 3840) || W % 2 || H % 2 || !MG_HASH.test(h)) return json(res, 400, { error: '모션그래픽 크기가 맞지 않아요' });
    Object.keys(mgRuns).forEach((k) => { if (Date.now() - mgRuns[k].at > 600000) { try { mgRuns[k].proc.kill(); } catch (e) {} delete mgRuns[k]; } });
    if (Object.keys(mgRuns).length >= 3) return json(res, 429, { error: '모션그래픽을 이미 만들고 있어요. 잠시 뒤에 다시 해 주세요' });
    const id = crypto.randomBytes(6).toString('hex'), out = path.join(DIRS.cache, 'mg_' + id + '.mp4'), aout = b.alpha ? path.join(DIRS.cache, 'mg_' + id + '.webm') : null;
    const inp = ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', b.alpha ? 'png' : 'mjpeg', '-i', '-'];
    const mp4 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'veryfast', '-r', String(fps), '-movflags', '+faststart', out];
    const args = aout ? [...inp, '-filter_complex', `[0:v]scale=${W}:${H},format=rgba,split=2[va][vb];[va]format=yuva420p[vx];[vb]format=yuv420p[vm]`, '-map', '[vx]', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '32', '-deadline', 'realtime', '-cpu-used', '8', '-auto-alt-ref', '0', '-r', String(fps), aout, '-map', '[vm]', ...mp4]
      : [...inp, '-vf', `scale=${W}:${H},format=yuv420p`, ...mp4];
    const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const r = mgRuns[id] = { proc, out, aout, hash: h, name: mgClean(b.name) + '.mp4', job: b.job, at: Date.now(), err: '', dead: false };
    proc.stderr.on('data', (c) => { r.err = (r.err + c).slice(-2000); });
    proc.stdin.on('error', () => {});
    r.done = new Promise((ok) => proc.on('close', (code) => { r.code = code; if (code) r.dead = true; ok(); }));
    proc.on('error', (e) => { r.dead = true; r.err += e.message; });
    return json(res, 200, { id });
  }
  if (p === '/api/mg/finish' || p === '/api/mg/cancel') {
    const r = mgRuns[b.id]; if (!r) return json(res, 400, { error: '영상 만들기가 끝났거나 없어요' });
    delete mgRuns[b.id];
    if (p === '/api/mg/cancel') { try { r.proc.kill(); } catch (e) {} [r.out, r.aout].forEach((f) => { if (f) try { fs.unlinkSync(f); } catch (e) {} }); return json(res, 200, { ok: true }); }
    try { r.proc.stdin.end(); } catch (e) {}
    await r.done;
    const fail = (msg) => { [r.out, r.aout].forEach((f) => { if (f) try { fs.unlinkSync(f); } catch (e) {} }); return json(res, 500, { error: msg }); };
    if (r.code || !fs.existsSync(r.out)) return fail('모션그래픽 영상을 만들지 못했어요' + (r.err ? ': ' + r.err.slice(-300) : ''));
    let m; try { m = await mgIngest(r.out, r.aout, r.name, r.hash); } catch (e) { return fail('모션그래픽 영상을 불러오지 못했어요: ' + e.message); }
    let saved = null; const jd = mgJobDir(r.job);
    if (jd) { try { const sd = mgSaveDir(jd); fs.mkdirSync(sd, { recursive: true }); saved = path.join(sd, 'mg_' + r.hash + '.mp4'); fs.copyFileSync(r.out, saved); if (r.aout) fs.copyFileSync(r.aout, path.join(sd, 'mg_' + r.hash + '.webm')); } catch (e) { saved = null; } }
    [r.out, r.aout].forEach((f) => { if (f) try { fs.unlinkSync(f); } catch (e) {} });
    return json(res, 200, { media: pub(m), saved });
  }
  res.writeHead(404); res.end();
}

// ---- 라우터 ----
// ---- 지킴이: 편집기 화면에서 온 요청만 받아요 (다른 웹사이트가 몰래 보내는 요청은 막아요) ----
const OK_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
function fromOutside(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!OK_HOSTS.has(host)) return true;   // 주소를 바꿔 치는 수법(DNS 리바인딩) 막기
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return true;   // 다른 사이트에서 보낸 요청
  const org = req.headers.origin;
  if (org && org !== 'null' && !OK_HOSTS.has(org.replace(/^https?:\/\//i, '').toLowerCase())) return true;
  if (org === 'null' && req.method !== 'GET' && req.method !== 'HEAD') return true;
  return false;
}
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && /^\/mg-box\/[0-9a-f]{24}$/.test(String(req.url || '')) && OK_HOSTS.has(String(req.headers.host || '').toLowerCase())) return mgBoxGet(req, res, req.url);   // 모션그래픽 칸: 편집기가 맡긴 글만 한 번 돌려줘요 (다른 곳에서 열 수 없게 긴 무작위 번호)
  if (fromOutside(req)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Forbidden'); }
  const u = new URL(req.url, 'http://localhost');
  let p; try { p = decodeURIComponent(u.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  try {
    if (req.method === 'POST' && p === '/api/upload') return handleUpload(req, res, u.searchParams);
    if (req.method === 'POST' && p === '/api/record') return handleRecord(req, res, u.searchParams);
    if (req.method === 'GET' && p === '/api/media') return json(res, 200, Object.values(media).map(pub));
    let m;
    if (req.method === 'GET' && (m = /^\/media\/(\w+)$/.exec(p))) {
      const it = media[m[1]]; if (!it) { res.writeHead(404); return res.end(); }
      if (u.searchParams.get('a') && hasAlpha(it)) return serveFile(req, res, alphaPathOf(it.id), 'video/webm');
      if (u.searchParams.get('lite') && it.lite && fs.existsSync(it.lite)) return serveFile(req, res, it.lite, 'video/mp4');
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
        [it.file, it.thumb, it.preview, it.lite, path.join(DIRS.cache, it.id + '.peaks.json'), alphaPathOf(it.id)].forEach((f) => { try { f && fs.unlinkSync(f); } catch (e) {} });
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
      if (dir === path.parse(dir).root || dir === path.resolve(os.homedir())) return json(res, 400, { error: '드라이브 전체나 사용자 폴더 전체는 고를 수 없어요. 그 안의 폴더를 골라 주세요' });
      const c = autoCfg(); if (!inside(dir, c.root) && !c.extra.includes(dir)) { c.extra.push(dir); autoSave(c); }
      try { prepareJob(dir); } catch (e) { return json(res, 500, { error: '폴더에 쓸 수 없어요: ' + e.message }); }
      return json(res, 200, { path: dir });
    }
    if (req.method === 'POST' && p === '/api/auto/root') {
      const b = await readBody(req); const dir = path.resolve(String(b.path || '').replace(/^"|"$/g, ''));
      if (!String(b.path || '').trim() || dir === path.parse(dir).root || dir === path.resolve(os.homedir())) return json(res, 400, { error: '드라이브 전체나 사용자 폴더 전체는 고를 수 없어요. 그 안의 폴더를 골라 주세요' });
      if (tooBroad(dir)) return json(res, 400, { error: '다운로드·바탕 화면·문서 같은 큰 폴더나 편집기 폴더는 고를 수 없어요. 그 안에 새 폴더를 만들어 골라 주세요' });   // 그 아래 모든 폴더가 작업으로 잡혀 지워질 수 있어서 막아요
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return json(res, 400, { error: '그 위치에 폴더를 만들 수 없어요' }); }
      const c = autoCfg(); c.root = dir; autoSave(c); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/auto/settings') {
      const b = await readBody(req); const d = path.resolve(String(b.path || ''));
      if (!autoAllowed(d) || !fs.existsSync(d)) return json(res, 400, { error: '폴더를 찾을 수 없어요' });
      try { fs.writeFileSync(path.join(d, '편집설정.json'), JSON.stringify(b.settings || {}, null, 2), 'utf8'); fs.writeFileSync(path.join(d, '편집파일_만드는법.txt'), DSP_GUIDE, 'utf8'); putSkill(d); } catch (e) { return json(res, 500, { error: e.message }); }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/auto/import') {
      const dir = path.resolve(String(u.searchParams.get('path') || '')); if (!autoAllowed(dir) || !fs.existsSync(dir)) return json(res, 400, { error: '작업 폴더를 찾을 수 없어요' });
      let txt = ''; await new Promise((ok) => { const ch = []; req.on('data', (c) => ch.push(c)); req.on('end', () => { txt = Buffer.concat(ch).toString('utf8').replace(/^\uFEFF/, ''); ok(); }); });
      let j; try { j = parseDsp(txt); } catch (e) { return json(res, 400, { error: '편집 파일(.dsp) 형식이 아니에요. AI가 만든 파일을 그대로 올려 주세요' }); }
      if (!j || typeof j !== 'object') return json(res, 400, { error: '편집 파일을 읽을 수 없어요' });
      const nm = (path.basename(String(u.searchParams.get('name') || '결과')).replace(/\.(dsp|json|txt)$/i, '').replace(/[\\/:*?"<>|]/g, '') || '결과') + '.dsp';
      fs.mkdirSync(path.join(dir, '결과'), { recursive: true }); const f = path.join(dir, '결과', nm); fs.writeFileSync(f, JSON.stringify(j), 'utf8'); return json(res, 200, { file: f });
    }
    if (req.method === 'POST' && p === '/api/auto/pickfile') {   // 작업 폴더의 결과 폴더를 연 상태로 파일 고르기
      const b = await readBody(req); const dir = path.resolve(String(b.path || '')); if (!autoAllowed(dir) || !fs.existsSync(dir)) return json(res, 400, { error: '작업 폴더를 찾을 수 없어요' });
      const R = path.join(dir, '결과'); fs.mkdirSync(R, { recursive: true });
      const DL = findDownloadsCached();   // 윈도우가 알고 있는 실제 다운로드 위치. ChatGPT 등 웹에서 받은 파일은 보통 '다운로드' 폴더에 있어요
      const f = await pickFile(b.from === 'downloads' && fs.existsSync(DL) ? DL : R); if (f === null) return json(res, 200, { unsupported: true }); if (!f) return json(res, 200, { canceled: true });
      let j; try { j = parseDsp(fs.readFileSync(f, 'utf8')); } catch (e) { return json(res, 400, { error: '편집 파일(.dsp) 형식이 아니에요. AI가 만든 파일을 그대로 골라 주세요' }); }
      if (!j || typeof j !== 'object') return json(res, 400, { error: '편집 파일을 읽을 수 없어요' });
      let dest = path.resolve(f);
      if (path.dirname(dest) !== path.resolve(R) || !/\.dsp$/i.test(dest)) { const nm = (path.basename(f).replace(/\.(dsp|json|txt)$/i, '').replace(/[\\/:*?"<>|]/g, '') || '결과') + '.dsp'; dest = path.join(R, nm); fs.writeFileSync(dest, JSON.stringify(j), 'utf8'); }
      return json(res, 200, { file: dest });
    }
    if (req.method === 'GET' && p === '/api/auto/stt') {   // 받아 적기 상태 (작업 폴더 기준)
      const dir = path.resolve(String(u.searchParams.get('path') || '')); if (!autoAllowed(dir) || !fs.existsSync(dir)) return json(res, 400, { error: '작업 폴더를 찾을 수 없어요' });
      const files = autoSttTargets(dir), done = files.filter(autoSttDone).length, J = stt.job;
      return json(res, 200, { have: sttHave(), dl: stt.dl, files: files.length, done, job: { state: J.state, pct: J.pct, msg: J.msg, err: J.err, mine: J.auto === dir, made: J.made || 0, skipped: J.skipped || 0, silent: J.silent || 0, idx: J.idx || 0, total: J.total || 0 } });
    }
    if (req.method === 'POST' && p === '/api/auto/stt') {
      const b = await readBody(req); const dir = path.resolve(String(b.path || '')); if (!autoAllowed(dir) || !fs.existsSync(dir)) return json(res, 400, { error: '작업 폴더를 찾을 수 없어요' });
      if (!sttHave()) { sttDownload(); return json(res, 200, { downloading: true }); }
      if (stt.job.state === 'running') return json(res, 400, { error: '이미 받아 적는 중이에요' });
      autoSttRun(dir, !!b.force); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && p === '/api/auto/openfolder') {
      const b = await readBody(req); const d = path.resolve(String(b.path || '')); let isDir = false; try { isDir = fs.statSync(d).isDirectory(); } catch (e) {}
      if (!autoAllowed(d) || !isDir) return json(res, 400, { error: '열 수 없는 폴더예요' });   // 파일을 주면 열기가 아니라 실행돼 버려서 폴더만 열어요
      openFolder(d); return json(res, 200, { ok: true });
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
        if (tooBroad(f) || !looksLikeJob(f)) return json(res, 400, { error: '편집기가 만든 작업 폴더가 아니라서 여기서 지울 수 없어요 (직접 지워 주세요)' });   // 저장 위치를 넓은 곳으로 바꿨을 때 다른 폴더를 지우지 않게
        try { fs.rmSync(f, { recursive: true, force: true }); } catch (e) { return json(res, 500, { error: '지우지 못했어요: ' + e.message }); } return json(res, 200, { ok: true });
      }
      return json(res, 400, { error: '잘못된 요청' });
    }
    if (p.startsWith('/api/mg/')) return handleMg(req, res, p, u);
    if (req.method === 'POST' && p === '/api/auto/open') {
      const b = await readBody(req); const f = path.resolve(String(b.file || ''));
      if (!autoAllowed(f) || !/\.dsp$/i.test(f) || !fs.existsSync(f)) return json(res, 400, { error: '편집 파일을 찾을 수 없어요' });
      let j; try { j = parseDsp(fs.readFileSync(f, 'utf8')); } catch (e) { return json(res, 400, { error: '편집 파일을 읽을 수 없어요 (형식이 맞지 않아요)' }); }
      if (!j || typeof j !== 'object') return json(res, 400, { error: '편집 파일을 읽을 수 없어요' });
      const data = tidyAiDsp(j.data && typeof j.data === 'object' ? j.data : j); const names = new Set(); { let mm = data.media || {}; (Array.isArray(mm) ? mm : Object.values(mm)).forEach((m) => { const nm = typeof m === 'string' ? m : (m && (m.name || m.file)); if (nm) names.add(String(nm)); }); (data.clips || []).concat(data.audio || []).forEach((c) => { const nm = c && (c.name || c.file); if (nm) names.add(String(nm)); }); }
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
      return json(res, 200, { data, name: j.name || path.basename(f, '.dsp'), media: added, missing, linked, job: jobDir });
    }
    if (req.method === 'GET' && p === '/api/feed/youtube') {
      const ch = String(new URL(req.url, 'http://x').searchParams.get('channel') || '');
      let l = []; try { l = await cachedFeed('yt' + ch, () => youtubeFeed(ch)); } catch (e) {} return json(res, 200, { list: await withPins('youtube', l) });
    }
    if (req.method === 'GET' && p === '/api/feed/blog') {
      const bu = String(new URL(req.url, 'http://x').searchParams.get('url') || '');
      let l = []; try { l = await cachedFeed('bl' + bu, () => blogFeed(bu)); } catch (e) {} return json(res, 200, { list: await withPins('blog', l) });
    }
    if (req.method === 'GET' && p === '/api/feed/examples') {
      try { return json(res, 200, await examplesWithLikes()); } catch (e) { return json(res, 200, { list: [] }); }
    }
    if (req.method === 'POST' && p === '/api/examples/like') {
      const b = await readBody(req); const k = String(b.key || '').trim().slice(0, 300); if (!k) return json(res, 400, { error: '영상을 찾을 수 없어요' });
      if (!exCfg) { try { await cachedFeed('ex', examplesFeed); } catch (e) {} }
      const lk = (exCfg && exCfg.like) || {}, u = formPostUrl(lk.form); if (!u || !lk.video) return json(res, 200, { error: '좋아요를 아직 쓸 수 없어요' });
      const mine = myLikes(), on = !!b.on; if (!!mine[k] === on) return json(res, 200, { ok: true, liked: on });
      try { await httpPostForm(u, { [lk.video]: (on ? '' : '-') + k }); } catch (e) { return json(res, 200, { error: '인터넷 연결을 확인해 주세요' }); }
      if (on) mine[k] = Date.now(); else delete mine[k];
      try { fs.mkdirSync(DATA_ROOT, { recursive: true }); fs.writeFileSync(LIKE_FILE(), JSON.stringify(mine)); } catch (e) {}
      return json(res, 200, { ok: true, liked: on });
    }
    if (req.method === 'POST' && p === '/api/examples/send') {
      const b = await readBody(req); const link = String(b.link || '').trim();
      if (!ytId(link) && !/^https?:\/\/\S+\.(mp4|webm|mov)(\?\S*)?$/i.test(link)) return json(res, 200, { error: '제작된 영상 링크를 붙여 넣어 주세요' });
      if (!exCfg) { try { await cachedFeed('ex', examplesFeed); } catch (e) {} }
      const sd = (exCfg && exCfg.send) || {}, u = formPostUrl(sd.form || exCfg && exCfg.form); if (!u || !sd.link) return json(res, 200, { error: '지금은 보낼 수 없어요' });
      if (Date.now() - (global.__lastSend || 0) < 20000) return json(res, 200, { error: '잠시 후에 다시 보내 주세요' });
      const f = { [sd.link]: link }; if (sd.name && b.name) f[sd.name] = String(b.name).trim().slice(0, 40); if (sd.title && b.title) f[sd.title] = String(b.title).trim().slice(0, 100);
      try { await httpPostForm(u, f); } catch (e) { return json(res, 200, { error: '보내지 못했어요. 인터넷 연결을 확인해 주세요' }); }
      global.__lastSend = Date.now(); return json(res, 200, { ok: true });
    }
    // ---- 새 버전 알림 · 자동 업데이트 (GitHub 릴리스) ----
    if (req.method === 'GET' && p === '/api/version') return json(res, 200, { version: APP_VER });
    if (req.method === 'GET' && p === '/api/report/info') {
      let form = ''; try { form = (await cachedFeed('report', reportForm)).form; } catch (e) {}
      const osName = process.platform === 'win32' ? 'Windows ' + os.release() : process.platform + ' ' + os.release();
      return json(res, 200, { form, version: APP_VER, os: osName + ' (' + os.arch() + ')', mem: Math.round(os.totalmem() / 1073741824) + 'GB', log: LOG_RING.map(maskPrivate) });
    }
    if (req.method === 'POST' && p === '/api/report/mask') { const b = await readBody(req); return json(res, 200, { text: maskPrivate(b && b.text) }); }
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
      let pm = null;   // 캡처한 그림은 미디어 목록에도 자동으로 넣어 줘요
      try { const id = crypto.randomBytes(6).toString('hex'), dest = path.join(DIRS.media, id + '.png'); fs.copyFileSync(out, dest); const m = await ingest(id, path.basename(out), dest, '.png'); media[id] = m; saveDB(); pm = pub(m); }
      catch (e) { pm = null; }
      return json(res, 200, { file: out, media: pm });
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
    if (p === '/api/alive') return json(res, 200, { open: !!lastPing && Date.now() - lastPing < 15000 });
    if (p === '/api/ping') { lastPing = Date.now(); byeAt = 0; return json(res, 200, { ok: true }); }
    if (p === '/api/bye') { byeAt = Date.now(); res.writeHead(204); return res.end(); }
    if (req.method === 'GET' && p === '/api/caps') return json(res, 200, caps);
    if (p === '/api/sfx' && req.method === 'GET') {
      const dir = getSfxDir(); let files = [], exists = false;
      try { exists = fs.statSync(dir).isDirectory(); } catch (e) {}
      if (exists) files = walkAudio(dir, '', 0);
      const mine = walkAudio(SFX_OWN, '', 0), mset = new Set(mine.map((x) => x.rel));
      const own = mine.concat(walkAudio(SFX_APP, '', 0).filter((x) => !mset.has(x.rel))).sort((a, b) => a.rel.localeCompare(b.rel, 'ko')).map((x) => ({ name: x.name, rel: '@/' + x.rel, own: true }));
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
      let l = []; try { l = fs.readdirSync(PROJ_DIR).filter((f) => f.endsWith('.json')).map((f) => { try { const j = JSON.parse(fs.readFileSync(path.join(PROJ_DIR, f), 'utf8')); return { id: j.id, name: j.name, updated: j.updated, clips: ((j.data || {}).clips || []).length }; } catch (e) { const id = f.slice(0, -5), t = listBak(id)[0], b = t && readJson(path.join(BAK_DIR, bakKey(id), t + '.json')); return b && b.data ? { id, name: b.name, updated: b.updated || t, clips: (b.data.clips || []).length } : null; } }).filter(Boolean); } catch (e) {}
      return json(res, 200, l.sort((a, b) => b.updated - a.updated));
    }
    if (p === '/api/project/save' && req.method === 'POST') {
      const b = await readBody(req); const id = /^[a-z0-9]{6,16}$/.test(b.id || '') ? b.id : crypto.randomBytes(5).toString('hex');
      const rec = { id, name: String(b.name || '').trim().slice(0, 80) || '이름 없는 동영상', updated: Date.now(), data: b.data || {} };
      const pf = path.join(PROJ_DIR, id + '.json'); backupBefore(id, pf); writeSafe(pf, JSON.stringify(rec)); return json(res, 200, { id, name: rec.name, updated: rec.updated });
    }
    // 자동 저장: 지금 작업(저장 안 한 것 포함)을 계속 남기고, 저장한 동영상이면 그 파일도 같이 갱신해요
    if (p === '/api/autosave' && req.method === 'POST') {
      const b = await readBody(req); if (!b || !b.data) return json(res, 400, { error: '내용이 없어요' });
      backupBefore('_auto', AUTO_FILE); writeSafe(AUTO_FILE, JSON.stringify({ updated: Date.now(), proj: b.proj || null, pm: b.pm || [], data: b.data }));
      const id = b.proj && b.proj.id; const pf = /^[a-z0-9]{6,16}$/.test(id || '') && path.join(PROJ_DIR, id + '.json');
      if (pf && fs.existsSync(pf)) { const old = readJson(pf) || {}; backupBefore(id, pf); writeSafe(pf, JSON.stringify({ id, name: old.name || (b.proj.name || '이름 없는 동영상'), updated: Date.now(), data: b.data })); }
      return json(res, 200, { ok: true });
    }
    if (p === '/api/autosave' && req.method === 'GET') return json(res, 200, readJson(AUTO_FILE) || {});
    if (p === '/api/backup/snap' && req.method === 'POST') {   // 되돌리기 직전 지금 상태를 꼭 남겨 둬요
      const b = await readBody(req); const id = b && b.id; if (!/^[a-z0-9]{6,16}$/.test(id || '')) return json(res, 400, { error: '잘못된 동영상' });
      backupBefore(id, path.join(PROJ_DIR, id + '.json'), true); return json(res, 200, { ok: true });
    }
    if (p === '/api/backups' && req.method === 'GET') {
      const id = String(u.searchParams.get('id') || ''); const d = path.join(BAK_DIR, bakKey(id));
      return json(res, 200, listBak(id).map((t) => { const j = readJson(path.join(d, t + '.json')); return j && j.data ? { t, clips: (j.data.clips || []).length } : null; }).filter(Boolean));
    }
    if (p === '/api/backup' && req.method === 'GET') {
      const id = String(u.searchParams.get('id') || ''), t = String(u.searchParams.get('t') || ''); if (!/^\d+$/.test(t)) return json(res, 400, { error: '잘못된 백업' });
      const j = readJson(path.join(BAK_DIR, bakKey(id), t + '.json')); if (!j) return json(res, 404, { error: '백업을 찾을 수 없어요' });
      return json(res, 200, j);
    }
    if (p === '/api/project' && (req.method === 'GET' || req.method === 'DELETE')) {
      const id = String(u.searchParams.get('id') || ''); if (!/^[a-z0-9]{6,16}$/.test(id)) return json(res, 400, { error: '잘못된 동영상' });
      const f = path.join(PROJ_DIR, id + '.json'); if (!fs.existsSync(f)) return json(res, 404, { error: '동영상을 찾을 수 없어요' });
      if (req.method === 'DELETE') { fs.unlinkSync(f); try { fs.rmSync(path.join(BAK_DIR, id), { recursive: true, force: true }); } catch (e) {} return json(res, 200, { ok: true }); }
      const j = readJson(f); if (j && j.data) return json(res, 200, j);
      // 파일이 망가졌으면 가장 최근 정상 백업으로 열어요
      for (const t of listBak(id)) { const b = readJson(path.join(BAK_DIR, id, t + '.json')); if (b && b.data) { console.error('망가진 동영상 파일을 백업으로 열었어요', id); return json(res, 200, { ...b, restoredFrom: t }); } }
      return json(res, 500, { error: '동영상 파일이 망가져서 열 수 없어요' });
    }
    if (p === '/api/stickers' && req.method === 'GET') {
      const rd = (d) => { try { return fs.readdirSync(d).filter((f) => STICKER_EXT.includes(path.extname(f).toLowerCase())); } catch (e) { return []; } };
      const fl = [...new Set(rd(STICKER_DIR).concat(rd(STICKER_OLD)))].sort();
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
      const nm = path.basename(u.searchParams.get('n') || ''), fs2 = [STICKER_DIR, STICKER_OLD].map((d) => path.join(d, nm)).filter((f) => nm && fs.existsSync(f)); if (!fs2.length) return json(res, 404, { error: '없는 스티커예요' });
      try { fs2.forEach((f) => fs.unlinkSync(f)); } catch (e) { return json(res, 500, { error: '지우지 못했어요' }); }
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
    if (p === '/api/color/add' && req.method === 'POST') {   // 한 가지 색으로 꽉 찬 그림(영상 클립용)
      const b = await readBody(req); const hx = String(b.color || '').toLowerCase();
      if (!/^#[0-9a-f]{6}$/.test(hx)) return json(res, 400, { error: '색을 알 수 없어요' });
      const have = Object.values(media).find((m) => m && m.color === hx && m.file && fs.existsSync(m.file));
      if (have) return json(res, 200, pub(have));
      const id = crypto.randomBytes(6).toString('hex'), dest = path.join(DIRS.media, id + '.still.mp4');
      try {
        await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=c=0x${hx.slice(1)}:s=1920x1080:r=30:d=30`, '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-crf', '28', '-g', '300', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dest]);
        const m = await ingest(id, '색 배경 ' + hx.toUpperCase(), dest, '.mp4'); m.color = hx; m.isImage = true; media[id] = m; saveDB(); return json(res, 200, pub(m));
      } catch (e) { try { fs.unlinkSync(dest); } catch (e2) {} return json(res, 500, { error: e.message }); }
    }
    if (p === '/api/sfx/add' && req.method === 'POST') {
      const b = await readBody(req); const f = sfxPath(b.rel); if (!f) return json(res, 404, { error: '파일을 찾을 수 없어요' });
      const ext = path.extname(f).toLowerCase(), id = crypto.randomBytes(6).toString('hex'), dest = path.join(DIRS.media, id + ext);
      try { fs.copyFileSync(f, dest); const m = await ingest(id, path.basename(f), dest, ext); if (b.hide) m.hide = true; media[id] = m; saveDB(); return json(res, 200, pub(m)); }
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
  if (e.code === 'EADDRINUSE') {   // 이미 켜져 있으면: 창이 열려 있으면 새 창을 또 열지 않고, 창이 닫혀 있을 때만 다시 열어줘요
    console.log('이미 실행 중입니다. 열려 있는 창을 사용하세요.');
    const done = (open) => { if (!open) openApp(`http://localhost:${PORT}`); setTimeout(() => process.exit(0), 800); };
    const rq = require('http').get({ host: '127.0.0.1', port: PORT, path: '/api/alive', timeout: 2000 }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { let o = false; try { o = JSON.parse(b).open; } catch (er) {} done(o); }); });
    rq.on('error', () => done(false)); rq.on('timeout', () => { rq.destroy(); done(false); });
  }
  else { console.error(e); process.exit(1); }
});
keepFresh(() => { const c = autoCfg(); return [USER_BASE, getOutDir(), c.root, ...c.extra]; });
server.listen(PORT, '127.0.0.1', () => {
  for (const m of Object.values(media)) if (!m.lite && !m.preview && isHeavy(m)) makeLite(m.id, m.file, m);   // 예전에 가져온 큰 영상도 가벼운 사본을 만들어 둬요
  const url = `http://localhost:${PORT}`;
  console.log('==============================================');
  console.log('  단동샘 편집기 실행 중  →  ' + url);
  console.log('  이 창을 닫으면 프로그램이 종료됩니다.');
  console.log('==============================================');
  openApp(url);
});
