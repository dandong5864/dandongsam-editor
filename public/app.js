'use strict';
(() => {
/* ============ 유틸 ============ */
const $ = (s, r = document) => r.querySelector(s);
const E = (t, c, h) => { const e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
/* 오류 보내기용 최근 기록 (화면 쪽) */
const CLIENT_LOG = [];
function clientLog(kind, msg) { try { CLIENT_LOG.push(new Date().toTimeString().slice(0, 8) + ' ' + kind + ' ' + String(msg).slice(0, 400)); if (CLIENT_LOG.length > 20) CLIENT_LOG.shift(); } catch (e) {} }
window.addEventListener('error', (e) => clientLog('화면 오류', (e.message || '') + (e.filename ? ' @' + e.filename.split('/').pop() + ':' + e.lineno : '')));
window.addEventListener('unhandledrejection', (e) => clientLog('화면 오류', (e.reason && (e.reason.message || e.reason)) || ''));
/* 버전 표시: 시작 화면과 편집 화면 왼쪽 위 이름 옆 */
let appVer = null;
function addVer(host) {
  // 버전은 화면 안이 아니라 맨 위 창 제목에 보여 줘요 (예: 단동샘 편집기 v1.0.3)
  const put = (v) => { if (v) document.title = '단동샘 편집기 v' + v; };
  if (appVer) return put(appVer);
  fetch('/api/version').then((r) => r.json()).then((j) => { appVer = j && j.version; put(appVer); }).catch(() => {});
}
const fmt = (t, f = 1) => { t = Math.max(0, t || 0); const m = Math.floor(t / 60), s = t - m * 60; return String(m).padStart(2, '0') + ':' + s.toFixed(f).padStart(f ? 3 + f : 2, '0'); };
const parseTime = (s) => { s = String(s).trim().replace(',', '.'); if (!s) return NaN; const p = s.split(':').map(Number); if (p.some(isNaN)) return NaN; return p.reduce((a, b) => a * 60 + b, 0); };
let uid = 0; const nid = () => 'k' + Date.now().toString(36) + (++uid);
const FPS = 30, FRAME = 1 / FPS;
const KEY = 'vtk.project.v1';

/* ============ 상태 ============ */
let pmBoot = true;
const S = { pm: new Set(), media: new Proxy({}, { set(t, k, v) { if (!pmBoot) S.pm.add(k); t[k] = v; return true; } }), clips: [], audio: [], texts: [], bg: 'none', tpl: null, fonts: [], canvas: 'original', sel: null, t: 0, zoom: 60, total: 0, splitMode: false };
const TPLS = [
  { n: '쇼츠 기본형', v: { top: 22, bottom: 22, topColor: '#000000', midColor: '#000000', botColor: '#000000', fitMid: false } },
  { n: '상단형', v: { top: 27, bottom: 0, topColor: '#000000', midColor: '#000000', botColor: '#000000', fitMid: false } },
];
const nb = (b) => (b === 'blur' ? 'none' : (b || 'none'));
const MYTPL_KEY = 'vtk.mytpl.v1';
const myTpls = () => { try { return JSON.parse(localStorage.getItem(MYTPL_KEY) || '[]'); } catch (e) { return []; } };
const saveMyTpls = (l) => { try { localStorage.setItem(MYTPL_KEY, JSON.stringify(l)); } catch (e) {} };
const CROP_R = { square: 1, '4:5': 0.8, '9:16': 9 / 16 };
const peaks = {};            // mediaId -> Uint8 배열
const dflt = () => ({ speed: 1, vol: 100, mute: false, fit: 'contain', scale: 100, x: 0, y: 0, rot: 0, flip: false, rev: false });
const dur = (c) => (c.out - c.in) / c.speed;
function layout() { let t = 0; for (const c of S.clips) { c.start = t; t += dur(c); } S.total = t; return t; }
function locate(t) {
  if (!S.clips.length) return null;
  for (let i = 0; i < S.clips.length; i++) { const c = S.clips[i]; if (t < c.start + dur(c) - 1e-6) return { c, i }; }
  const i = S.clips.length - 1; return { c: S.clips[i], i };
}
const getSel = () => { if (!S.sel) return null; const list = S.sel.type === 'v' ? S.clips : S.sel.type === 't' ? S.texts : S.audio; const c = list.find((x) => x.id === S.sel.id); return c ? { type: S.sel.type, c } : null; };
const isSel = (type, id) => S.sel && S.sel.type === type && S.sel.id === id;

/* ============ 실행 취소 ============ */
const hist = [], redoSt = [];
const tplOn = () => (S.tpl && S.canvas === '9:16') ? S.tpl : null;
const snap = () => JSON.stringify({ clips: S.clips, audio: S.audio, texts: S.texts, bg: S.bg, tpl: S.tpl, canvas: S.canvas });
function push() { hist.push(snap()); if (hist.length > 200) hist.shift(); redoSt.length = 0; }
let lastKey = '', lastAt = 0;
function pushOnce(k) { const now = Date.now(); if (k !== lastKey || now - lastAt > 900) push(); lastKey = k; lastAt = now; }
function restore(s) { const o = JSON.parse(s); S.tpl = o.tpl || null; S.clips = o.clips; S.audio = o.audio; S.texts = o.texts || []; S.bg = nb(o.bg); S.tpl = o.tpl || null; S.canvas = o.canvas; if (!getSel()) S.sel = null; changed(true); }
function undo() { if (!hist.length) return toast('되돌릴 작업이 없습니다'); redoSt.push(snap()); restore(hist.pop()); }
function redo() { if (!redoSt.length) return toast('다시 실행할 작업이 없습니다'); hist.push(snap()); restore(redoSt.pop()); }

/* ============ 토스트 ============ */
/* 화면 한가운데에 뜨는 우리 앱 모양의 확인·입력 창 (브라우저 기본 창 대신) */
function askBox(msg, o) {
  o = o || {};
  return new Promise((resolve) => {
    const bg = E('div', 'askbg'), bx = E('div', 'askbox');
    const lines = String(msg).split('\n'); const t = E('div', 'ask-t'); t.textContent = lines[0]; bx.append(t);
    if (lines.length > 1) { const d = E('div', 'ask-d'); d.textContent = lines.slice(1).join('\n'); bx.append(d); }
    let inp = null; if (o.input) { inp = E('input', 'ask-in'); inp.type = 'text'; inp.value = o.def || ''; bx.append(inp); }
    const row = E('div', 'ask-b'), no = E('button', '', o.cancel || '취소'), ok = E('button', o.danger ? 'danger' : 'primary', o.ok || '확인');
    const done = (v) => { document.removeEventListener('keydown', kd, true); bg.remove(); resolve(v); };
    const kd = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(o.input ? null : false); } else if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); done(o.input ? inp.value : true); } else e.stopPropagation(); };
    no.onclick = () => done(o.input ? null : false); ok.onclick = () => done(o.input ? inp.value : true);
    bg.addEventListener('pointerdown', (e) => { if (e.target === bg) done(o.input ? null : false); });
    row.append(no, ok); bx.append(row); bg.append(bx); document.body.append(bg); document.addEventListener('keydown', kd, true);
    (inp || ok).focus(); if (inp) inp.select();
  });
}
const ask = (msg, o) => askBox(msg, o);
const askText = (msg, def) => askBox(msg, { input: true, def });
let goneBox = null, goneCheck = null;
function showGone() {   // 편집기와 연결이 끊겼을 때: 저절로 다시 이어 보고, 안 되면 다시 켜는 방법을 알려줘요
  if (goneBox) return;
  if (!goneCheck) {   // 잠깐 끊긴 것일 수 있으니 몇 번 더 확인한 다음에 창을 띄워요
    let n = 0;
    goneCheck = setInterval(() => fetch('/api/ping').then((r) => { if (r.ok) { clearInterval(goneCheck); goneCheck = null; } }).catch(() => { if (++n >= 3) { clearInterval(goneCheck); goneCheck = null; openGone(); } }), 1500);
  }
}
function openGone() {
  if (goneBox) return;
  const bg = E('div', ''), bx = E('div', '');
  bg.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center';
  bx.style.cssText = 'background:#1c1c22;border:1px solid #3a3a44;border-radius:16px;padding:30px 34px;max-width:460px;text-align:center;color:#fff;line-height:1.7';
  bx.innerHTML = '<div style="font-size:42px">🔌</div><div style="font-size:21px;font-weight:700;margin:6px 0 10px">편집기와 연결이 끊겼어요</div><div class="gone-msg" style="font-size:16px;color:#cfd0d8">작업하던 내용은 자동으로 저장되어 있어요.<br><b style="color:#26d4c4">다시 연결하는 중이에요…</b></div>';
  const msg = bx.querySelector('.gone-msg');
  const bt = E('button', 'primary bigbtn', '다시 연결하기'); bt.style.marginTop = '18px';
  let fails = 0;
  const later = () => { msg.innerHTML = '작업하던 내용은 자동으로 저장되어 있어요.<br>이 창을 닫고 <b style="color:#26d4c4">바탕화면의 단동샘 편집기 아이콘</b>을<br>다시 눌러 주세요.'; };
  const tryBack = () => fetch('/api/ping').then((r) => { if (r.ok) location.reload(); }).catch(() => { if (++fails >= 8) later(); });   // 편집기가 다시 켜지면 저절로 이어져요
  bt.onclick = () => { bt.textContent = '연결하는 중…'; fetch('/api/ping').then((r) => { if (r.ok) location.reload(); }).catch(() => { later(); bt.textContent = '다시 연결하기'; }); };
  bx.append(bt); bg.append(bx); document.body.append(bg); goneBox = bg;
  setInterval(tryBack, 2000); tryBack();
}
function toast(msg, action, ms = 3500) {
  if (/못|실패|오류|없어요|안 돼/.test(msg)) clientLog('알림', msg);
  if (/서버에 연결할 수 없어요/.test(msg)) { showGone(); msg = '잠시 문제가 생겼어요. 한 번 더 해 주세요'; }   // 정말 끊긴 경우에만 연결 끊김 창이 떠요
  const t = E('div', 'toast'); t.append(E('span', '', esc(msg)));
  if (action) { const b = E('button', '', action.label); b.onclick = () => { action.fn(); t.remove(); }; t.append(b); }
  $('#toast').append(t); setTimeout(() => t.remove(), action ? 7000 : ms);
}

/* ============ 요소 ============ */
let video = $('#video'); const stage = $('#stage'), tlScroll = $('#tl-scroll'), inner = $('#tl-inner');
const trackT = $('#track-t'), trackS = $('#track-s'), trackK = $('#track-k'), trackP = $('#track-p');
const ruler = $('#ruler'), trackV = $('#track-v'), trackA = $('#track-a'), ph = $('#playhead');
const propsEl = $('#props');

/* ============ 화면 비율 ============ */
function cropRectC(c, m) {
  const r = CROP_R[c.crop]; if (!r || !m || !m.width) return null;
  const W0 = m.width, H0 = m.height; let w = Math.min(W0, H0 * r), h = Math.min(H0, W0 / r); w = Math.floor(w / 2) * 2; h = Math.floor(h / 2) * 2;
  const pos = clamp((c.cropPos === undefined ? 50 : +c.cropPos) / 100, 0, 1);
  return { x: Math.floor((W0 - w) * pos / 2) * 2, y: Math.floor((H0 - h) / 4) * 2, w, h };
}
function canvasRatio() {
  if (S.canvas === 'original') {
    const c = S.clips[0], m = c && S.media[c.mediaId];
    const cr = c && cropRectC(c, m); if (cr) return cr.w / cr.h;
    if (m && m.width) { const odd = ((c.rot || 0) / 90) % 2 !== 0; return odd ? m.height / m.width : m.width / m.height; }
    return 16 / 9;
  }
  const [a, b] = S.canvas.split(':').map(Number); return a / b;
}
function canvasDims(height) {
  const r = canvasRatio(); let H = height;
  if (height === 'source') { const c = S.clips[0], m = c && S.media[c.mediaId]; H = m ? Math.max(m.width, m.height) : 1080; H = r >= 1 ? Math.round(H / r) : H; }
  H = Math.max(2, Math.round(H / 2) * 2); const W = Math.max(2, Math.round(H * r / 2) * 2); return { w: W, h: H };
}

/* ============ 재생 엔진 ============ */
let spare = document.createElement('video'); spare.playsInline = true; spare.preload = 'auto'; spare.style.cssText = 'display:block;visibility:hidden'; video.after(spare);
video.style.visibility = 'visible';
const clipKey = (c) => c.id + '|' + c.mediaId + '|' + c.in + '|' + c.speed;
function preloadNext() {
  if (!cur || spareJob) return; const i = S.clips.indexOf(cur), nx = S.clips[i + 1]; if (!nx) return;
  const key = clipKey(nx); if (spare.dataset.for === key) return; spare.dataset.for = key;
  if (spare.dataset.mid !== nx.mediaId) { spare.dataset.mid = nx.mediaId; spare.src = mediaUrl(nx.mediaId); }
  const go = () => { try { spare.currentTime = nx.in; } catch (e) {} spare.playbackRate = clamp(nx.speed, 0.0625, 16); };
  if (spare.readyState >= 1) go(); else spare.addEventListener('loadedmetadata', go, { once: true });
}
let lastW = 0;
let cur = null, playing = false, token = 0, switching = false, shuttle = 1, reverse = 0, lastTick = 0;
let actx = null, gainNode = null;
const aEls = {};
function initAudio() {
  if (actx) { if (actx.state === 'suspended') actx.resume(); return; }
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    gainNode = actx.createGain(); gainNode.connect(actx.destination);
    [video, spare].forEach((el) => actx.createMediaElementSource(el).connect(gainNode));
  } catch (e) { actx = null; }
}
const setGain = (c) => { const v = (c.mute || c.rev || tf('v').m) ? 0 : c.vol / 100; if (gainNode) gainNode.gain.value = v; else { video.volume = clamp(v, 0, 1); } };
const mediaUrl = (id) => '/media/' + id + ((S.media[id] || {}).lite ? '?lite=1' : '');   // 큰 영상은 가벼운 미리보기 사본으로

function ensureSrc(c) {
  return new Promise((res) => {
    if (video.dataset.mid === c.mediaId && video.readyState >= 1) return res();
    video.dataset.mid = c.mediaId; video.src = mediaUrl(c.mediaId);
    const done = () => { video.removeEventListener('loadedmetadata', done); res(); };
    video.addEventListener('loadedmetadata', done);
  });
}
let spareJob = null;
function readyOnSpare(mid, st) {
  if (spareJob && spareJob.mid === mid) return spareJob.p;   // 같은 영상을 이미 부르는 중이면 그걸 기다려요 (거꾸로 재생처럼 자주 불러도 멈추지 않게)
  if (spareJob) spareJob.fin(false);   // 다른 영상을 부르던 건 그만둬요
  const job = { mid };
  job.p = new Promise((res) => {
    const el = spare; let n = 0, done = false;
    const fin = job.fin = (ok) => { if (done) return; done = true; if (spareJob === job) spareJob = null; clearTimeout(tm); el.removeEventListener('loadedmetadata', meta); el.removeEventListener('seeked', got); res(ok); };
    const got = () => { if (done) return; if (el.readyState >= 2) fin(true); else if (++n < 3) setTimeout(got, 30); else fin(true); };
    const meta = () => { if (done) return; el.addEventListener('seeked', got, { once: true }); try { el.currentTime = st; } catch (e) { fin(true); } };
    const tm = setTimeout(() => fin(true), 4000);   // 너무 오래 걸리면 그냥 바꿔요
    el.pause(); el.dataset.for = '';
    if (el.dataset.mid !== mid) { el.dataset.mid = mid; el.src = mediaUrl(mid); el.addEventListener('loadedmetadata', meta, { once: true }); }
    else if (el.readyState >= 1) meta(); else el.addEventListener('loadedmetadata', meta, { once: true });
  });
  spareJob = job; return job.p;
}
async function seek(t, silent) {
  const my = ++token;
  layout(); t = clamp(t, 0, S.total); S.t = t;
  { const x = t * S.zoom, l = tlScroll.scrollLeft, w = tlScroll.clientWidth; if (x < 1) tlScroll.scrollLeft = 0; else if (w > 100 && (x < l || x > l + w - 20)) tlScroll.scrollLeft = Math.max(0, x - 60); }   // 재생 위치가 늘 보이게 (처음으로 가면 00:00부터)
  const loc = locate(t);
  if (!loc) { cur = null; video.style.display = 'none'; updateUI(); return; }
  const c = loc.c;
  const st = clamp(c.rev ? c.out - (t - c.start) * c.speed : c.in + (t - c.start) * c.speed, c.in, Math.max(c.in, c.out - 0.001));
  if (video.dataset.mid !== c.mediaId && video.readyState >= 2 && video.style.display !== 'none') {
    // 다른 영상으로 건너뛸 때: 지금 화면은 그대로 두고, 숨은 칸에서 새 장면을 다 불러온 뒤 바꿔요 (잠깐 까맣게 깜빡이지 않게)
    const ok = await readyOnSpare(c.mediaId, st);
    if (!ok || my !== token) return;
    const old = video; video = spare; spare = old; old.pause(); old.dataset.for = '';
  } else {
    await ensureSrc(c);
    if (my !== token) return;
  }
  if (Math.abs(video.currentTime - st) > 0.001) video.currentTime = st;
  video.playbackRate = clamp(c.speed * (playing ? shuttle : 1), 0.0625, 16);
  cur = c; setGain(c); video.style.display = 'block'; video.style.visibility = 'visible'; spare.pause(); spare.style.visibility = 'hidden'; spare.dataset.for = '';
  updateStage(); syncPip(); if (!silent) updateUI();
}
function play() {
  if (!S.clips.length) return;
  initAudio();
  reverse = 0;
  if (S.t >= S.total - 0.05) { seek(0).then(() => startPlay()); } else startPlay();
}
function startPlay() {
  if (!cur) return;
  playing = true; video.playbackRate = clamp(cur.speed * shuttle, 0.0625, 16); if (!cur.rev) video.play().catch(() => {});
  lastTick = performance.now(); requestAnimationFrame(tick); updatePlayBtn();
}
function pause() {
  playing = false; reverse = 0; shuttle = 1; video.pause();
  Object.values(aEls).forEach((a) => a.pause());
  syncPip(); updatePlayBtn();
}
function toggle() { playing ? pause() : play(); }
async function advance(c) {
  switching = true;
  const i = S.clips.indexOf(c), nx = S.clips[i + 1];
  if (!nx) { pause(); S.t = S.total; switching = false; updateUI(); return; }
  if (!nx.rev && !c.rev && nx.mediaId === c.mediaId && Math.abs(video.currentTime - nx.in) < 0.2 && nx.speed === c.speed) {
    cur = nx; setGain(nx); updateStage();
  } else if (!nx.rev && !c.rev && spare.dataset.for === clipKey(nx) && spare.readyState >= 2 && !spare.seeking) {
    const old = video; video = spare; spare = old; video.playbackRate = clamp(nx.speed * shuttle, 0.0625, 16);
    cur = nx; setGain(nx); video.style.display = 'block'; updateStage(); video.style.visibility = 'visible';
    video.play().catch(() => {}); old.pause(); old.style.visibility = 'hidden'; old.dataset.for = '';
  } else {
    await seek(nx.start, true);
    if (playing && !nx.rev) video.play().catch(() => {});
  }
  switching = false;
}
function tick(now) {
  if (!playing && !reverse) return;
  const dtw = Math.min(0.1, (now - (lastW || now)) / 1000); lastW = now;
  if (reverse) {
    const dt = (now - lastTick) / 1000; lastTick = now;
    S.t = Math.max(0, S.t - dt * reverse); seek(S.t); if (S.t <= 0) { reverse = 0; updatePlayBtn(); }
    updatePlayhead(); if (reverse) requestAnimationFrame(tick); return;
  }
  if (!switching && cur && cur.rev) {   // 역방향 클립: 영상 시간을 거꾸로 돌려 가며 보여 줘요 (미리보기는 소리 없이)
    S.t += dtw; if (S.t >= cur.start + dur(cur) - 0.02) advance(cur); else video.currentTime = clamp(cur.out - (S.t - cur.start) * cur.speed, cur.in, Math.max(cur.in, cur.out - 0.001));
    updatePlayhead(); audioTick(); syncPip(); requestAnimationFrame(tick); return;
  }
  if (!switching && cur) {
    const st = video.currentTime;
    if (st >= cur.out - 0.03 || video.ended) advance(cur);
    else { S.t = cur.start + (st - cur.in) / cur.speed; preloadNext(); }
  }
  updatePlayhead(); audioTick(); syncPip();
  requestAnimationFrame(tick);
}
function audioTick() {
  // 화면 시계(S.t)는 영상을 따라가요. 컷이 바뀌며 영상이 다음 장면을 찾는 동안(seek·버퍼링)엔 시계가 멈추니, 더빙도 잠깐 멈춰 자막과 어긋나지 않게 해요
  const hold = playing && (switching || (cur && !cur.rev && (video.seeking || video.readyState < 3)));
  for (const a of S.audio) {
    const m = S.media[a.mediaId]; if (!m) continue;
    const en = a.start + (a.out - a.in);
    let el = aEls[a.id];
    if (S.t >= a.start && S.t < en) {
      if (!el) { el = aEls[a.id] = new Audio(mediaUrl(a.mediaId)); el.preload = 'auto'; }
      const want = a.in + (S.t - a.start), d = el.currentTime - want;
      el.volume = tf('a').m ? 0 : clamp(a.vol / 100, 0, 1);
      if (hold || !playing) { if (!el.paused) el.pause(); continue; }
      if (el.paused) { if (Math.abs(d) > 0.03) el.currentTime = want; el.playbackRate = 1; el.play().catch(() => {}); }
      else if (Math.abs(d) > 0.15 || el.seeking) { if (!el.seeking) el.currentTime = want; el.playbackRate = 1; }   // 많이 어긋나면 바로 맞추고
      else el.playbackRate = Math.abs(d) < 0.02 ? 1 : clamp(1 - d * 2, 0.92, 1.08);                                // 조금 어긋나면 빠르기를 살짝 바꿔 소리 끊김 없이 따라가요
    } else {
      if (el && !el.paused) el.pause();
      if (playing && S.t < a.start && a.start - S.t < 1.5) {   // 곧 나올 소리는 미리 불러서 시작 자리에 세워 둬요 (늦게 시작하지 않게)
        if (!el) { el = aEls[a.id] = new Audio(mediaUrl(a.mediaId)); el.preload = 'auto'; }
        if (!el.seeking && Math.abs(el.currentTime - a.in) > 0.05) el.currentTime = a.in;
      }
    }
  }
  for (const id of Object.keys(aEls)) if (!S.audio.some((a) => a.id === id)) { aEls[id].pause(); aEls[id].removeAttribute('src'); delete aEls[id]; }   // 지운 소리는 바로 멈추고 정리해요
}

/* ============ 추가 미디어 (영상·사진 겹치기) ============ */
const pipbox = E('div'); pipbox.id = 'pipbox'; stage.insertBefore(pipbox, $('#tplfg'));
const pipEls = {};
/* ===== 줄마다 자물쇠·눈·소리 끄기 ===== */
S.trk = S.trk || {};
const tf = (k) => S.trk[k] || (S.trk[k] = {});
const trkOfText = (x) => x.kind === 'sub' ? 's' : x.kind === 'pip' ? 'p' : x.kind === 'text' ? 't' : 'k';
const lockedEl = (el) => { const t = el && el.closest && el.closest('.track'); return !!(t && tf(t.id.slice(6)).l); };
/* ===== 레이어 사이 끼워 넣기 (줄이 보이고 거기에 놓으면 새 레이어) ===== */
const KBASE = { bg: 0, pip: 0.5, sticker: 1, shape: 1, fx: 1, zoom: 1, text: 2, sub: 3 };
let dragKind = '';
function normLanes() {   // 같은 줄 묶음(스티커·텍스트·자막·오버레이) 안에서 레이어 번호 정리: 겹치면 새 레이어, 빈 레이어는 없애요
  const out = {}, groups = {};
  S.texts.forEach((x) => { (groups[trkOfText(x)] = groups[trkOfText(x)] || []).push(x); });
  Object.entries(groups).forEach(([k, list]) => {
    const arr = list.map((x) => ({ x, l: x.lane == null ? 0 : +x.lane })).sort((p, q) => p.l - q.l || p.x.start - q.x.start), rows = new Map();
    arr.forEach((o) => { let l = o.l; for (;;) { const L = rows.get(l) || []; if (!L.some((q) => q.x.start < o.x.end - 1e-6 && o.x.start < q.x.end - 1e-6)) { L.push(o); rows.set(l, L); o.l = l; break; } l += 0.5; } });
    const ls = [...new Set(arr.map((o) => o.l))].sort((p, q) => p - q), rk = new Map(ls.map((l, i) => [l, i]));
    arr.forEach((o) => { o.x.lane = rk.get(o.l); }); out[k] = ls.length;
  });
  return out;
}
function laneHit(tr, clientY) {   // 포인터 위치 → 들어갈 레이어(번호)와, 레이어 사이에 가까우면 보여 줄 줄 위치
  const n = +tr.dataset.n || 0; if (!n) return { lane: 0, line: null };
  const r = tr.getBoundingClientRect(), rh = r.height / n, y = clamp(clientY - r.top, 0, r.height), b = Math.round(y / rh);
  if (Math.abs(y - b * rh) <= Math.max(8, rh * 0.22)) return { lane: n - b - 0.5, line: b * rh };
  return { lane: n - 1 - clamp(Math.floor(y / rh), 0, n - 1), line: null };
}
function clearIns() { document.querySelectorAll('.insl').forEach((q) => q.remove()); }
function showIns(tr, y) { clearIns(); if (y == null) return; const d = E('div', 'insl'); d.style.top = y + 'px'; tr.append(d); }
document.addEventListener('dragend', () => { dragKind = ''; clearIns(); });
const TRK_SVG = {
  lock: (on) => `<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="${on ? 'M8 11V8a4 4 0 0 1 8 0v3' : 'M8 11V8a4 4 0 0 1 7.6-1.6'}"/></svg>`,
  hide: (on) => `<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>${on ? '<path d="M3 3l18 18"/>' : ''}</svg>`,
  mute: (on) => `<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9z"/>${on ? '<path d="M16 9l5 6M21 9l-5 6"/>' : '<path d="M16 9a4 4 0 0 1 0 6"/>'}</svg>`,
};
const TRK_BTNS = { k: ['lock', 'hide'], t: ['lock', 'hide'], s: ['lock', 'hide'], p: ['lock', 'hide', 'mute'], v: ['lock', 'hide', 'mute'], a: ['lock', 'mute'] };
const TRK_FLAG = { lock: 'l', hide: 'h', mute: 'm' }, TRK_TIP = { lock: '잠그기', hide: '숨기기', mute: '소리 끄기' };
function refreshTrk() {
  Object.keys(TRK_BTNS).forEach((k) => {
    const f = tf(k), lab = document.querySelector('#tl-labels .lab.' + k), tr = document.getElementById('track-' + k);
    if (tr) { tr.classList.toggle('locked', !!f.l); tr.classList.toggle('hidden-trk', !!f.h); }
    if (!lab) return;
    lab.querySelectorAll('.tb button[data-k]').forEach((b) => { const on = !!f[TRK_FLAG[b.dataset.k]]; b.classList.toggle('on', on); b.innerHTML = TRK_SVG[b.dataset.k](on); b.title = TRK_TIP[b.dataset.k] + (on ? ' 해제' : ''); });
  });
  stage.classList.toggle('vhid', !!tf('v').h);
}
function initTrkButtons() {
  Object.entries(TRK_BTNS).forEach(([k, list]) => {
    const lab = document.querySelector('#tl-labels .lab.' + k); if (!lab || lab.querySelector('.tb')) return;
    const nm = E('span', 'ln', lab.innerHTML); lab.innerHTML = ''; const tb = E('span', 'tb');
    ['lock', 'hide', 'mute'].forEach((kind) => { if (!list.includes(kind)) { const ph = E('button', 'ph'); ph.disabled = true; tb.append(ph); return; } const b = E('button', ''); b.dataset.k = kind; b.onclick = () => {
      const f = tf(k), fl = TRK_FLAG[kind]; f[fl] = !f[fl];
      if (f.l) { if (S.sel && ((k === 'v' && S.sel.type === 'v') || (k === 'a' && S.sel.type === 'a') || (S.sel.type === 't' && (() => { const x = S.texts.find((q) => q.id === S.sel.id); return x && trkOfText(x) === k; })()))) S.sel = null; S.multi = []; }
      refreshTrk(); if (k === 'v') { const c = underPlayhead(); if (c) setGain(c); } renderTL(true); renderOv(true); renderProps(); syncPip(); audioTick(); saveLocal();
    }; tb.append(b); });
    lab.append(nm, tb);
  });
  refreshTrk();
}
initTrkButtons();
const defDur = (m) => m.isImage ? Math.min(5, m.duration) : m.duration;   // 사진은 처음에 5초, 끝을 끌어 늘려요
function addPip(mid, t, px, py, lane) {
  const m = S.media[mid]; if (!m || !m.hasVideo) return;
  push(); layout(); const st = Math.round(clamp(t == null ? S.t : t, 0, 1e9) * 100) / 100, w = 40, asp = (m.height && m.width) ? m.height / m.width : 0.5625;
  const x = { id: nid(), kind: 'pip', mediaId: mid, in: 0, start: st, end: Math.round((st + defDur(m)) * 100) / 100, text: '', x: px == null ? 72 : px, y: py == null ? 28 : py, w, h: Math.round(w * asp * 10) / 10, vol: 100, opacity: 100 }; if (lane != null) x.lane = lane;
  S.texts.push(x); S.sel = { type: 't', id: x.id }; changed(true); seek(st + 0.01, true); toast('추가 미디어로 올렸어요');
}
(function stageDrop() {   // 왼쪽 목록의 영상·사진을 미리보기 화면에 끌어다 놓으면 추가 미디어로 올라가요
  const ours = (e) => [...(e.dataTransfer.types || [])].includes('text/x-vtk');
  stage.addEventListener('dragover', (e) => { if (!ours(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; stage.classList.add('dropping'); });
  stage.addEventListener('dragleave', (e) => { if (!stage.contains(e.relatedTarget)) stage.classList.remove('dropping'); });
  stage.addEventListener('drop', (e) => {
    stage.classList.remove('dropping'); if (!ours(e)) return; e.preventDefault(); e.stopPropagation();
    let p; try { p = JSON.parse(e.dataTransfer.getData('text/x-vtk')); } catch (er) { return; }
    if (p.k !== 'media') return; const m = S.media[p.id]; if (!m || !m.hasVideo) return toast('영상이나 사진만 올릴 수 있어요');
    if (tf('p').l) return toast('추가 미디어 줄이 잠겨 있어요');
    
    const r = stage.getBoundingClientRect(); addPip(m.id, S.t, Math.round(clamp((e.clientX - r.left) / r.width * 100, 0, 100) * 10) / 10, Math.round(clamp((e.clientY - r.top) / r.height * 100, 0, 100) * 10) / 10);
  });
})();
const bgEls = {};
function syncPip() {
  const W = stage.clientWidth, H = stage.clientHeight; if (!W) return;
  S.texts.forEach((x) => {
    if (x.kind !== 'pip') return;
    let el = pipEls[x.id]; const on = S.t >= x.start - 1e-6 && S.t < x.end && !tf('p').h;
    if (!on) { if (el && el.style.display !== 'none') { el.pause(); el.style.display = 'none'; } return; }
    if (!el) { el = pipEls[x.id] = document.createElement('video'); el.playsInline = true; el.preload = 'auto'; el.src = (S.media[x.mediaId] || {}).hasAlpha ? '/media/' + x.mediaId + '?a=1' : mediaUrl(x.mediaId); el.style.cssText = 'position:absolute;object-fit:fill;pointer-events:none'; pipbox.append(el); }
    if (el.style.display !== 'block') el.style.display = 'block';
    const sk = [W, H, x.x, x.y, x.w, x.h, x.lane, x.border, x.bw, x.bc, x.br, x.opacity].join('|');   // 자리·모양이 바뀔 때만 다시 그려요 (재생 중 매 프레임 다시 쓰지 않게)
    if (el._sk !== sk) {
      el._sk = sk;
      const w = x.w / 100 * W, h = x.h / 100 * W;
      el.style.zIndex = (x.lane || 0) + 1; el.style.width = w + 'px'; el.style.height = h + 'px'; el.style.left = (x.x / 100 * W - w / 2) + 'px'; el.style.top = (x.y / 100 * H - h / 2) + 'px';
      // 테두리·둥근 모서리 (내보내기와 같은 계산: 두께는 가로 1080 기준, 둥글기는 짧은 변의 절반 기준 %)
      const bw = x.border ? Math.max(1, +x.bw || 8) * W / 1080 : 0, rad = clamp(+x.br || 0, 0, 100) / 100 * Math.min(w, h) / 2;
      el.style.boxSizing = 'border-box'; el.style.border = bw ? `${bw}px solid ${x.bc || '#ffffff'}` : 'none'; el.style.borderRadius = rad + 'px'; el.style.background = bw ? (x.bc || '#ffffff') : 'transparent';
      el.style.opacity = (x.opacity == null ? 100 : x.opacity) / 100;
    }
    const vol = tf('p').m ? 0 : clamp((x.vol == null ? 100 : x.vol) / 100, 0, 1); if (el.volume !== vol) el.volume = vol;
    const want = (x.in || 0) + (S.t - x.start), drift = Math.abs(el.currentTime - want);
    if (playing && !reverse) { if (el.paused) { try { el.currentTime = want; } catch (e) {} el.play().catch(() => {}); } else if (drift > 0.35) { try { el.currentTime = want; } catch (e) {} } }
    else { if (!el.paused) el.pause(); if (drift > 0.04) { try { el.currentTime = want; } catch (e) {} } }
  });
  S.texts.forEach((x) => {   // 배경(단계 바뀔 때 깔리는 색 화면)
    if (x.kind !== 'bg') return;
    let el = bgEls[x.id]; const on = S.t >= x.start - 1e-6 && S.t < x.end && !tf('k').h;
    if (!on) { if (el) el.style.display = 'none'; return; }
    if (!el) { el = bgEls[x.id] = document.createElement('div'); el.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:0'; pipbox.append(el); }
    el.style.display = 'block'; el.style.background = x.color || '#1f6feb'; el.style.opacity = (x.opacity == null ? 100 : x.opacity) / 100;
  });
  Object.keys(bgEls).forEach((id) => { if (!S.texts.some((q) => q.id === id && q.kind === 'bg')) { bgEls[id].remove(); delete bgEls[id]; } });
  Object.keys(pipEls).forEach((id) => { if (!S.texts.some((q) => q.id === id && q.kind === 'pip')) { pipEls[id].pause(); pipEls[id].remove(); delete pipEls[id]; } });
}
let ttlTxt = '', ttlSmall = null, ttlColor = '#000000';
const CARD_RECS = [{ n: 'STEP 번호 + 제목', col: '#1f6feb', small: 'STEP {n}', title: '' }, { n: '정리하기', col: '#00C48C', small: '정리', title: '' }, { n: '마무리 인사', col: '#ff2d92', small: '', title: '감사합니다' }, { n: '자료 받기', col: '#FFFD00', small: '설명란 또는 고정댓글을 확인해주세요.', title: '자료 받기', low: true }];
const cardFg = (c) => { const h = c.replace('#', ''), l = (parseInt(h.slice(0, 2), 16) * 299 + parseInt(h.slice(2, 4), 16) * 587 + parseInt(h.slice(4, 6), 16) * 114) / 1000; return l > 150 ? '#111111' : '#ffffff'; };
const CARD_SEC = 2.5, CARD_VOL = 60;   // 제목 화면: 기본 2.5초, 시작할 때 효과음(뿅) 볼륨 60%
let cardSfxId = null;
async function cardSfx() {   // 편집기에 들어 있는 '뿅' 효과음을 미디어로 가져와요 (한 번 가져오면 다시 써요)
  if (cardSfxId && S.media[cardSfxId]) return S.media[cardSfxId];
  try {
    const r = await fetch('/api/sfx').then((x) => x.json()), f = (r.files || []).find((x) => /^뽁\.|뿅/.test(x.name || ''));
    if (!f) return null;
    const m = await fetch('/api/sfx/add', { method: 'POST', body: JSON.stringify({ rel: f.rel, hide: true }) }).then((z) => z.json());
    if (m.error) return null; cardSfxId = m.id; return m;
  } catch (e) { return null; }
}
// 제목 화면 넣기: 색 배경은 영상 클립으로(뒤 영상은 밀려요), 글자는 그 위에, 효과음은 시작 위치에
async function insertCard({ color, sec, items }) {
  let bgm = null, sm = null;
  try {
    if (color) { bgm = await fetch('/api/color/add', { method: 'POST', body: JSON.stringify({ color }) }).then((r) => r.json()); if (!bgm || bgm.error) throw new Error((bgm && bgm.error) || '색 배경을 만들지 못했어요'); }
    sm = await cardSfx();
  } catch (e) { return toast('제목 화면을 넣지 못했어요: ' + e.message); }
  layout(); let t0 = Math.round(S.t * 100) / 100;
  if (bgm) { S.media[bgm.id] = bgm; S.pm.delete(bgm.id); const c = addToTimeline(bgm.id, true, { out: sec, fit: 'cover' }); layout(); if (c) t0 = Math.round(c.start * 100) / 100; } else push();
  let last = null;
  items.forEach((o) => { const x = { ...o, id: nid() }; x.start = Math.round((t0 + (o.off || 0)) * 100) / 100; x.end = Math.round((x.start + (o.len || sec)) * 100) / 100; delete x.off; delete x.len; S.texts.push(x); last = x; });
  if (sm) { if (!S.media[sm.id]) S.media[sm.id] = sm; S.audio.push({ id: nid(), mediaId: sm.id, start: t0, in: 0, out: sm.duration, vol: CARD_VOL }); }
  if (last) S.sel = { type: 't', id: last.id };
  changed(true); if (ltab === 'tpl') buildLeft();
}
function addTitleCard(title, small, color, low) {   // 강의 단계가 바뀔 때: 색 배경 + 가운데 제목(+위쪽 작은 글)
  const hx = color.replace('#', ''), lum = (parseInt(hx.slice(0, 2), 16) * 299 + parseInt(hx.slice(2, 4), 16) * 587 + parseInt(hx.slice(4, 6), 16) * 114) / 1000, fg = lum > 150 ? '#111111' : '#ffffff';
  const sample = S.texts.find((t) => t.kind === 'text'), font = sample ? sample.font : ((S.fonts[0] && S.fonts[0].family) || 'sans-serif');
  const mk = (text, size, y) => ({ kind: 'text', off: 0, len: CARD_SEC, text, colors: [], color: fg, font, size, outline: 0, outlineColor: '#000000', x: 50, y });
  const items = []; if (low) { if (title) items.push(mk(title, 120, 42)); if (small) items.push(mk(small, 56, 64)); } else { if (small) items.push(mk(small, 56, 36)); if (title) items.push(mk(title, 120, small ? 52 : 50)); }
  return insertCard({ color, sec: CARD_SEC, items });
}
const CARD_KEY = 'vtk.cards.v1';
const myCards = () => { try { return JSON.parse(localStorage.getItem(CARD_KEY) || '[]'); } catch (e) { return []; } };
const saveMyCards = (l) => { try { localStorage.setItem(CARD_KEY, JSON.stringify(l)); } catch (e) {} };
function saveCard(name) {   // 지금 고른 제목 화면(배경 클립 + 글자)을 내 템플릿으로 저장
  const s = getSel(); if (!s) return toast('저장할 제목 화면(색 배경이나 글자)을 타임라인에서 먼저 눌러 주세요');
  const isColorClip = s.type === 'v' && (S.media[s.c.mediaId] || {}).color;
  if (!isColorClip && !(s.type === 't' && ['bg', 'text'].includes(s.c.kind))) return toast('저장할 제목 화면(색 배경이나 글자)을 타임라인에서 먼저 눌러 주세요');
  layout(); let a, b;
  if (isColorClip) { a = s.c.start; b = s.c.start + dur(s.c); } else { a = s.c.start; b = s.c.end; }
  const clip = S.clips.find((c) => (S.media[c.mediaId] || {}).color && c.start < b - 1e-6 && a < c.start + dur(c) - 1e-6);
  const its = S.texts.filter((x) => (x.kind === 'bg' || x.kind === 'text') && x.start < b - 1e-6 && a < x.end - 1e-6);
  if (!clip && !its.length) return toast('저장할 제목 화면을 찾지 못했어요');
  const base = clip ? clip.start : Math.min(...its.map((x) => x.start));
  const items = its.map((x) => { const o = JSON.parse(JSON.stringify(x)); o.off = Math.round((x.start - base) * 100) / 100; o.len = Math.round((x.end - x.start) * 100) / 100; ['id', 'start', 'end'].forEach((k) => delete o[k]); return o; });
  if (clip) items.unshift({ kind: 'bg', color: S.media[clip.mediaId].color, off: 0, len: Math.round(dur(clip) * 100) / 100, opacity: 100 });
  const l = myCards().filter((c) => c.n !== name); l.push({ n: name, items }); saveMyCards(l); toast('내 제목 화면으로 저장했어요');
}
function addCard(c) {
  const ti = ttlTxt.trim(), texts = c.items.filter((x) => x.kind !== 'bg'), big = texts.filter((x) => x.kind === 'text').sort((p, q) => (q.size || 0) - (p.size || 0))[0], bg = c.items.find((x) => x.kind === 'bg');
  const items = texts.map((o) => { const x = JSON.parse(JSON.stringify(o)); if (ti && o === big) x.text = ti; return x; });
  const sec = bg ? (bg.len || CARD_SEC) : (Math.max(...texts.map((x) => x.len || CARD_SEC), CARD_SEC));
  return insertCard({ color: bg ? bg.color : null, sec, items });
}
function renderBgProps(p, x) {
  const upd = () => { renderTL(true); renderOv(true); syncPip(); saveLocal(); };
  p.append(E('div', 'sel-title', '배경'));
  p.append(sec('색'));
  const w = E('div', 'colorline'); w.append(colorPicker('배경 색', () => x.color || '#1f6feb', (v, once) => { if (once) pushOnce('bgc' + x.id); else push(); x.color = v; upd(); })); p.append(w);
  p.append(slider('진하기', 0, 100, 1, x.opacity == null ? 100 : x.opacity, (v) => v + '%', (v) => { x.opacity = v; upd(); }, 100));
  p.append(sec('나오는 시간'));
  const r2 = E('div', 'row2');
  r2.append(timeBox('시작', x.start, (t) => { push(); const len = x.end - x.start; x.start = Math.max(0, t); x.end = x.start + len; changed(true); }), timeBox('끝', x.end, (t) => { push(); x.end = Math.max(x.start + 0.1, t); changed(true); }));
  p.append(r2);
  const br = E('div', 'btnrow'); const b2 = E('button', 'danger', '🗑 삭제'); b2.onclick = del; br.append(b2); p.append(br);
}
function renderPipProps(p, x) {
  const m = S.media[x.mediaId] || {}, asp = (m.height && m.width) ? m.height / m.width : x.h / Math.max(0.1, x.w);
  const upd = () => { renderTL(true); renderOv(true); syncPip(); saveLocal(); };
  p.append(E('div', 'sel-title', esc(m.name || '추가 미디어')));
  attrBar(p);
  mgPropsSec(p, x, false);
  p.append(sec('크기·위치'));
  p.append(slider('너비', 5, 200, 0.5, x.w, (v) => v + '%', (v) => { x.w = v; x.h = Math.round(v * asp * 10) / 10; upd(); }, 40));
  p.append(slider('가로 위치', 0, 100, 0.5, x.x, (v) => v + '%', (v) => { x.x = v; upd(); }, 72));
  p.append(slider('세로 위치', 0, 100, 0.5, x.y, (v) => v + '%', (v) => { x.y = v; upd(); }, 28));
  p.append(slider('불투명도', 0, 100, 1, x.opacity == null ? 100 : x.opacity, (v) => v + '%', (v) => { x.opacity = v; upd(); }, 100));
  p.append(sec('테두리'));
  const bch = chips([[0, '없음'], [1, '테두리']], x.border ? 1 : 0, (v) => { push(); x.border = !!v; if (x.border && !x.bw) x.bw = 8; renderProps(); upd(); }); bch.classList.add('slim'); p.append(bch);
  if (x.border) {
    const bc = E('div', 'colorline'); bc.append(colorPicker('테두리 색', () => x.bc || '#ffffff', (v, once) => { if (once) pushOnce('pbc' + x.id); else push(); x.bc = v; upd(); })); p.append(bc);
    p.append(slider('두께', 1, 40, 1, x.bw || 8, (v) => v, (v) => { x.bw = v; upd(); }, 8));
  }
  p.append(slider('모서리 둥글기', 0, 100, 1, x.br || 0, (v) => v + '%', (v) => { x.br = v; upd(); }, 0));
  if (m.hasAudio) { p.append(sec('소리')); p.append(slider('음량', 0, 200, 1, x.vol == null ? 100 : x.vol, (v) => v + '%', (v) => { x.vol = v; upd(); }, 100)); }
  p.append(sec('나오는 시간'));
  const r2 = E('div', 'row2');
  r2.append(timeBox('시작', x.start, (t) => { push(); const len = x.end - x.start; x.start = Math.max(0, t); x.end = x.start + len; changed(true); }), timeBox('끝', x.end, (t) => { push(); x.end = clamp(t, x.start + 0.1, x.start + Math.max(0.1, (m.duration || 1e9) - (x.in || 0))); changed(true); }));
  p.append(r2);
  const br = E('div', 'btnrow'); const sw = E('button', '', '🔁 바꾸기'); sw.title = '자리와 시간은 그대로 두고 다른 영상·사진으로 바꿔요'; sw.onclick = () => swapMedia(x); const b2 = E('button', 'danger', '🗑 삭제'); b2.onclick = del; br.append(sw, b2); p.append(br);
}

/* ============ 미리보기 변형 ============ */
let vGeo = null;
function updateStage() {
  const wrap = $('#stage-wrap'); const r = canvasRatio();
  const ww = wrap.clientWidth - 16, wh = wrap.clientHeight - 16;
  let sw = ww, sh = ww / r; if (sh > wh) { sh = wh; sw = wh * r; }
  stage.style.width = Math.max(10, sw) + 'px'; stage.style.height = Math.max(10, sh) + 'px';
  const tp = tplOn(), th = tp ? sh * (tp.top || 0) / 100 : 0, bh = tp ? sh * (tp.bottom || 0) / 100 : 0, vb = $('#vbox'), tb = $('#tplbg');
  tb.style.display = tp ? 'block' : 'none';
  const tf = $('#tplfg'); tf.style.display = tp ? 'block' : 'none';
  if (tp) {   // 색 값은 글자 그대로 넣지 않고 스타일로만 넣어요 (받은 .dsp 안의 이상한 값이 화면에서 실행되지 않게)
    const bar = (css, c) => { const i = document.createElement('i'); i.style.cssText = css; i.style.background = /^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : '#000000'; return i; };
    tb.replaceChildren(bar('inset:0', tp.midColor)); tf.replaceChildren(bar(`top:0;height:${+th || 0}px`, tp.topColor), bar(`bottom:0;height:${+bh || 0}px`, tp.botColor));
  }
  const fm = !!(tp && tp.fitMid); vb.style.top = (fm ? th : 0) + 'px'; vb.style.height = (fm ? sh - th - bh : sh) + 'px';
  const boxH = fm ? sh - th - bh : sh, fullH = sh;
  const c = cur; if (!c || !video.videoWidth) { vGeo = null; renderOv(true); return; }
  const vw = video.videoWidth, vh = video.videoHeight, rot = ((c.rot || 0) % 360 + 360) % 360;
  const m = S.media[c.mediaId] || {}, cr = cropRectC(c, m), kx = vw / (m.width || vw), ky = vh / (m.height || vh);
  let cx = 0, cy = 0, cw = vw, ch = vh; if (cr) { cw = cr.w * kx; ch = cr.h * ky; cx = cr.x * kx; cy = cr.y * ky; }
  video.style.clipPath = cr ? `inset(${cy}px ${vw - cx - cw}px ${vh - cy - ch}px ${cx}px)` : 'none';
  const dx = cx + cw / 2 - vw / 2, dy = cy + ch / 2 - vh / 2;
  const rw = rot % 180 ? ch : cw, rh = rot % 180 ? cw : ch;
  const base = c.fit === 'cover' ? Math.max(sw / rw, boxH / rh) : Math.min(sw / rw, boxH / rh);
  const sc = base * (c.scale / 100);
  video.style.width = vw + 'px'; video.style.height = vh + 'px'; video.style.left = (sw - vw) / 2 + 'px'; video.style.top = (boxH - vh) / 2 + 'px';
  video.style.transform = `translate(${c.x / 100 * sw}px,${c.y / 100 * fullH}px) scaleX(${c.flip ? -1 : 1}) rotate(${rot}deg) scale(${sc}) translate(${-dx}px,${-dy}px)`;
  vGeo = { cx: sw / 2 + c.x / 100 * sw, cy: boxH / 2 + c.y / 100 * fullH, w: rw * sc, h: rh * sc, sw, sh: fullH };
  renderOv(true);
}
video.addEventListener('loadedmetadata', updateStage);
window.addEventListener('resize', () => { updateStage(); renderTL(); });
(function fullPreview() {
  const pl = $('#player'), btn = $('#btn-full');
  const toggle = () => { if (document.fullscreenElement) document.exitFullscreen(); else if (pl.requestFullscreen) pl.requestFullscreen().catch(() => toast('전체 화면으로 바꿀 수 없어요')); };
  btn.onclick = toggle;
  document.addEventListener('fullscreenchange', () => { const on = document.fullscreenElement === pl; document.body.classList.toggle('pfull', on); btn.textContent = on ? '🗗' : '⛶'; setTimeout(updateStage, 50); setTimeout(updateStage, 300); });
  document.addEventListener('keydown', (e) => { if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || '')) && !e.target.isContentEditable) { e.preventDefault(); toggle(); } });
})();


/* ============ 배경 블러 / 글자 미리보기 / 폰트 ============ */
const bgc = $('#bgc'), ov = $('#ov');
function drawBg() {
  const on = S.bg === 'blur' && !tplOn(); bgc.style.display = on ? 'block' : 'none';
  if (!on || !cur || !video.videoWidth || !stage.clientWidth) return;
  const w = 64, h = Math.max(8, Math.round(64 * stage.clientHeight / stage.clientWidth)); if (bgc.width !== w || bgc.height !== h) { bgc.width = w; bgc.height = h; }
  const m = S.media[cur.mediaId] || {}, cr = cropRectC(cur, m), vw = video.videoWidth, vh = video.videoHeight;
  let sx = 0, sy = 0, sw = vw, sh = vh; if (cr) { const kx = vw / m.width, ky = vh / m.height; sx = cr.x * kx; sy = cr.y * ky; sw = cr.w * kx; sh = cr.h * ky; }
  const k = Math.max(w / sw, h / sh), dw = sw * k, dh = sh * k;
  try { bgc.getContext('2d').drawImage(video, sx, sy, sw, sh, (w - dw) / 2, (h - dh) / 2, dw, dh); } catch (e) {}
}
let bgSig = '';
(function bgLoop() {   // 흐림 배경은 재생 중이거나 화면이 바뀌었을 때만 다시 그려요 (멈춰 있을 때 컴퓨터가 쉬도록)
  const sig = S.bg + '|' + tplOn() + '|' + (cur ? cur.mediaId + ':' + cur.crop + ':' + cur.cropPos : '') + '|' + video.currentTime + '|' + video.videoWidth + '|' + stage.clientWidth + 'x' + stage.clientHeight;
  if (playing || reverse || sig !== bgSig) { bgSig = sig; drawBg(); }
  requestAnimationFrame(bgLoop);
})();

const activeTexts = () => S.texts.filter((x) => S.t >= x.start - 1e-6 && S.t < x.end && !tf(trkOfText(x)).h);
let ovKey = '';
function renderOv(force) { if (!renderOv0(force)) return; [...ov.children].forEach((el) => { const x = S.texts.find((q) => q.id === el.dataset.id); if (x) el.style.zIndex = (KBASE[x.kind] ?? 1) * 100 + (x.lane || 0) + 1; }); }
function renderOv0(force) {
  const list = activeTexts(); const W = stage.clientWidth || 1, k = W / 1080;
  const key = W + '|' + (S.sel && S.sel.type === 't' ? S.sel.id : '') + '|' + JSON.stringify(list);
  if (!force && key === ovKey) return false; ovKey = key; ov.innerHTML = ''; setTimeout(syncPip, 0);
  list.forEach((x) => {
    if (x.kind === 'bg') return;
    const d = E('div', 'ovt' + (x.kind === 'sticker' ? ' stk' : '') + (isSel('t', x.id) ? ' sel' : '')); d.dataset.id = x.id;
    if (x.kind === 'sticker') {
      d.style.left = x.x + '%'; d.style.top = x.y + '%'; d.style.width = (x.scale || 30) + '%'; d.style.transform = `translate(-50%,-50%) rotate(${x.rot || 0}deg)`;
      const im = E('img'); im.src = '/api/sticker/file?n=' + encodeURIComponent(x.sid); im.draggable = false; d.append(im); ov.append(d); return;
    }
    if (x.kind === 'pip') {   // 겹친 영상: 화면에는 진짜 영상이 따로 떠 있고, 여기는 잡고 끄는 자리만 둬요
      d.classList.add('pipov'); d.style.left = x.x + '%'; d.style.top = x.y + '%'; d.style.width = (x.w / 100 * W) + 'px'; d.style.height = (x.h / 100 * W) + 'px'; ov.append(d); return;
    }
    if (x.kind === 'zoom') {   // 확대 효과: 선택했을 때만 '확대 중심' 표시(끌어서 옮겨요)
      if (isSel('t', x.id)) { d.classList.add('zmk'); d.style.left = x.x + '%'; d.style.top = x.y + '%'; d.textContent = '🔍'; ov.append(d); }
      return;
    }
    if (x.kind === 'fx') {
      d.classList.add('fxb', x.mode === 'blur' ? 'fxblur' : 'fxmos'); d.style.left = x.x + '%'; d.style.top = x.y + '%'; d.style.width = (x.w / 100 * W) + 'px'; d.style.height = (x.h / 100 * W) + 'px';
      d.style.setProperty('--fxb', Math.max(2, (x.level || 50) / 100 * 16 * (W / 540)) + 'px'); d.append(E('span', 'fxlab', x.mode === 'blur' ? '블러' : '모자이크')); ov.append(d); return;
    }
    if (x.kind === 'shape') {
      d.classList.add('shp'); d.style.left = x.x + '%'; d.style.top = x.y + '%'; d.style.opacity = (x.opacity == null ? 100 : x.opacity) / 100;
      const cv = drawShape(x, W); cv.style.width = cv.width + 'px'; cv.style.height = cv.height + 'px'; cv.style.display = 'block'; cv.style.pointerEvents = 'none'; d.append(cv); ov.append(d);
      if (x.mv && isSel('t', x.id)) { const g = E('div', 'ovt mvg sel'); g.dataset.id = x.id; g.dataset.end = '1'; g.style.left = (x.x2 == null ? x.x : x.x2) + '%'; g.style.top = (x.y2 == null ? x.y : x.y2) + '%'; g.textContent = '도착'; ov.append(g); }
      return;
    }
    d.style.left = x.x + '%'; d.style.top = x.y + '%'; d.style.fontFamily = `"${x.font}", sans-serif`; d.style.fontSize = x.size * k + 'px';
    d.style.webkitTextStroke = (x.outline * 2 * k) + 'px ' + (x.outlineColor || '#000');
    String(x.text).split('\n').forEach((ln, i) => { const l = E('div', 'ovl'); l.textContent = ln || ' '; l.style.color = (x.colors && x.colors[i]) || x.color || '#fff';
      if (x.box) { const hx = /^#?([0-9a-f]{6})$/i.exec(x.boxColor || '#000000'), h = hx ? hx[1] : '000000', op = (x.boxOpacity == null ? 70 : x.boxOpacity) / 100; l.style.background = `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${op})`; l.style.display = 'table'; const pd = x.size * 0.16 * k; l.style.margin = (-pd) + 'px auto'; l.style.padding = pd + 'px ' + (pd + x.size * 0.5 * k) + 'px'; l.style.boxSizing = 'content-box'; if (x.boxRadius) l.style.borderRadius = (x.boxRadius / 100 * (x.size * 1.2 * k + 2 * pd) / 2) + 'px'; }
      d.append(l); });
    if (x.box) { d.style.display = 'flex'; d.style.flexDirection = 'column'; d.style.alignItems = 'center'; }
    ov.append(d);
  });
  return true;
}
/* 가이드 선: 끌다가 가운데·가장자리에 가까워지면 붙으면서 분홍 선이 나와요 */
const snapG = E('div'); snapG.id = 'snapg'; stage.append(snapG);
function showGuides(xs, ys) {
  snapG.innerHTML = '';
  (xs || []).forEach((x) => { const l = E('div', 'sgl v'); l.style.left = x + 'px'; snapG.append(l); });
  (ys || []).forEach((y) => { const l = E('div', 'sgl h'); l.style.top = y + 'px'; snapG.append(l); });
}
function snap1(pos, size, total, thr) {
  let best = null;
  [[pos - size / 2, 0], [pos, total / 2], [pos + size / 2, total]].forEach(([a, t]) => { const d = t - a; if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line: t }; });
  return best;
}
const smooth01 = (u) => { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); };
function moveTick() {   // 움직이는 도형(포인터 이동): 지금 시간에 맞는 자리로
  S.texts.forEach((x) => {
    if (x.kind !== 'shape' || !x.mv || x.x2 == null) return;
    const el = ov.querySelector(`[data-id="${x.id}"]:not([data-end])`); if (!el || (ovDrag && ovDrag.x === x)) return;
    const u = smooth01((S.t - x.start) / Math.max(0.05, x.mvDur || 1));
    el.style.left = (x.x + (x.x2 - x.x) * u) + '%'; el.style.top = (x.y + (x.y2 - x.y) * u) + '%';
  });
}
let ovDrag = null;
ov.addEventListener('pointerdown', (e) => {
  const d = e.target.closest('.ovt'); if (!d) return; const x = S.texts.find((t) => t.id === d.dataset.id); if (!x || tf(trkOfText(x)).l) return;
  if (!isSel('t', x.id)) select('t', x.id);
  const isEnd = !!d.dataset.end, kx = isEnd ? 'x2' : 'x', ky = isEnd ? 'y2' : 'y';
  const el = ov.querySelector(`[data-id="${x.id}"]${isEnd ? '[data-end]' : ':not([data-end])'}`) || d;
  ovDrag = { x, el, kx, ky, x0: e.clientX, y0: e.clientY, px: x[kx], py: x[ky], pushed: false }; el.setPointerCapture(e.pointerId); e.preventDefault();
});
ov.addEventListener('pointermove', (e) => {
  if (!ovDrag) return; const dx = e.clientX - ovDrag.x0, dy = e.clientY - ovDrag.y0; if (!ovDrag.pushed && Math.hypot(dx, dy) < 3) return;
  if (!ovDrag.pushed) { push(); ovDrag.pushed = true; }
  const x = ovDrag.x, W = stage.clientWidth, H = stage.clientHeight;
  let nx = ovDrag.px + dx / W * 100, ny = ovDrag.py + dy / H * 100;
  const ew = ovDrag.el.offsetWidth, eh = ovDrag.el.offsetHeight, thr = 6;
  const sx = e.altKey ? null : snap1(nx / 100 * W, ew, W, thr), sy = e.altKey ? null : snap1(ny / 100 * H, eh, H, thr);
  if (sx) nx += sx.d / W * 100; if (sy) ny += sy.d / H * 100;
  x[ovDrag.kx] = Math.round(clamp(nx, 0, 100) * 10) / 10; x[ovDrag.ky] = Math.round(clamp(ny, 0, 100) * 10) / 10;
  ovDrag.el.style.left = x[ovDrag.kx] + '%'; ovDrag.el.style.top = x[ovDrag.ky] + '%';
  showGuides(sx && [sx.line], sy && [sy.line]);
});
ov.addEventListener('pointerup', () => { showGuides(); if (!ovDrag) return; const d = ovDrag; ovDrag = null; if (d.pushed) { changed(true); } });
ov.addEventListener('dblclick', () => { const t = propsEl.querySelector('textarea'); if (t) { t.focus(); t.select(); } });

async function loadFonts(selectFamily) {
  try { S.fonts = await fetch('/api/fonts').then((r) => r.json()); } catch (e) { S.fonts = []; }
  await Promise.all(S.fonts.map(async (f) => { if (f._ok) return; try { const ff = new FontFace(f.family, `url("${f.url}")`); await ff.load(); document.fonts.add(ff); f._ok = true; } catch (e) {} }));
  renderOv(true); if (S.sel && S.sel.type === 't') renderProps();
}
async function addFontFile(file) {
  if (!file) return; if (!/\.(ttf|otf)$/i.test(file.name)) return toast('TTF 또는 OTF 폰트 파일을 골라 주세요');
  try {
    const r = await fetch('/api/font?name=' + encodeURIComponent(file.name), { method: 'POST', body: file }).then((r) => r.json()); if (r.error) throw new Error(r.error);
    await loadFonts(); const s = getSel();
    if (s && s.type === 't') { push(); s.c.font = r.added; changed(true); } toast('폰트 추가 완료: ' + r.added);
  } catch (e) { toast('폰트 추가 실패: ' + e.message); }
}
$('#font-input').onchange = (e) => { addFontFile(e.target.files[0]); e.target.value = ''; };

function addText(kind) {
  push(); const isT = kind === 'text'; layout();
  const x = { id: nid(), kind, start: Math.round(S.t * 100) / 100, end: Math.round((S.t + (isT ? 3 : 2)) * 100) / 100, text: isT ? '새 텍스트' : '자막을 입력하세요', colors: [], color: '#ffffff',
    font: (S.fonts[0] && S.fonts[0].family) || 'sans-serif', size: isT ? 90 : 86, outline: 8, outlineColor: '#000000', x: 50, y: isT ? 42 : 81 };
  const sample = S.texts.find((t) => t.kind === kind); if (sample) Object.assign(x, { font: sample.font, size: sample.size, outline: sample.outline, outlineColor: sample.outlineColor, color: sample.color });
  S.texts.push(x); S.sel = { type: 't', id: x.id }; changed(true);
  setTimeout(() => { const t = propsEl.querySelector('textarea'); if (t) { t.focus(); t.select(); } }, 30);
}

function addSticker(st) {
  push(); layout();
  const x = { id: nid(), kind: 'sticker', sid: st.id, name: st.name, start: Math.round(S.t * 100) / 100, end: Math.round((S.t + 3) * 100) / 100, text: '', scale: st.builtin ? 80 : 30, rot: 0, x: 50, y: st.builtin ? 37 : 40 };
  S.texts.push(x); S.sel = { type: 't', id: x.id }; changed(true);
}
function renderStickerProps(p, x) {
  const upd = () => { renderTL(); renderOv(true); saveLocal(); };
  p.append(E('div', 'sel-title', `스티커${x.name ? `<small>${esc(x.name)}</small>` : ''}`));
  p.append(sec('크기·회전'));
  p.append(slider('크기 (화면 가로 대비)', 2, 150, 1, x.scale || 30, (v) => v + '%', (v) => { x.scale = v; upd(); }, 30));
  p.append(slider('회전', -180, 180, 1, x.rot || 0, (v) => v + '°', (v) => { x.rot = v; upd(); }, 0));
  p.append(sec('위치 (화면 가운데 기준)'));
  p.append(slider('가로', 0, 100, 0.5, x.x, (v) => v + '%', (v) => { x.x = v; upd(); }, 50));
  p.append(slider('세로', 0, 100, 0.5, x.y, (v) => v + '%', (v) => { x.y = v; upd(); }, 40));
  p.append(sec('나오는 시간'));
  const r2 = E('div', 'row2');
  r2.append(timeBox('시작', x.start, (t) => { push(); x.start = clamp(t, 0, x.end - 0.1); changed(true); }), timeBox('끝', x.end, (t) => { push(); x.end = Math.max(x.start + 0.1, t); changed(true); }));
  p.append(r2);
}

/* ============ 타임라인 렌더 ============ */
function loadPeaks(id) {
  if (peaks[id] !== undefined) return; peaks[id] = null;
  fetch('/api/peaks/' + id).then((r) => r.json()).then((a) => { peaks[id] = a; renderTL(); }).catch(() => { peaks[id] = []; });
}
const waveCache = new Map(); let waveBytes = 0;   // 같은 모양의 소리 그림은 한 번만 그려요 (타임라인을 다시 그릴 때 버벅임 방지)
function drawWave(cv, mid, tin, tout, color) {
  const pk = peaks[mid]; if (pk === undefined) { loadPeaks(mid); return; } if (!pk || !pk.length) return;
  const w = Math.min(4000, Math.max(1, Math.round(parseFloat(cv.dataset.w) || cv.clientWidth || 1))), h = 40;
  cv.width = w; cv.height = h; const g = cv.getContext('2d');
  const key = mid + '|' + tin.toFixed(2) + '|' + tout.toFixed(2) + '|' + w + '|' + color, hit = waveCache.get(key);
  if (hit) { g.drawImage(hit, 0, 0); return; }
  g.fillStyle = color; const span = tout - tin; g.beginPath();
  for (let x = 0; x < w; x++) {
    const a = Math.floor((tin + x / w * span) * 10), b = Math.max(a + 1, Math.floor((tin + (x + 1) / w * span) * 10));
    let mx = 0; for (let i = a; i < b && i < pk.length; i++) if (pk[i] > mx) mx = pk[i];
    const v = Math.sqrt(mx / 255) * h * 0.5; g.rect(x, h / 2 - v, 1, Math.max(1, v * 2));
  }
  g.fill();
  const oc = document.createElement('canvas'); oc.width = w; oc.height = h; oc.getContext('2d').drawImage(cv, 0, 0);
  waveCache.set(key, oc); waveBytes += w * h * 4;
  while (waveBytes > 64 * 1024 * 1024 && waveCache.size) { const k = waveCache.keys().next().value, o = waveCache.get(k); waveBytes -= o.width * o.height * 4; waveCache.delete(k); }
}
function stepFor() { const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600]; return steps.find((s) => s * S.zoom >= 80) || 3600; }
let tlSkip = 0;   // 0 = 전부 다시 그림, 1 = 영상 줄은 그대로(소리를 끌 때), 2 = 영상·소리 줄은 그대로(글자를 끌 때)
function renderTL(skip) { tlSkip = skip === true ? 2 : (+skip || 0); try { renderTL0(); } finally { tlSkip = 0; } if (typeof markMulti === 'function' && S.multi && S.multi.length) markMulti(); }
function renderTL0() {
  layout();
  const aEnd = Math.max(0, ...S.audio.map((a) => a.start + a.out - a.in));
  const len = Math.max(S.total, aEnd);
  const width = Math.max(len * S.zoom + 260, tlScroll.clientWidth - 2);
  inner.style.width = width + 'px';
  // 눈금
  ruler.innerHTML = ''; const step = stepFor();
  for (let i = 0; i * step * S.zoom < width; i++) {
    const t = Math.round(i * step * 1000) / 1000;
    const tk = E('div', 'tick', fmt(t, step < 1 ? 1 : 0)); tk.style.left = t * S.zoom + 'px'; ruler.append(tk);
    const sub = E('div', 'tick minor'); sub.style.left = (t + step / 2) * S.zoom + 'px'; ruler.append(sub);
  }
  // 영상 트랙 (끄는 것과 상관없는 줄은 다시 그리지 않아요 — 버벅임 방지)
  if (tlSkip < 1) {
  // 영상 트랙
  trackV.innerHTML = '';
  S.clips.forEach((c) => {
    const m = S.media[c.mediaId] || {};
    const d = E('div', 'clip' + (isSel('v', c.id) ? ' sel' : ''));
    d.dataset.id = c.id; d.style.left = c.start * S.zoom + 'px'; d.style.width = Math.max(5, dur(c) * S.zoom) + 'px';
    if (m.thumb) d.style.backgroundImage = `url(/api/thumb/${m.id})`;
    d.innerHTML = `<i class="h l" data-h="l"></i><i class="h r" data-h="r"></i><span class="cl-name">${esc(m.name || '?')}${c.speed !== 1 ? ' · ' + c.speed + 'x' : ''}${c.rev ? ' · ⏪' : ''}${c.mute ? ' · 🔇' : ''}</span>`;
    const cv = E('canvas', 'wf'); cv.dataset.w = Math.max(5, dur(c) * S.zoom); d.append(cv); trackV.append(d);
    if (!c.mute && m.hasAudio) drawWave(cv, c.mediaId, c.in, c.out, 'rgba(120,235,225,.85)');
  });
  }
  // 추가 소리 트랙
  if (tlSkip < 2) {
  trackA.innerHTML = '';
  S.audio.forEach((a) => {
    const m = S.media[a.mediaId] || {};
    const d = E('div', 'aclip' + (isSel('a', a.id) ? ' sel' : ''));
    d.dataset.id = a.id; d.style.left = a.start * S.zoom + 'px'; d.style.width = Math.max(5, (a.out - a.in) * S.zoom) + 'px';
    d.innerHTML = `<i class="h l" data-h="l"></i><i class="h r" data-h="r"></i><span class="cl-name">${esc(m.name || '?')}</span>`;
    const cv = E('canvas', 'wf'); cv.dataset.w = Math.max(5, (a.out - a.in) * S.zoom); d.append(cv); trackA.append(d);
    drawWave(cv, a.mediaId, a.in, a.out, 'rgba(210,195,255,.9)');
  });
  }
  const NL = normLanes();
  [['text', trackT], ['sticker', trackK], ['sub', trackS], ['pip', trackP]].forEach(([kind, tr]) => {
    tr.innerHTML = '';
    S.texts.filter((x) => x.kind === kind || (kind === 'sticker' && (x.kind === 'shape' || x.kind === 'fx' || x.kind === 'zoom' || x.kind === 'bg'))).forEach((x) => {
      const d = E('div', 'tclip ' + kind + (isSel('t', x.id) ? ' sel' : '')); d.dataset.id = x.id;
      d.style.left = x.start * S.zoom + 'px'; d.style.width = Math.max(6, (x.end - x.start) * S.zoom) + 'px'; if (x.kind === 'bg') { d.style.background = x.color || '#1f6feb'; d.style.borderColor = 'rgba(255,255,255,.35)'; }
      d.innerHTML = `<i class="h l" data-h="l"></i><i class="h r" data-h="r"></i><span class="cl-name">${esc(kind === 'pip' ? ((S.media[x.mediaId] || {}).name || '영상') : kind === 'sticker' ? x.name || (x.kind === 'bg' ? '배경' : x.kind === 'shape' ? (SHAPE_NAMES[x.shape] || '도형') : x.kind === 'fx' ? (x.mode === 'blur' ? '블러' : '모자이크') : x.kind === 'zoom' ? '확대 ' + (x.scale || 150) + '%' : '스티커') : String(x.text).replace(/\n/g, ' '))}</span>`; if (kind === 'pip') { const pm = S.media[x.mediaId]; if (pm && pm.thumb) d.style.backgroundImage = `url(/api/thumb/${pm.id})`; } tr.append(d);
    });
    // 같은 시간에 겹치는 항목은 줄을 나눠서 위아래로 쌓아요
    const items = [...tr.children].map((el) => { const x = S.texts.find((q) => q.id === el.dataset.id); return { el, x }; }).filter((o) => o.x).sort((p, q) => p.x.start - q.x.start || p.x.end - q.x.end);
    const nL = NL[({ text: 't', sticker: 'k', sub: 's', pip: 'p' })[kind]] || 0;
    items.forEach((o) => { o.el.style.top = `calc(${5 + (nL - 1 - o.x.lane) * 40}px * var(--rs, 1))`; o.el.style.bottom = 'auto'; o.el.style.height = 'calc(30px * var(--rs, 1))'; });
    const lanes = Math.max(1, nL), lab = document.querySelector('#tl-labels .lab.' + ({ text: 't', sticker: 'k', sub: 's', pip: 'p' })[kind]); tr.dataset.n = nL;
    tr.dataset.lanes = lanes; const hh = `calc(${lanes * 40}px * var(--rs, 1))`; tr.style.height = hh; if (lab) lab.style.height = hh;
  });
  const tEnd = Math.max(0, ...S.texts.map((x) => x.end)); if (tEnd * S.zoom + 260 > inner.clientWidth) inner.style.width = tEnd * S.zoom + 260 + 'px';
  fitRows(); updatePlayhead(); refreshTrk();
  $('#t-zoom').value = S.zoom;
}
/* 타임라인 창을 키우면 줄(영상·소리·글자…)도 같이 커져요 */
function fitRows() {
  const sc = $('#tl-scroll'), tl = $('#timeline'); if (!sc || !tl) return;
  const lanes = (id) => +(($(id) || {}).dataset || {}).lanes || 1;
  const natural = 26 + 84 + 50 + (lanes('#track-t') + lanes('#track-k') + lanes('#track-s') + lanes('#track-p')) * 40 + 6;
  const rs = Math.max(0.62, Math.min(2.6, sc.clientHeight / natural));
  const cur = parseFloat(tl.style.getPropertyValue('--rs')) || 1; if (Math.abs(cur - rs) > 0.005) tl.style.setProperty('--rs', rs.toFixed(3));
}
(() => { const sc = $('#tl-scroll'); if (sc && window.ResizeObserver) new ResizeObserver(() => fitRows()).observe(sc); addEventListener('resize', () => fitRows()); })();
function updatePlayhead() {
  ph.style.left = S.t * S.zoom + 'px';
  renderOv(); moveTick(); applyTrans(); $('#tcur').textContent = fmt(S.t); $('#ttot').textContent = '/ ' + fmt(S.total);
  if (playing) {
    const x = S.t * S.zoom, l = tlScroll.scrollLeft, w = tlScroll.clientWidth;
    if (x > l + w - 40) tlScroll.scrollLeft = x - 60; else if (x < l) tlScroll.scrollLeft = Math.max(0, x - 60);
  }
}
function updatePlayBtn() { $('#btn-play').textContent = playing ? '⏸' : '▶'; }
function updateUI() { updatePlayhead(); updatePlayBtn(); applyTrans(); }

/* ============ 변경 반영 / 자동 저장 ============ */
function changed(noPush) {
  layout(); renderTL(); renderMedia(); renderProps();
  $('#empty').style.display = S.clips.length ? 'none' : 'grid';
  $('#sel-canvas').value = S.canvas;
  $('#t-undo').disabled = !hist.length; $('#t-redo').disabled = !redoSt.length;
  const hasSel = !!getSel(); ['#t-del'].forEach((q) => { $(q).disabled = !hasSel; });
  if (!S.clips.length) { cur = null; video.style.display = 'none'; video.removeAttribute('src'); delete video.dataset.mid; pause(); S.t = 0; updateUI(); }
  else seek(Math.min(S.t, S.total), true).then(updateStage);
  saveLocal();
}

/* ============ 편집 명령 ============ */
function underPlayhead() {
  const s = getSel();
  if (s && s.type === 'v' && S.t >= s.c.start && S.t <= s.c.start + dur(s.c)) return s.c;
  const l = locate(S.t); return l ? l.c : null;
}
function splitClip(c, t) {
  const rel = t - c.start; if (rel < 0.03 || dur(c) - rel < 0.03) return false;
  const cut = c.in + rel * c.speed, i = S.clips.indexOf(c);
  const right = { ...c, id: nid(), in: cut }; c.out = cut;
  S.clips.splice(i + 1, 0, right); return right;
}
function splitAudio(a, t) {
  const rel = t - a.start; if (rel < 0.03 || (a.out - a.in) - rel < 0.03) return false;
  const cut = a.in + rel, i = S.audio.indexOf(a);
  const right = { ...a, id: nid(), in: cut, start: t }; a.out = cut;
  S.audio.splice(i + 1, 0, right); return right;
}
function splitSubAt(x, pos, mid, focusNew) {
  const t = String(x.text), a = t.slice(0, pos).replace(/\s+$/, ''), b = t.slice(pos).replace(/^\s+/, '');
  if (!a || !b) return null; if (mid <= x.start + 0.05 || mid >= x.end - 0.05) return null;
  push(); const n = JSON.parse(JSON.stringify(x)); n.id = nid(); n.text = b; n.start = mid; n.colors = []; x.text = a; x.end = mid; x.colors = [];
  S.texts.push(n); S.sel = { type: 't', id: n.id }; changed(true); return n;
}
function mergeSubs(prev, cur) {
  push(); const joint = String(prev.text).length; prev.text = String(prev.text) + ' ' + String(cur.text); prev.end = Math.max(prev.end, cur.end); prev.colors = [];
  S.texts = S.texts.filter((q) => q.id !== cur.id); S.sel = { type: 't', id: prev.id }; changed(true); return joint + 1;
}
function focusSub(id, pos) { setTimeout(() => { const t = document.querySelector(`#props textarea[data-id="${id}"]`); if (t) { t.focus(); t.setSelectionRange(pos, pos); t.scrollIntoView({ block: 'nearest' }); } }, 0); }
function subRow(x, list) {
  const r = E('div', 'titem subrow' + (isSel('t', x.id) ? ' sel' : '')); r.dataset.id = x.id;
  const tm = E('span', 'tm', fmt(x.start, 1)); tm.onclick = () => { select('t', x.id); pause(); seek(x.start + 0.01); };
  const ta = E('textarea', 'tx'); ta.rows = 1; ta.value = x.text; ta.dataset.id = x.id; ta.spellcheck = false;
  const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  ta.onfocus = () => { if (isSel('t', x.id)) return; S.sel = { type: 't', id: x.id }; if (S.t < x.start || S.t >= x.end) seek(x.start + 0.01, true); renderTL(); renderOv(true); $('#t-del').disabled = false; document.querySelectorAll('#props .titem').forEach((q) => q.classList.toggle('sel', q.dataset.id === x.id)); };
  ta.oninput = () => { pushOnce('sl' + x.id); x.text = ta.value; x.colors = []; fit(); renderTL(); renderOv(true); saveLocal(); };
  ta.onblur = () => {};
  ta.onkeydown = (e) => {
    e.stopPropagation();
    const subs = () => S.texts.filter((q) => q.kind === 'sub').sort((p, q) => p.start - q.start);
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault(); const pos = ta.selectionStart, len = ta.value.length; x.text = ta.value;
      const mid = Math.round((x.start + (x.end - x.start) * clamp(pos / Math.max(1, len), 0.12, 0.88)) * 10) / 10;
      const n = splitSubAt(x, pos, mid); if (n) focusSub(n.id, 0); else toast('글자 중간에서 Enter를 누르면 둘로 나눠져요');
    } else if (e.key === 'Backspace' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
      const l = subs(), i = l.findIndex((q) => q.id === x.id); if (i > 0) { e.preventDefault(); const pos = mergeSubs(l[i - 1], x); focusSub(l[i - 1].id, pos); }
    } else if (e.key === 'Delete' && ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length) {
      const l = subs(), i = l.findIndex((q) => q.id === x.id); if (i >= 0 && i < l.length - 1) { e.preventDefault(); const pos = mergeSubs(x, l[i + 1]); focusSub(x.id, pos - 1); }
    }
  };
  r.append(tm, ta); setTimeout(fit, 0); return r;
}
function splitCmd() {
  layout(); const s = getSel();
  { const x = S.sel && S.sel.type === 't' ? S.texts.find((q) => q.id === S.sel.id) : null;
    if (x) { if (!splitTextAt(x, S.t)) toast('재생 막대를 이 클립 안쪽으로 옮겨 주세요'); return; } }
  if (s && s.type === 'a' && S.t > s.c.start && S.t < s.c.start + s.c.out - s.c.in) { push(); const r = splitAudio(s.c, S.t); if (r) { S.sel = { type: 'a', id: r.id }; changed(); } return; }
  const c = underPlayhead(); if (!c) return toast('먼저 영상을 가져오세요');
  push(); const r = splitClip(c, S.t);
  if (!r) { hist.pop(); return toast('컷 경계에서는 자를 수 없어요. 재생 막대를 클립 안쪽으로 옮겨 주세요'); }
  S.sel = { type: 'v', id: r.id }; changed();
}
function splitAll() {
  layout(); push(); let any = false; const c = underPlayhead();
  if (c && splitClip(c, S.t)) any = true;
  for (const a of [...S.audio]) if (splitAudio(a, S.t)) any = true;
  if (!any) { hist.pop(); return toast('자를 위치가 없습니다'); } changed();
}
function splitTextAt(x, t) {
  if (!(t > x.start + 0.1 && t < x.end - 0.1)) return false;
  if (x.kind === 'sub' || x.kind === 'text') {
    const tx = String(x.text), ratio = (t - x.start) / (x.end - x.start); let pos = Math.round(tx.length * ratio); const sp = tx.lastIndexOf(' ', pos); if (sp > 0 && pos - sp < 8) pos = sp;
    return !!splitSubAt(x, clamp(pos, 1, Math.max(1, tx.length - 1)), Math.round(t * 10) / 10);
  }
  push(); const y = JSON.parse(JSON.stringify(x)); y.id = nid(); y.start = Math.round(t * 100) / 100; if (x.kind === 'pip') y.in = Math.round(((x.in || 0) + (y.start - x.start)) * 100) / 100; x.end = y.start; S.texts.push(y); S.sel = { type: 't', id: y.id }; changed(true); return true;
}
function splitAt(type, item, t) {
  layout(); push();
  const r = type === 'v' ? splitClip(item, t) : splitAudio(item, t);
  if (!r) { hist.pop(); return; } S.t = t; changed();
}
function trimLeft() {
  layout(); const c = underPlayhead(); if (!c) return;
  const rel = S.t - c.start; if (rel <= 0.03) return toast('재생 막대를 클립 안쪽으로 옮겨 주세요');
  push(); const a0 = c.start; c.in = c.in + rel * c.speed; S.t = c.start; S.sel = { type: 'v', id: c.id }; rippleRange(a0, a0 + rel); changed();
}
function trimRight() {
  layout(); const c = underPlayhead(); if (!c) return;
  const rel = S.t - c.start; if (dur(c) - rel <= 0.03) return toast('재생 막대를 클립 안쪽으로 옮겨 주세요');
  push(); const od = dur(c), a0 = c.start; c.out = c.in + rel * c.speed; S.sel = { type: 'v', id: c.id }; rippleRange(a0 + rel, a0 + od); changed();
}
function del() {
  if (S.multi && S.multi.length > 1) {
    push(); const has = (t, id) => inMulti(t, id);
    S.texts = S.texts.filter((q) => !has('t', q.id)); S.audio = S.audio.filter((q) => !has('a', q.id)); S.clips = S.clips.filter((q) => !has('v', q.id));
    S.multi = []; S.sel = null; layout(); S.t = Math.min(S.t, S.total); changed(); return;
  }
  const s = getSel(); if (!s) return toast('삭제할 클립을 먼저 선택하세요');
  push();
  if (s.type === 'v') { const t0 = s.c.start, od = dur(s.c); rippleRange(t0, t0 + od); S.clips = S.clips.filter((x) => x !== s.c); S.t = Math.min(t0, Math.max(0, S.clips.reduce((a, c) => a + dur(c), 0))); }
  else if (s.type === 't') S.texts = S.texts.filter((x) => x !== s.c);
  else S.audio = S.audio.filter((x) => x !== s.c);
  S.sel = null; changed();
}
let clip = null;
function copy() { const s = getSel(); if (!s) return; clip = { type: s.type, c: JSON.parse(JSON.stringify(s.c)) }; toast('복사했어요 (Ctrl+V로 붙여넣기)'); }
function paste() {
  if (!clip) return; push();
  if (clip.type === 'v') { const l = locate(S.t), i = l ? l.i + 1 : S.clips.length; const c = { ...clip.c, id: nid() }; S.clips.splice(i, 0, c); S.sel = { type: 'v', id: c.id }; }
  else if (clip.type === 't') { const len = clip.c.end - clip.c.start; const x = { ...JSON.parse(JSON.stringify(clip.c)), id: nid(), start: S.t, end: S.t + len }; S.texts.push(x); S.sel = { type: 't', id: x.id }; }
  else { const a = { ...clip.c, id: nid(), start: S.t }; S.audio.push(a); S.sel = { type: 'a', id: a.id }; }
  changed();
}
let attrClip = null;
const ATTR = { v: ['vol', 'mute', 'speed', 'fit', 'scale', 'x', 'y', 'rot', 'flip', 'rev', 'crop', 'cropPos'], t: ['font', 'size', 'outline', 'outlineColor', 'color', 'colors', 'x', 'y', 'box', 'boxColor', 'boxOpacity', 'boxRadius'], a: ['vol'], p: ['w', 'h', 'x', 'y', 'opacity', 'vol'] };
const akey = (type, c) => type === 't' && c.kind === 'pip' ? 'p' : type;
const imgDurOf = (type, c) => { const m = S.media[c.mediaId]; if (!m || !m.isImage) return null; return type === 'v' ? c.out - c.in : type === 'p' ? c.end - c.start : null; };
const putDur = (type, c, d) => { if (d == null || imgDurOf(type, c) == null) return; d = Math.round(d * 100) / 100; if (type === 'v') c.out = c.in + d; else c.end = Math.round((c.start + d) * 100) / 100; };
function copyAttr() {
  const s = getSel(); if (!s) return toast('속성을 복사할 클립이나 글자를 먼저 선택하세요');
  const ak = akey(s.type, s.c); attrClip = { type: ak, v: JSON.parse(JSON.stringify(Object.fromEntries(ATTR[ak].map((k) => [k, s.c[k]])))), dur: imgDurOf(ak, s.c) };
  toast('속성을 복사했어요 · 아래 클립들을 드래그로 묶고 [속성 붙여넣기]');
}
const attrPick = (type, c) => JSON.parse(JSON.stringify(Object.fromEntries(ATTR[type].map((k) => [k, c[k]]))));
const attrPut = (c, v) => Object.entries(JSON.parse(JSON.stringify(v))).forEach(([k, x]) => { if (x === undefined) delete c[k]; else c[k] = x; });
function multiItems() { return (S.multi || []).map((m) => { const l = m.type === 'v' ? S.clips : m.type === 't' ? S.texts : S.audio; const c = l.find((q) => q.id === m.id); return c ? { type: akey(m.type, c), c } : null; }).filter(Boolean); }
function pasteAttr() {
  if (!attrClip) return toast('먼저 [속성 복사]를 눌러 주세요');
  const mi = S.multi && S.multi.length > 1 ? multiItems() : null;
  if (mi) {
    const L = mi.filter((x) => x.type === attrClip.type); if (!L.length) return toast('같은 종류가 선택되지 않았어요 (영상↔영상, 글자↔글자)');
    push(); L.forEach((x) => { attrPut(x.c, attrClip.v); putDur(x.type, x.c, attrClip.dur); }); changed(true); return toast(L.length + '개에 속성을 붙여넣었어요');
  }
  const s = getSel(); if (!s) return toast('붙여넣을 클립이나 글자를 선택하세요');
  if (akey(s.type, s.c) !== attrClip.type) return toast('같은 종류끼리만 붙여넣을 수 있어요 (영상↔영상, 글자↔글자)');
  push(); attrPut(s.c, attrClip.v); putDur(attrClip.type, s.c, attrClip.dur);
  changed(true); toast('속성을 붙여넣었어요');
}
function applyAll() {
  const s = getSel(); let type, v, kind;
  if (s) { type = akey(s.type, s.c); v = attrPick(type, s.c); kind = s.c.kind; } else if (attrClip) { type = attrClip.type; v = attrClip.v; } else return toast('적용할 클립을 먼저 선택하세요');
  const list = type === 'v' ? S.clips : type === 'p' ? S.texts.filter((q) => q.kind === 'pip') : type === 't' ? S.texts.filter((q) => q.kind !== 'pip' && (!s || q.kind === kind)) : S.audio;
  if (list.length < 2 && s) return toast('적용할 다른 클립이 없어요');
  push(); list.forEach((c) => attrPut(c, v)); changed(true); toast(list.length + '개 전체에 적용했어요 (되돌리기: Ctrl+Z)');
}
function volStep(d) { const s = getSel(); if (!s || s.type === 't') return; pushOnce('vol'); s.c.vol = clamp((s.c.vol === undefined ? 100 : s.c.vol) + d, 0, 200); changed(); toast('음량 ' + s.c.vol + '%', null, 900); }
function select(type, id) {
  S.sel = type ? { type, id } : null;
  if (type === 't') { const x = S.texts.find((t) => t.id === id); if (x && (S.t < x.start || S.t >= x.end)) seek(x.start + 0.01, true); }
  if (type === 't') { const x = S.texts.find((t) => t.id === id); if (x && x.kind === 'sub') rtab = 'sub'; }   // 자막 클립을 누르면 오른쪽 자막 목록에서 그 줄로 이동
  renderTL(); renderProps(); renderOv(true); $('#t-del').disabled = !S.sel;
  if (type === 't' && rtab === 'sub') setTimeout(() => { const r = document.querySelector(`#props .subrow[data-id="${id}"]`); if (r) r.scrollIntoView({ block: 'center' }); }, 0);
  if (ltab === 'text' || ltab === 'stk' || ltab === 'tpl') buildLeft();
}
function addToTimeline(mid, atHead, over) {
  const m = S.media[mid]; if (!m) return null; push(); let made = null;
  if (m.hasVideo) {
    const c = { id: nid(), mediaId: mid, in: 0, out: defDur(m), ...dflt(), fit: (S.clips[0] && S.clips[0].fit) || 'contain', ...(over || {}) }; made = c;
    if (atHead && S.clips.length) {   // 재생 막대가 있는 곳에 끼워 넣어요 (클립 가운데면 둘로 나눠서)
      layout(); const t = S.t; let idx = S.clips.length;
      for (let i = 0; i < S.clips.length; i++) { const k = S.clips[i], e = k.start + dur(k); if (t < k.start + 0.03) { idx = i; break; } if (t < e - 0.03) { splitClip(k, t); idx = i + 1; break; } }
      layout(); const at = idx < S.clips.length ? S.clips[idx].start : S.total; S.clips.splice(idx, 0, c); layout(); rippleAfter(at, dur(c)); S.sel = { type: 'v', id: c.id }; changed(); seek(c.start + 0.01, true); return made;
    }
    S.clips.push(c);
  }
  else { S.audio.push({ id: nid(), mediaId: mid, start: S.t, in: 0, out: m.duration, vol: 100 }); }
  changed(); return made;
}
function setCanvas(v) { push(); S.canvas = v; oriSel = null; changed(); }

/* ============ 줌 / 스크롤 ============ */
function setZoom(z, anchor) {
  const old = S.zoom; S.zoom = clamp(z, 2, 400);
  const a = anchor === undefined ? S.t : anchor; const off = a * old - tlScroll.scrollLeft;
  renderTL(); tlScroll.scrollLeft = a * S.zoom - off;
}
const zoomBy = (f) => setZoom(S.zoom * f);
function fitAll() { layout(); if (!S.total) return; S.zoom = clamp((tlScroll.clientWidth - 80) / S.total, 2, 400); renderTL(); tlScroll.scrollLeft = 0; }
tlScroll.addEventListener('wheel', (e) => {
  if (e.ctrlKey) { e.preventDefault(); const r = inner.getBoundingClientRect(); setZoom(S.zoom * (e.deltaY < 0 ? 1.15 : 0.87), (e.clientX - r.left) / S.zoom); }
  else if (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {   // 트랙이 많아 세로로 넘치면 휠은 세로 스크롤, 안 넘치면 가로로 움직여요 (가로는 Shift+휠)
    if (tlScroll.scrollHeight > tlScroll.clientHeight + 1) return;
    tlScroll.scrollLeft += e.deltaY; e.preventDefault();
  }
}, { passive: false });

/* ============ 타임라인 마우스 조작 ============ */
let drag = null;
const OPT = (() => { try { return Object.assign({ snap: true, magnet: true }, JSON.parse(localStorage.getItem('vtk.opt.v1') || '{}')); } catch (e) { return { snap: true, magnet: true }; } })();
const snapPts = (skipId) => [0, S.t, ...S.clips.map((c) => c.start), S.total, ...S.audio.filter((a) => a.id !== skipId).flatMap((a) => [a.start, a.start + a.out - a.in]), ...S.texts.filter((x) => x.id !== skipId).flatMap((x) => [x.start, x.end])];
OPT.link = Object.assign({ on: true, text: true, fx: true, sticker: true, pip: true, audio: true }, OPT.link || {});
const linkKind = (x) => x.kind === 'fx' || x.kind === 'zoom' ? 'fx' : x.kind === 'sticker' || x.kind === 'shape' || x.kind === 'bg' ? 'sticker' : x.kind === 'pip' ? 'pip' : 'text';
const isLinked = (x) => !!(OPT.link.on && OPT.link[linkKind(x)]);   // 연결 설정에서 고른 종류만 메인 클립을 따라가요
const audioLinked = () => !!(OPT.link.on && OPT.link.audio);
const saveOpt = () => { try { localStorage.setItem('vtk.opt.v1', JSON.stringify(OPT)); } catch (e) {} };
let snapGuide = null;
const snapT = (t, skipId) => { if (!OPT.snap) return t; let best = t, bd = 8 / S.zoom, hit = null; for (const p of snapPts(skipId)) if (Math.abs(p - t) < bd) { bd = Math.abs(p - t); best = p; hit = p; } if (hit !== null) snapGuide = hit; return best; };
const snapLine = () => { const g = $('#snap-line'); if (snapGuide === null) g.style.display = 'none'; else { g.style.display = 'block'; g.style.left = snapGuide * S.zoom + 'px'; } snapGuide = null; };
// 마그넷: 메인 영상 길이가 바뀌면 그 뒤에 있는 자막·텍스트·스티커·소리도 같이 이동
// 구간 [a,b) 이 잘려 나갈 때, 다른 칸(자막·글자·스티커·소리)도 같이 자르고 뒤쪽은 당겨 와요 (마그넷)
function rippleRange(a, b) {
  if (!OPT.magnet || b - a < 1e-4) return; const L = b - a, r2 = (v) => Math.round(v * 100) / 100, E1 = 1e-3;
  S.texts = S.texts.filter((x) => {
    const s0 = x.start, e0 = x.end;
    if (!isLinked(x)) return true;
    if (e0 <= a + E1) return true;
    if (s0 >= b - E1) { x.start = r2(Math.max(0, s0 - L)); x.end = r2(e0 - L); return true; }
    if (s0 >= a - E1 && e0 <= b + E1) return false;
    if (s0 < a && e0 > b) { x.end = r2(e0 - L); return true; }
    if (s0 < a) { x.end = r2(a); return x.end - x.start >= 0.05; }
    x.start = r2(a); x.end = r2(e0 - L); return x.end - x.start >= 0.05;
  });
  S.audio = S.audio.filter((q) => {
    const s0 = q.start, e0 = q.start + (q.out - q.in);
    if (!audioLinked()) return true;
    if (e0 <= a + E1) return true;
    if (s0 >= b - E1) { q.start = Math.max(0, s0 - L); return true; }
    if (s0 >= a - E1 && e0 <= b + E1) return false;
    if (s0 < a && e0 > b) { q.out -= L; return true; }
    if (s0 < a) { q.out = q.in + (a - s0); return q.out - q.in >= 0.05; }
    q.in += (b - s0); q.start = a; return q.out - q.in >= 0.05;
  });
}
function rippleAfter(at, delta) {
  if (!OPT.magnet || Math.abs(delta) < 1e-4) return;
  S.texts.forEach((x) => { if (isLinked(x) && x.start >= at - 1e-3) { const l = x.end - x.start; x.start = Math.max(0, Math.round((x.start + delta) * 100) / 100); x.end = x.start + l; } });
  S.audio.forEach((a) => { if (audioLinked() && a.start >= at - 1e-3) a.start = Math.max(0, a.start + delta); });
}
function wireOpt(id, key) { const b = $(id); const sync = () => b.classList.toggle('on', !!OPT[key]); sync(); b.onclick = () => { OPT[key] = !OPT[key]; sync(); try { localStorage.setItem('vtk.opt.v1', JSON.stringify(OPT)); } catch (e) {} toast((key === 'snap' ? '자동 스냅 ' : '마그넷 ') + (OPT[key] ? '켬' : '끔')); }; }
wireOpt('#t-snap', 'snap'); wireOpt('#t-magnet', 'magnet');
(() => {   // 🔗 연결: 켜 두면 고른 종류(글자·효과·스티커·추가 미디어·소리)가 메인 클립을 따라 움직이고 지워져요
  const b = $('#t-link'), mn = $('#t-linkset'); if (!b) return;
  const sync = () => b.classList.toggle('on', !!OPT.link.on);
  sync(); b.onclick = () => { OPT.link.on = !OPT.link.on; sync(); saveOpt(); toast(OPT.link.on ? '연결을 켰어요 — 설정한 종류가 영상을 따라가요' : '연결을 껐어요 — 영상을 지워도 자막·소리가 제자리에 남아요'); };
  mn.onclick = () => {
    const d = E('div', 'dlg', '<h2>연결 설정</h2>'), g = E('div', 'linkgrid'), ks = [['text', '🅣', '텍스트·자막'], ['fx', '✨', '효과 (블러·확대)'], ['sticker', '🖼', '스티커·도형'], ['pip', '⧉', '추가 미디어'], ['audio', '🎵', '소리']], boxes = {};
    ks.forEach(([k, ic, nm]) => { const l = E('label', 'linkitem'), c = E('input'); c.type = 'checkbox'; c.checked = !!OPT.link[k]; boxes[k] = c; l.append(c, E('span', '', `${ic} ${nm}`)); g.append(l); });
    const all = E('label', 'linkitem linkall'), ac = E('input'); ac.type = 'checkbox'; ac.checked = ks.every(([k]) => OPT.link[k]); all.append(ac, E('span', '', '모두 선택'));
    ac.onchange = () => ks.forEach(([k]) => { boxes[k].checked = ac.checked; });
    const act = E('div', 'acts'), ok = E('button', 'primary', '완료'), no = E('button', '', '취소');
    ok.onclick = () => { ks.forEach(([k]) => { OPT.link[k] = boxes[k].checked; }); saveOpt(); closeModal(); };
    no.onclick = closeModal; act.append(no, ok); d.append(g, all, act); openModal(d);
  };
})();
S.multi = [];
const inMulti = (type, id) => S.multi.some((m) => m.type === type && m.id === id);
function markMulti() { document.querySelectorAll('#tl-inner .clip,#tl-inner .aclip,#tl-inner .tclip').forEach((el) => { const type = el.classList.contains('clip') ? 'v' : el.classList.contains('aclip') ? 'a' : 't'; el.classList.toggle('msel', inMulti(type, el.dataset.id)); }); }
tlScroll.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  { const el = e.target.closest('.clip,.aclip,.tclip'); if (el) {
      const type = el.classList.contains('clip') ? 'v' : el.classList.contains('aclip') ? 'a' : 't';
      if (e.shiftKey || e.ctrlKey || e.metaKey) { const cur = getSel(); if (cur && !S.multi.length) S.multi = [{ type: cur.type, id: cur.c.id }]; const i = S.multi.findIndex((m) => m.type === type && m.id === el.dataset.id); if (i >= 0) S.multi.splice(i, 1); else S.multi.push({ type, id: el.dataset.id }); S.sel = null; renderProps(); markMulti(); return; }
      if (S.multi.length > 1 && inMulti(type, el.dataset.id) && !S.splitMode) {
        const items = S.multi.map((m) => (m.type === 't' ? S.texts : m.type === 'a' ? S.audio : null)).map((l, i) => l && l.find((q) => q.id === S.multi[i].id)).filter(Boolean);
        drag = { kind: 'mmove', x0: e.clientX, items: items.map((q) => ({ q, s0: q.start, e0: q.end })), pushed: false }; tlScroll.setPointerCapture(e.pointerId); return;
      }
      if (S.multi.length) { S.multi = []; markMulti(); }
  } }
  const rect = inner.getBoundingClientRect(); const tAt = (x) => (x - rect.left) / S.zoom;
  const cd = e.target.closest('.clip'), ad = e.target.closest('.aclip'), td = e.target.closest('.tclip');
  if ((cd && lockedEl(cd)) || (ad && lockedEl(ad)) || (td && lockedEl(td))) return toast('잠긴 줄이에요. 왼쪽 자물쇠를 누르면 풀려요');
  if (td) {
    const x = S.texts.find((q) => q.id === td.dataset.id); if (!x) return;
    if (S.splitMode) { if (!splitTextAt(x, tAt(e.clientX))) toast('클립 안쪽을 눌러 주세요'); return; }
    select('t', x.id);
    drag = { kind: e.target.dataset.h ? 'tt' + e.target.dataset.h : 'tmove', x, x0: e.clientX, y0: e.clientY, s0: x.start, e0: x.end, in0: x.in || 0, pushed: false };
  } else if (cd) {
    const c = S.clips.find((x) => x.id === cd.dataset.id); if (!c) return;
    if (S.splitMode) return splitAt('v', c, tAt(e.clientX));
    select('v', c.id);
    drag = { kind: e.target.dataset.h ? 'trim' + e.target.dataset.h : 'move', dur0: dur(c), c, el: (document.querySelector(`#track-v .clip[data-id="${c.id}"]`) || cd), x0: e.clientX, y0: e.clientY, in0: c.in, out0: c.out, pushed: false, moved: false, idx: S.clips.indexOf(c) };
  } else if (ad) {
    const a = S.audio.find((x) => x.id === ad.dataset.id); if (!a) return;
    if (S.splitMode) return splitAt('a', a, tAt(e.clientX));
    select('a', a.id);
    drag = { kind: e.target.dataset.h ? 'atrim' + e.target.dataset.h : 'amove', a, x0: e.clientX, in0: a.in, out0: a.out, st0: a.start, pushed: false };
  } else {
    if (S.multi.length) { S.multi = []; markMulti(); }
    if (e.target.closest('#ruler')) { if (playing) pause(); drag = { kind: 'scrub' }; seek(tAt(e.clientX)); }
    else { if (S.sel) select(null); drag = { kind: 'marq', x0: e.clientX, y0: e.clientY, moved: false }; }
  }
  tlScroll.setPointerCapture(e.pointerId);
});
tlScroll.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const rect = inner.getBoundingClientRect(); const dx = e.clientX - drag.x0;
  const need = () => { if (!drag.pushed) { push(); drag.pushed = true; } };
  if (drag.kind === 'scrub') { let tt = clamp((e.clientX - rect.left) / S.zoom, 0, S.total || 1e9); if (OPT.snap) { let bd = 9 / S.zoom, hit = null; for (const p of [0, S.total, ...snapPts().filter((q) => q !== S.t)]) if (Math.abs(p - tt) < bd) { bd = Math.abs(p - tt); hit = p; } if (hit !== null) { tt = hit; snapGuide = hit; } } seek(tt); snapLine(); }
  else if (drag.kind === 'marq') {
    if (!drag.moved && Math.abs(dx) < 4 && Math.abs(e.clientY - drag.y0) < 4) return; drag.moved = true;
    let mq = $('#marq'); if (!mq) { mq = E('div'); mq.id = 'marq'; inner.append(mq); }
    const x1 = Math.min(drag.x0, e.clientX), x2 = Math.max(drag.x0, e.clientX), y1 = Math.min(drag.y0, e.clientY), y2 = Math.max(drag.y0, e.clientY);
    mq.style.left = (x1 - rect.left) + 'px'; mq.style.top = (y1 - rect.top) + 'px'; mq.style.width = (x2 - x1) + 'px'; mq.style.height = (y2 - y1) + 'px';
    S.multi = []; document.querySelectorAll('#tl-inner .clip,#tl-inner .aclip,#tl-inner .tclip').forEach((el) => { const r = el.getBoundingClientRect(); if (!lockedEl(el) && r.right >= x1 && r.left <= x2 && r.bottom >= y1 && r.top <= y2) S.multi.push({ type: el.classList.contains('clip') ? 'v' : el.classList.contains('aclip') ? 'a' : 't', id: el.dataset.id }); });
    markMulti();
  } else if (drag.kind === 'mmove') {
    if (Math.abs(dx) < 2 && !drag.pushed) return; need(); const mn = Math.min(...drag.items.map((i) => i.s0)); const dt = Math.max(-mn, dx / S.zoom);
    drag.items.forEach((i) => { i.q.start = Math.round((i.s0 + dt) * 100) / 100; if (i.e0 !== undefined) i.q.end = Math.round((i.e0 + dt) * 100) / 100; }); renderTL(); markMulti();
  }
  else if (drag.kind === 'trimr') {
    if (Math.abs(dx) < 1 && !drag.pushed) return; need(); const c = drag.c, m = S.media[c.mediaId];
    c.out = clamp(drag.out0 + dx / S.zoom * c.speed, c.in + 0.05, m.duration); layout(); renderTL(); seek(c.start + dur(c) - 0.02, true);
  } else if (drag.kind === 'triml') {
    if (Math.abs(dx) < 1 && !drag.pushed) return; need(); const c = drag.c;
    c.in = clamp(drag.in0 + dx / S.zoom * c.speed, 0, c.out - 0.05); layout(); renderTL(); seek(c.start + 0.001, true);
  } else if (drag.kind === 'move') {
    if (!drag.moved && Math.abs(dx) < 5) return; drag.moved = true;
    if (!drag.ph) { drag.ph = E('div', 'clip-ph'); drag.ph.style.left = drag.el.style.left; drag.ph.style.width = drag.el.style.width; drag.el.parentNode.append(drag.ph); }
    const dy = clamp(e.clientY - drag.y0, -46, 46);
    drag.el.classList.add('dragging'); drag.el.style.transform = `translate(${dx}px, ${dy * 0.6 - 6}px)`;
    { const r = tlScroll.getBoundingClientRect(); drag.scr = e.clientX > r.right - 60 ? 18 : e.clientX < r.left + 90 ? -18 : 0; if (drag.scr && !drag.raf) { const tick = () => { if (!drag || !drag.scr) { if (drag) drag.raf = 0; return; } tlScroll.scrollLeft += drag.scr; drag.x0 -= drag.scr; drag.raf = requestAnimationFrame(tick); }; drag.raf = requestAnimationFrame(tick); } }
    const centre = drag.c.start + dur(drag.c) / 2 + dx / S.zoom; let idx = 0, edge = 0;
    for (const c of S.clips) { if (c === drag.c) continue; if (c.start + dur(c) / 2 < centre) { idx++; edge = c.start + dur(c); } }
    drag.target = idx; const dl = $('#drop-line'); dl.style.display = 'block'; dl.style.top = $('#track-v').offsetTop + 'px'; dl.style.left = edge * S.zoom - 1 + 'px';
  } else if (drag.kind === 'tmove') {
    if (Math.abs(dx) < 2 && !drag.pushed) return; need(); const x = drag.x, len = drag.e0 - drag.s0;
    let st = Math.max(0, drag.s0 + dx / S.zoom); const s1 = snapT(st, x.id), s2 = snapT(st + len, x.id) - len; st = Math.abs(s1 - st) <= Math.abs(s2 - st) ? s1 : s2; x.start = Math.max(0, Math.round(st * 100) / 100); x.end = x.start + len;
    const own = $('#track-' + trkOfText(x)); let hit = null;
    if (own && Math.abs(e.clientY - drag.y0) > 8) { hit = laneHit(own, e.clientY); if (hit.lane !== x.lane) x.lane = hit.lane; }
    renderTL(true); renderOv(true); snapLine(); if (hit) showIns(own, hit.line);
  } else if (drag.kind === 'ttr') {
    if (Math.abs(dx) < 1 && !drag.pushed) return; need(); const x = drag.x; x.end = Math.round(Math.max(x.start + 0.1, snapT(drag.e0 + dx / S.zoom, x.id)) * 100) / 100; if (x.kind === 'pip') { const pm = S.media[x.mediaId]; if (pm && pm.duration && !pm.isImage && !(pm.mg && x.mg)) x.end = Math.min(x.end, Math.round((x.start + pm.duration - (x.in || 0)) * 100) / 100); } renderTL(true); renderOv(true); snapLine();
  } else if (drag.kind === 'ttl') {
    if (Math.abs(dx) < 1 && !drag.pushed) return; need(); const x = drag.x; let ns = clamp(snapT(drag.s0 + dx / S.zoom, x.id), 0, x.end - 0.1); const pmI = x.kind === 'pip' && (S.media[x.mediaId] || {}).isImage; if (x.kind === 'pip' && !pmI) ns = Math.max(ns, drag.s0 - drag.in0); x.start = Math.round(ns * 100) / 100; if (x.kind === 'pip' && !pmI) x.in = Math.max(0, Math.round((drag.in0 + (x.start - drag.s0)) * 100) / 100); renderTL(true); renderOv(true); snapLine();
  } else if (drag.kind === 'amove') {
    if (Math.abs(dx) < 2 && !drag.pushed) return; need(); const a = drag.a;
    const len = a.out - a.in; let st = Math.max(0, drag.st0 + dx / S.zoom);
    const s1 = snapT(st, a.id), s2 = snapT(st + len, a.id) - len; st = Math.abs(s1 - st) <= Math.abs(s2 - st) ? s1 : s2; a.start = Math.max(0, st); renderTL(1); snapLine();
  } else if (drag.kind === 'atrimr') {
    if (Math.abs(dx) < 1 && !drag.pushed) return; need(); const a = drag.a, m = S.media[a.mediaId];
    a.out = clamp(snapT(a.start + (drag.out0 + dx / S.zoom - a.in), a.id) - a.start + a.in, a.in + 0.05, m.duration); renderTL(1); snapLine();
  } else if (drag.kind === 'atriml') {
    if (Math.abs(dx) < 1 && !drag.pushed) return; need(); const a = drag.a;
    const ni = clamp(drag.in0 + dx / S.zoom, 0, a.out - 0.05); a.start = drag.st0 + (ni - drag.in0); a.in = ni; renderTL(1);
  }
});
const endDrag = () => {
  clearIns(); if (!drag) return; const d = drag; drag = null; if (d.pushed && d.x && d.x.mg && d.x.kind === 'pip' && /^tt[rl]$/.test(d.kind)) setTimeout(() => mgRefit(d.x), 0); $('#drop-line').style.display = 'none'; $('#snap-line').style.display = 'none';
  if (d.kind === 'marq') { const mq = $('#marq'); if (mq) mq.remove(); if (!d.moved) { const rc = inner.getBoundingClientRect(); seek(clamp((d.x0 - rc.left) / S.zoom, 0, S.total || 1e9)); } else { renderProps(); toast(S.multi.length ? `${S.multi.length}개 선택했어요 · 끌면 같이 움직이고 Delete로 지워요` : '선택된 게 없어요', null, 2500); } return; }
  if (d.kind === 'mmove') { if (d.pushed) { changed(true); markMulti(); } return; }
  if ((d.kind === 'trimr' || d.kind === 'triml') && d.pushed && d.dur0 !== undefined) { layout(); const nd = dur(d.c) - d.dur0; if (nd >= 0) rippleAfter(d.c.start + d.dur0, nd); else if (d.kind === 'trimr') rippleRange(d.c.start + dur(d.c), d.c.start + d.dur0); else rippleRange(d.c.start, d.c.start - nd); }
  if (d.kind === 'move' && d.moved) {
    d.el.style.transform = ''; d.el.classList.remove('dragging'); if (d.ph) d.ph.remove(); if (d.raf) cancelAnimationFrame(d.raf);
    if (d.target !== undefined && d.target !== d.idx) {
      push(); layout();
      // 마그넷: 자막·텍스트·스티커·소리는 자기가 시작하던 클립을 따라 같이 이동
      const own = new Map(); const ownerOf = (t) => S.clips.find((c) => t >= c.start - 1e-3 && t < c.start + dur(c) - 1e-3);
      if (OPT.magnet) { [...S.texts.filter(isLinked), ...(audioLinked() ? S.audio : [])].forEach((x) => { const c = ownerOf(x.start); if (c) own.set(x, { c, off: x.start - c.start }); }); }
      S.clips.splice(d.idx, 1); S.clips.splice(d.target, 0, d.c); layout();
      own.forEach((v, x) => { const ns = Math.round((v.c.start + v.off) * 100) / 100; if (x.end !== undefined) { const l = x.end - x.start; x.start = ns; x.end = ns + l; } else x.start = ns; });
      changed();
    } else renderTL();
  } else if (d.pushed) changed(true);
};
tlScroll.addEventListener('pointerup', endDrag); tlScroll.addEventListener('pointercancel', endDrag);

/* ============ 속성 패널 ============ */
function slider(label, min, max, step, val, f, on, def, ticks) {
  const w = E('div', 'prop'); const lab = E('label', '', `<span>${label}</span>`);
  const r = E('input'); r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = val;
  const vi = E('input', 'valin'); vi.type = 'text'; vi.value = f(val); vi.title = '숫자를 직접 입력하고 Enter';
  const dec = String(step).includes('.') ? String(step).split('.')[1].length : 0;
  const show = (v) => { vi.value = f(v); };
  const apply = (v) => { v = clamp(Math.round(v / step) * step, +min, +max); v = +v.toFixed(Math.max(dec, 2)); pushOnce(label); r.value = v; on(v); show(v); };
  r.oninput = () => { pushOnce(label); on(+r.value); show(+r.value); };
  vi.onfocus = () => { vi.value = String(+r.value); vi.select(); }; vi.onmouseup = (e) => e.preventDefault();
  vi.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { vi.blur(); } else if (e.key === 'Escape') { show(+r.value); vi.blur(); } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); apply((+r.value || 0) + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)); vi.value = String(+r.value); vi.select(); } };
  vi.onblur = () => { const n = parseFloat(String(vi.value).replace(/[^0-9.\-]/g, '')); if (isNaN(n)) show(+r.value); else apply(n); };
  if (def !== undefined) r.ondblclick = () => { pushOnce(label); r.value = def; on(def); show(def); };
  const row = E('div', 'slrow'), bar = E('div', 'slbar'); bar.append(r);
  if (ticks) {   // 막대 아래에 자주 쓰는 값 눈금 (눌러서 바로 맞춰요)
    const tk = E('div', 'sltk'); const bs = [];
    ticks.forEach(([tv, tl]) => { const b = E('button', '', tl); b.style.left = `calc(7px + (100% - 14px) * ${(tv - min) / (max - min)})`; b.onclick = () => apply(tv); tk.append(b); bs.push([tv, b]); });
    const mark = () => bs.forEach(([tv, b]) => b.classList.toggle('on', Math.abs(tv - +r.value) < 0.001));
    const o1 = r.oninput; r.oninput = () => { o1(); mark(); }; const o2 = vi.onblur; vi.onblur = () => { o2(); mark(); }; mark();
    bs.forEach(([tv, b]) => { const oc = b.onclick; b.onclick = () => { oc(); mark(); }; });
    bar.append(tk);
  }
  row.append(bar, vi); w.append(lab, row); return w;
}
const sec = (title, resetFn) => { const s = E('div', 'sec', `<span>${title}</span>`); if (resetFn) { const b = E('button', '', '초기화'); b.onclick = resetFn; s.append(b); } return s; };
function chips(opts, cur, on) { const w = E('div', 'chips'); opts.forEach(([v, l]) => { const b = E('button', 'chip' + (v === cur ? ' on' : ''), l); b.onclick = () => on(v); w.append(b); }); return w; }
function timeBox(label, val, on) {
  const w = E('div'); w.append(E('label', 'dim', label)); const i = E('input'); i.type = 'text'; i.value = fmt(val, 2);
  i.onchange = () => { const t = parseTime(i.value); if (isNaN(t)) { i.value = fmt(val, 2); return; } on(t); };
  i.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') i.blur(); }; w.append(i); return w;
}
let rtab = 'detail';
function renderProps() {
  const p = propsEl; p.innerHTML = ''; const s = getSel();
  const isSub = !s || (s.type === 't' && s.c && s.c.kind === 'sub');
  const showSub = rtab === 'sub' && isSub;
  const rt = E('div', 'rtabs'); [['detail', '세부 정보'], ['sub', '💬 자막']].forEach(([k, l]) => { const t = E('button', (k === 'sub') === showSub ? 'on' : '', l); t.onclick = () => { rtab = k; if (k === 'sub' && !isSub) S.sel = null; renderTL(); renderOv(true); renderProps(); }; rt.append(t); });
  p.append(rt);
  if (showSub) { const d = E('div', 'pane'); p.append(d); buildSubPane(d); return; }
  if (!s) {
    if (S.multi && S.multi.length > 1) { p.append(E('div', 'sel-title', S.multi.length + '개 선택됨')); attrBar(p); imgDur(p, null); }
    if (S.clips.length) {
      p.append(sec('영상 크기'));
      const all = S.clips.every((c) => c.fit === 'cover') ? 'cover' : 'contain';
      p.append(chips([['contain', '전체 보기'], ['cover', '화면 채우기']], all, (v) => { push(); S.clips.forEach((c) => { c.fit = v; }); changed(); }));
    }
    return;   // 배경(위·아래 띠)은 왼쪽 [템플릿] 탭에만 둬요 (양쪽에 같은 게 뜨면 헷갈려요)
  }
  renderPropsSel(p, s);
}
let oriSel = null;   // 템플릿·텍스트 탭의 세로/가로 (고르지 않으면 지금 화면 비율을 따라가요)
const curOri = () => oriSel || (S.canvas === '9:16' ? 'v' : 'h');
function oriChips(p) { const c = chips([['v', '📱 세로'], ['h', '🖥 가로']], curOri(), (v) => { oriSel = v; buildLeft(); }); c.classList.add('wide2', 'orisw'); p.append(c); }
function bgControls(p) {
  oriChips(p);
  if (curOri() === 'v') return shortsTplControls(p);
  p.append(sec('제목 화면'));
  const nxt = S.texts.filter((x) => x.kind === 'bg' && x.card).length + 1;
  const mi = (ph, val, set) => { const i = E('input', 'ttl-in'); i.type = 'text'; i.placeholder = ph; i.value = val; i.maxLength = 40; i.onkeydown = (e) => e.stopPropagation(); i.oninput = () => set(i.value); return i; };
  p.append(mi('제목 (예: 영상편집방법)', ttlTxt, (v) => { ttlTxt = v; }), mi('위쪽 작은 글 (예: STEP 1)', ttlSmall == null ? 'STEP ' + nxt : ttlSmall, (v) => { ttlSmall = v; }));
  const tsw = E('div', 'bgsw'); ['#000000', '#1f6feb', '#ffffff', '#ff2d92', '#FFFD00', '#00C48C', '#ff9500', '#8e44ff'].forEach((c) => { const b = E('button', 'bgsw-b' + (c === ttlColor ? ' on' : ''), ''); b.style.background = c; b.title = c; b.onclick = () => { ttlColor = c; tsw.querySelectorAll('.bgsw-b').forEach((q) => q.classList.toggle('on', q === b)); }; tsw.append(b); }); p.append(tsw);
  const tb = E('button', 'primary bigbtn', '＋ 제목 화면 추가'); tb.onclick = () => { addTitleCard(ttlTxt.trim(), ttlSmall == null ? 'STEP ' + nxt : ttlSmall.trim(), ttlColor); ttlSmall = null; }; p.append(tb);
  p.append(sec('추천 제목 화면'));
  const rec = E('div', 'tplcol');
  CARD_RECS.map((c) => [c.n, c.col, () => c.small.replace('{n}', nxt), c.title, c.low]).forEach(([n, col, sm, ti, low]) => {
    const r = E('div', 'tplrow'), bt = E('button', 'tplpick', esc(n)); bt.onclick = () => { addTitleCard(ttlTxt.trim() || ti || '제목을 입력하세요', sm(), col, low); ttlSmall = null; }; r.append(bt); rec.append(r);
  });
  p.append(rec);
  p.append(sec('내 제목 화면'));
  const cl = myCards(); if (cl.length) { const col = E('div', 'tplcol'); cl.forEach((c, i) => { const r = E('div', 'tplrow'), bt = E('button', 'tplpick', '⭐ ' + esc(c.n)); bt.onclick = () => addCard(c); const dx = E('button', 'tpldel', '×'); dx.title = '삭제'; dx.onclick = () => { const l = myCards(); l.splice(i, 1); saveMyCards(l); buildLeft(); }; r.append(bt, dx); col.append(r); }); p.append(col); }
  const cr = E('div', 'savetpl'), cn = E('input'); cn.type = 'text'; cn.placeholder = '이름 (예: 우리 채널 단계 화면)'; cn.maxLength = 20; cn.onkeydown = (e) => e.stopPropagation();
  const cb = E('button', 'primary', '＋ 저장'); cb.onclick = () => { const n = cn.value.trim(); if (!n) return toast('이름을 적어 주세요'); saveCard(n); buildLeft(); }; cr.append(cn, cb); p.append(cr);
}
function shortsTplControls(p) {   // 세로(쇼츠) 템플릿: 위·아래 띠 (고르면 화면 비율이 9:16으로 바뀌어요)
  const to916 = () => { if (S.canvas !== '9:16') { S.canvas = '9:16'; const cs = $('#sel-canvas'); if (cs) cs.value = '9:16'; } };
  p.append(sec('위·아래 띠'));
  const bc = chips([['none', '🚫 없음'], ['tpl', '위·아래 띠']], tplOn() ? 'tpl' : 'none', (v) => { push(); if (v === 'tpl') { to916(); S.tpl = S.tpl || { ...TPLS[0].v }; } else { S.tpl = null; S.bg = 'none'; } changed(); });
  bc.classList.add('wide2'); p.append(bc);
  if (!tplOn()) return;
  const t = S.tpl, up = () => { updateStage(); saveLocal(); };
  p.append(sec('자주 쓰는 모양'));
  const col = E('div', 'tplcol'); p.append(col);
  const row = (name, apply, del) => { const r = E('div', 'tplrow'); const b = E('button', 'tplpick', esc(name)); b.onclick = apply; r.append(b); if (del) { const x = E('button', 'tpldel', '×'); x.title = '삭제'; x.onclick = del; r.append(x); } col.append(r); };
  TPLS.forEach((x) => row(x.n, () => { push(); S.tpl = { ...x.v }; changed(); }));
  myTpls().forEach((x, i) => row('⭐ ' + x.n, () => { push(); S.tpl = { ...x.v }; changed(); }, () => { const l = myTpls(); l.splice(i, 1); saveMyTpls(l); renderProps(); setTab(ltab); }));
  p.append(sec('영상 크기')); p.append(chips([['all', '전체 칸'], ['mid', '가운데 칸'] ], t.fitMid ? 'mid' : 'all', (v) => { push(); t.fitMid = v === 'mid'; changed(); }));
  p.append(slider('위쪽 칸 높이', 0, 60, 0.5, t.top, (v) => v + '%', (v) => { t.top = v; up(); }, 22));
  p.append(slider('아래쪽 칸 높이', 0, 60, 0.5, t.bottom, (v) => v + '%', (v) => { t.bottom = v; up(); }, 22));
  [['topColor', '위쪽 칸 색'], ['midColor', '가운데 칸 색'], ['botColor', '아래쪽 칸 색']].forEach(([k, l]) => { const w = E('div', 'colorline'); w.append(colorPicker(l, () => t[k], (v, once) => { if (once) pushOnce('tc' + k); else push(); t[k] = v; up(); })); p.append(w); });
  p.append(sec('내 템플릿으로 저장'));
  const sr = E('div', 'savetpl'); const ni = E('input'); ni.type = 'text'; ni.placeholder = '이름 (예: 우리 채널 기본)'; ni.maxLength = 20;
  const sb = E('button', 'primary', '＋ 저장'); sb.onclick = () => { const n = ni.value.trim(); if (!n) return toast('이름을 적어 주세요'); const l = myTpls().filter((x) => x.n !== n); l.push({ n, v: { top: t.top, bottom: t.bottom, topColor: t.topColor, midColor: t.midColor, botColor: t.botColor, fitMid: false } }); saveMyTpls(l); toast('내 템플릿으로 저장했어요'); renderProps(); setTab(ltab); };
  sr.append(ni, sb); p.append(sr);
}

/* 음성 보정 (영상 클립 · 추가 소리 공용) */
let prevAudio = null;
const ENH_DEF = { on: false, lvl: 2, nr: true, clear: true, lev: true };
function enhControls(p, c) {
  const e = c.enh || (c.enh = { ...ENH_DEF });
  p.append(sec('음성 보정'));
  const rf = () => { renderProps(); saveLocal(); };
  const tog = (label, key) => { const w = E('label', 'switch'); const k = E('input'); k.type = 'checkbox'; k.checked = !!e[key]; k.onchange = () => { push(); e[key] = k.checked; rf(); }; w.append(k, E('span', '', label)); return w; };
  p.append(tog('음성 보정 켜기', 'on'));
  if (!e.on) return;
  p.append(chips([[1, '약하게'], [2, '보통'], [3, '강하게']], e.lvl || 2, (v) => { push(); e.lvl = v; rf(); }));
  p.append(tog('잡음 줄이기', 'nr')); p.append(tog('목소리 또렷하게', 'clear')); p.append(tog('볼륨 고르게', 'lev'));
  const isV = S.clips.includes(c), rw = E('div', 'chips');
  const listen = async (raw, btn) => {
    const pos = isV ? c.in + Math.max(0, S.t - c.start) * (c.speed || 1) : c.in + Math.max(0, S.t - c.start), st = clamp(pos, c.in, Math.max(c.in, c.out - 0.5));
    const old = btn.textContent; btn.textContent = '만드는 중…'; btn.disabled = true;
    try {
      if (prevAudio) { prevAudio.pause(); prevAudio = null; } pause();
      const r = await fetch('/api/enh-preview', { method: 'POST', body: JSON.stringify({ mediaId: c.mediaId, start: st, len: Math.min(8, c.out - st), enh: e, raw, vol: c.vol }) });
      if (!r.ok) throw new Error(); const u = URL.createObjectURL(await r.blob()); prevAudio = new Audio(u); prevAudio.play();
    } catch (err) { toast('미리 듣기를 만들지 못했어요'); }
    btn.textContent = old; btn.disabled = false;
  };
  const b1 = E('button', 'chip', '🔈 원본 듣기'), b2 = E('button', 'chip on', '🔊 보정 듣기'); b1.onclick = () => listen(true, b1); b2.onclick = () => listen(false, b2);
  rw.append(b1, b2); p.append(rw);
}
function splitAudioFromClip(c) {
  const m = S.media[c.mediaId] || {};
  if (!m.hasAudio) return toast('이 영상에는 소리가 없어요');
  if (Math.abs((c.speed || 1) - 1) > 0.001) return toast('재생 속도를 1x로 맞춘 뒤에 소리를 분리해 주세요');
  push(); layout();
  const a = { id: nid(), mediaId: c.mediaId, start: c.start, in: c.in, out: c.out, vol: c.vol === undefined ? 100 : c.vol };
  if (c.enh) a.enh = JSON.parse(JSON.stringify(c.enh));
  S.audio.push(a); c.mute = true; S.sel = { type: 'a', id: a.id }; changed(true); toast('소리를 따로 분리했어요 (추가 소리 줄)');
}
function imgDur(p, c) {   // 사진 길이: 선택한 사진들(또는 한 장)을 같은 시간으로 맞춰요
  const isImg = (x) => (S.media[x.mediaId] || {}).isImage;
  const sel = multiItems().filter((o) => o.type === 'v' && isImg(o.c)).map((o) => o.c);
  const tg = sel.length > 1 ? sel : (c ? [c] : []); if (!tg.length) return;
  const all = S.clips.filter(isImg); let val = Math.round(dur(tg[0]) * 10) / 10;
  p.append(sec(tg.length > 1 ? `사진 ${tg.length}장 길이` : '사진 길이'));
  const setD = (list, v) => { list.forEach((x) => { const mm = S.media[x.mediaId]; x.out = Math.min(mm.duration, x.in + v * (x.speed || 1)); }); layout(); renderTL(); updateStage(); saveLocal(); };
  p.append(slider('재생 시간', 0.5, 30, 0.1, val, (v) => v.toFixed(1) + '초', (v) => { val = v; pushOnce('imgd'); setD(tg, v); }, 5, [[1, '1초'], [5, '5초'], [10, '10초'], [30, '30초']]));
  if (all.length > tg.length) { const b = E('button', 'bigbtn', `모든 사진(${all.length}장)에 같은 시간 적용`); b.style.margin = '6px 14px'; b.onclick = () => { push(); setD(all, val); changed(); }; p.append(b); }
}
function renderPropsSel(p, s) {
  if (s.type === 't') return renderTextProps(p, s.c);
  const m = S.media[s.c.mediaId] || {}, c = s.c;
  p.append(E('div', 'sel-title', `${esc(m.name || '')}`));
  const upd = () => { layout(); renderTL(); updateStage(); saveLocal(); };
  attrBar(p);
  if (s.type === 'v') mgPropsSec(p, c, true);
  if (s.type === 'v' && m.isImage) imgDur(p, c);
  if (s.type === 'v' && !m.isImage) {
    p.append(sec('소리'));
    { const vr = E('div', 'volrow'); vr.append(slider('음량', 0, 200, 1, c.vol, (v) => v + '%', (v) => { c.vol = v; if (cur === c) setGain(c); saveLocal(); }, 100));
      const mb = E('button', 'volbtn' + (c.mute ? ' on' : ''), c.mute ? '🔇' : '🔊'); mb.title = c.mute ? '음소거 해제' : '음소거'; mb.onclick = () => { push(); c.mute = !c.mute; changed(); }; vr.append(mb); p.append(vr); }
    { const sb = E('button', 'primary bigbtn', '🎵 소리 분리하기'); sb.style.margin = '6px 14px'; sb.onclick = () => splitAudioFromClip(c); p.append(sb); }
    enhControls(p, c);
    p.append(sec('속도'));
    p.append(slider('재생 속도', 0.25, 4, 0.05, c.speed, (v) => v.toFixed(2) + 'x', (v) => { c.speed = Math.round(v * 100) / 100; if (cur === c) video.playbackRate = c.speed; upd(); }, 1, [[0.5, '0.5x'], [1, '1x'], [1.5, '1.5x'], [2, '2x'], [4, '4x']]));
  }
  if (s.type === 'v') {
    p.append(sec('화면', () => { push(); Object.assign(c, { fit: 'contain', scale: 100, x: 0, y: 0, rot: 0, flip: false }); changed(); }));
    p.append(chips([['contain', '전체 보기'], ['cover', '화면 채우기']], c.fit, (v) => { push(); c.fit = v; changed(); }));
    p.append(slider('확대', 10, 400, 1, c.scale, (v) => v + '%', (v) => { c.scale = v; upd(); }, 100));
    p.append(slider('가로 위치', -100, 100, 1, c.x, (v) => v + '%', (v) => { c.x = v; upd(); }, 0));
    p.append(slider('세로 위치', -100, 100, 1, c.y, (v) => v + '%', (v) => { c.y = v; upd(); }, 0));
    const rw = E('div', 'chips');
    const b1 = E('button', 'chip', '⟳ 90° 회전'); b1.onclick = () => { push(); c.rot = ((c.rot || 0) + 90) % 360; changed(); };
    const b2 = E('button', 'chip' + (c.flip ? ' on' : ''), '↔ 미러링'); b2.onclick = () => { push(); c.flip = !c.flip; changed(); };
    const bR = E('button', 'chip' + (c.rev ? ' on' : ''), '⏪ 역방향'); bR.onclick = () => { push(); c.rev = !c.rev; changed(); seek(S.t, true); };
    const b3 = E('button', 'chip', '가운데로'); b3.onclick = () => { push(); c.x = 0; c.y = 0; changed(); };
    rw.append(b1, b2, bR, b3); p.append(rw);
    p.append(sec('잘라내기 (화면 비율로 크롭)'));
    p.append(chips([['none', '안 함'], ['square', '1:1 정사각'], ['9:16', '9:16']], c.crop || 'none', (v) => { push(); c.crop = v; if (v !== 'none' && c.cropPos === undefined) c.cropPos = 50; changed(); }));
    if (c.crop && c.crop !== 'none') p.append(slider('잘라낼 위치 (좌↔우)', 0, 100, 1, c.cropPos === undefined ? 50 : c.cropPos, (v) => v + '%', (v) => { c.cropPos = v; upd(); }, 50));
    p.append(sec('구간 (원본 시간)'));
    const r2 = E('div', 'row2');
    r2.append(timeBox('시작', c.in, (t) => { push(); c.in = clamp(t, 0, c.out - 0.05); changed(); }), timeBox('끝', c.out, (t) => { push(); c.out = clamp(t, c.in + 0.05, m.duration); changed(); }));
    p.append(r2);
  } else {
    p.append(sec('소리'));
    { const vr = E('div', 'volrow'); vr.append(slider('음량', 0, 200, 1, c.vol, (v) => v + '%', (v) => { c.vol = v; saveLocal(); }, 100));
      const mb = E('button', 'volbtn' + (c.vol === 0 && c.volPrev ? ' on' : ''), c.vol === 0 && c.volPrev ? '🔇' : '🔊'); mb.title = '음소거'; mb.onclick = () => { push(); if (c.vol > 0) { c.volPrev = c.vol; c.vol = 0; } else { c.vol = c.volPrev || 100; c.volPrev = 0; } changed(); }; vr.append(mb); p.append(vr); }
    enhControls(p, c);
    p.append(sec('위치'));
    const r2 = E('div', 'row2'); r2.append(timeBox('시작 위치', c.start, (t) => { push(); c.start = Math.max(0, t); changed(); }));
    p.append(r2);
  }
}

function boxCtl(p, ref, set, upd) {
  p.append(sec('글자 배경'));
  const bch = chips([[0, '없음'], [1, '박스']], ref.box ? 1 : 0, (v) => { push(); set('box', !!v); renderProps(); upd(); }); bch.classList.add('slim'); p.append(bch);
  if (!ref.box) return;
  const bc = E('div', 'colorline'); bc.append(colorPicker('박스 색', () => ref.boxColor || '#000000', (v, once) => { if (once) pushOnce('bxc' + (ref.id || '')); else push(); set('boxColor', v); upd(); })); p.append(bc);
  p.append(slider('박스 진하기', 0, 100, 5, ref.boxOpacity == null ? 70 : ref.boxOpacity, (v) => v + '%', (v) => { set('boxOpacity', v); upd(); }, 70));
  p.append(slider('모서리 둥글기', 0, 100, 5, ref.boxRadius || 0, (v) => v + '%', (v) => { set('boxRadius', v); upd(); }, 0));
}
function attrBar(p) {
  const w = E('div', 'btnrow attr'); const a = E('button', '', '속성 복사'), b = E('button', '', '속성 붙여넣기');
  a.title = 'Ctrl+Shift+C'; b.title = 'Ctrl+Shift+V'; a.onclick = copyAttr; b.onclick = pasteAttr;
  const c = E('button', '', '전체 적용'); c.title = '지금 고른 클립의 속성(음량·속도·크기·위치 등)을 같은 종류 전부에 적용'; c.onclick = applyAll; w.append(a, b, c); p.append(w);
}

/* ============ 색 고르기 (기본 색 + 내 색 저장/삭제) — 색을 정하는 모든 곳에서 같이 써요 ============ */
const PAL = ['#ffffff', '#000000', '#FFFD00', '#FF0103', '#ff9500', '#00FF11', '#00FDFF', '#0a84ff', '#CD00FF', '#ff2d92', '#a2845e', '#8e8e93'];
const MYC_KEY = 'vtk.mycolors.v1';
const myColors = () => { try { const l = JSON.parse(localStorage.getItem(MYC_KEY) || '[]'); return Array.isArray(l) ? l.filter((c) => /^#[0-9a-f]{6}$/i.test(c)) : []; } catch (e) { return []; } };
const saveMyColors = (l) => { try { localStorage.setItem(MYC_KEY, JSON.stringify(l)); } catch (e) {} };
function colorPicker(label, getV, onSet) {
  const root = E('div', 'cpick'); if (label) root.append(E('div', 'dim cl-lab', label));
  const sw = E('div', 'swatches'); root.append(sw);
  let cur = (getV() || '#ffffff').toLowerCase();
  const ci = E('input'); ci.type = 'color'; ci.title = '직접 고르기'; ci.value = cur;
  const mark = () => { root.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', b.dataset.c === cur)); ci.value = cur; };
  const set = (v, once) => { cur = v.toLowerCase(); onSet(v, once); mark(); };
  ci.oninput = () => set(ci.value, true); sw.append(ci);
  const mk = (c, parent, del) => { const b = E('button', 'swatch'); b.dataset.c = c.toLowerCase(); b.style.background = c; b.title = c.toUpperCase(); b.onclick = () => set(c, false); parent.append(b); return b; };
  PAL.forEach((c) => mk(c, sw));
  const renderMy = () => {
    my.innerHTML = ''; const l = myColors();
    const head = E('div', 'dim mc-h', '내 색'); const add = E('button', 'sm', '＋ 지금 색 저장'); add.onclick = () => { const l2 = myColors(); if (!l2.includes(cur)) { l2.push(cur); saveMyColors(l2.slice(-14)); } renderMy(); mark(); }; head.append(add); my.append(head);
    const row = E('div', 'swatches'); my.append(row);
    l.forEach((c) => { const w = E('div', 'mcw'); mk(c, w); const x = E('button', 'mcx', '×'); x.title = '이 색 지우기'; x.onclick = (e) => { e.stopPropagation(); saveMyColors(myColors().filter((q) => q !== c)); renderMy(); }; w.append(x); row.append(w); });
    mark();
  };
  mark(); return root;
}

/* ============ ⭐ 내 자막/글자 스타일 저장 ============ */
const MYSTYLE_KEY = 'vtk.mystyle.v1', STYLE_SKIP = ['id', 'kind', 'text', 'start', 'end', 'sid', 'name', 'mode', 'level', 'w', 'h'];
const myStyles = (kind) => { try { const o = JSON.parse(localStorage.getItem(MYSTYLE_KEY) || '{}'); return Array.isArray(o[kind]) ? o[kind] : []; } catch (e) { return []; } };
const saveMyStyles = (kind, l) => { try { const o = JSON.parse(localStorage.getItem(MYSTYLE_KEY) || '{}'); o[kind] = l; localStorage.setItem(MYSTYLE_KEY, JSON.stringify(o)); } catch (e) {} };
function styleOf(x) { const o = JSON.parse(JSON.stringify(x)); STYLE_SKIP.forEach((k) => delete o[k]); delete o.colors; return o; }
function applyStyle(x, st) { Object.keys(x).forEach((k) => { if (!STYLE_SKIP.includes(k) && k !== 'colors' && k in st === false && ['bold', 'italic', 'bg', 'shadow', 'glow', 'spacing', 'align', 'box', 'boxColor', 'boxOpacity', 'boxRadius'].includes(k)) delete x[k]; }); Object.assign(x, JSON.parse(JSON.stringify(st))); x.colors = []; }
function myStyleBox(p, x) {
  const kind = x.kind, label = kind === 'sub' ? '자막' : '글자';
  const box = E('div', 'mystyle'); p.append(box);
  const draw = () => {
    box.innerHTML = ''; box.append(E('div', 'ms-h', `⭐ 내 ${label} 스타일`));
    const row = E('div', 'btnrow'); const ni = E('input'); ni.type = 'text'; ni.placeholder = '스타일 이름'; ni.onkeydown = (e) => e.stopPropagation();
    const sb = E('button', 'primary', '저장'); sb.title = '지금 글자 모양을 내 스타일로 저장'; row.append(ni, sb); box.append(row);
    sb.onclick = () => { const n = ni.value.trim() || `내 스타일 ${myStyles(kind).length + 1}`; const l = myStyles(kind); l.push({ n, v: styleOf(x) }); saveMyStyles(kind, l); toast('저장했어요: ' + n); draw(); };
    const l = myStyles(kind);
    if (!l.length) return;
    l.forEach((it, i) => {
      const r = E('div', 'ms-row'); const pv = E('button', 'ms-pv', esc(it.n)); pv.style.fontFamily = `"${it.v.font || 'sans-serif'}"`; pv.style.color = it.v.color || '#fff'; pv.style.webkitTextStroke = '0.5px ' + (it.v.outlineColor || '#000'); pv.title = '이 클립에 적용';
      pv.onclick = () => { push(); applyStyle(x, it.v); changed(true); toast('적용했어요: ' + it.n); };
      r.append(pv);
      if (kind === 'sub') { const all = E('button', 'sm', '전체'); all.title = '모든 자막에 적용'; all.onclick = async () => { if (!(await ask('모든 자막에 이 스타일을 적용할까요?'))) return; push(); S.texts.filter((q) => q.kind === 'sub').forEach((q) => applyStyle(q, it.v)); changed(true); toast('모든 자막에 적용했어요'); }; r.append(all); }
      const del = E('button', 'sm', '✕'); del.title = '삭제'; del.onclick = () => { const z = myStyles(kind); z.splice(i, 1); saveMyStyles(kind, z); draw(); }; r.append(del); box.append(r);
    });
  };
  draw();
}
function renderTextProps(p, x) {
  if (x.kind === 'sticker') return renderStickerProps(p, x);
  if (x.kind === 'shape') return renderShapeProps(p, x);
  if (x.kind === 'pip') return renderPipProps(p, x);
  if (x.kind === 'bg') return renderBgProps(p, x);
  if (x.kind === 'fx') return renderFxProps(p, x);
  if (x.kind === 'zoom') return renderZoomProps(p, x);
  const isT = x.kind === 'text'; const upd = () => { renderTL(); renderOv(true); saveLocal(); };
  p.append(E('div', 'sel-title', isT ? '텍스트' : '자막'));
  attrBar(p);
  myStyleBox(p, x);
  p.append(sec('내용'));
  const w = E('div', 'prop'); const ta = E('textarea'); ta.rows = 3; ta.value = x.text;
  ta.oninput = () => { pushOnce('txt' + x.id); x.text = ta.value; upd(); };
  ta.onchange = () => renderProps();
  ta.onkeydown = (e) => e.stopPropagation(); w.append(ta); p.append(w);
  p.append(sec('글자 색'));
  const lines = String(x.text).split('\n'); const cw = E('div', 'colorlines');
  lines.forEach((ln, i) => {
    const cur = () => (x.colors && x.colors[i]) || x.color || '#ffffff';
    const setC = (v, once) => { if (once) pushOnce('col' + x.id); else push(); x.colors = x.colors || []; for (let k = 0; k < lines.length; k++) if (!x.colors[k]) x.colors[k] = x.color || '#ffffff'; x.colors[i] = v; if (i === 0) x.color = v; upd(); };
    const row = E('div', 'colorline'); row.append(colorPicker(lines.length > 1 ? `${i + 1}번째 줄 — ${esc(ln.slice(0, 14))}` : '', cur, setC)); cw.append(row);
  });
  p.append(cw);
  p.append(sec('글꼴'));
  const fw = E('div', 'prop'); const sel = E('select');
  S.fonts.forEach((f) => { const o = E('option', '', esc(f.label || f.family) + (f.user ? ' (내가 추가)' : '')); o.value = f.family; if (f.family === x.font) o.selected = true; sel.append(o); });
  if (!S.fonts.some((f) => f.family === x.font)) { const o = E('option', '', esc(x.font)); o.value = x.font; o.selected = true; sel.append(o); }
  sel.style.fontFamily = `"${x.font}"`; sel.onchange = () => { push(); x.font = sel.value; sel.style.fontFamily = `"${x.font}"`; upd(); }; sel.onkeydown = (e) => e.stopPropagation(); fw.classList.add('fontrow'); const ab = E('button', '', '＋ 내 폰트 추가'); ab.title = 'TTF / OTF 글꼴 파일'; ab.onclick = () => $('#font-input').click(); fw.append(sel, ab); p.append(fw);
  p.append(sec('크기·테두리'));
  p.append(slider('글자 크기', 20, 200, 1, x.size, (v) => v, (v) => { x.size = v; upd(); }, isT ? 90 : 86));
  p.append(slider('테두리 두께', 0, 20, 1, x.outline, (v) => v, (v) => { x.outline = v; upd(); }, 8));
  { const oc = E('div', 'colorline'); oc.append(colorPicker('테두리 색', () => x.outlineColor || '#000000', (v, once) => { if (once) pushOnce('oc' + x.id); else push(); x.outlineColor = v; upd(); })); p.append(oc); }
  boxCtl(p, x, (k, v) => { x[k] = v; }, upd);
  p.append(sec('위치 (화면 가운데 기준)'));
  p.append(slider('가로', 0, 100, 0.5, x.x, (v) => v + '%', (v) => { x.x = v; upd(); }, 50));
  p.append(slider('세로', 0, 100, 0.5, x.y, (v) => v + '%', (v) => { x.y = v; upd(); }, isT ? 16 : 81));
  p.append(sec('나오는 시간'));
  const r2 = E('div', 'row2');
  r2.append(timeBox('시작', x.start, (t) => { push(); x.start = clamp(t, 0, x.end - 0.1); changed(true); }), timeBox('끝', x.end, (t) => { push(); x.end = Math.max(x.start + 0.1, t); changed(true); }));
  p.append(r2);
  const br = E('div', 'btnrow');
  const b2 = E('button', 'danger', '🗑 삭제'); b2.onclick = del; br.append(b2); p.append(br);
}
let curProj = null;
function saveLocalNow() { srvDirty = true; try { localStorage.setItem(KEY, JSON.stringify({ pm: [...S.pm], proj: curProj, clips: S.clips, audio: S.audio, texts: S.texts, bg: S.bg, tpl: S.tpl, canvas: S.canvas, zoom: S.zoom, trk: S.trk })); } catch (e) {} }
let srvDirty = false;   // 컴퓨터(편집기 폴더)에도 20초마다 자동 저장해요. 브라우저 저장이 지워져도 작업이 남아요
const autoBody = () => JSON.stringify({ proj: curProj, pm: [...S.pm], data: projData() });
const hasWork = () => S.clips.length || S.audio.length || S.texts.length;
setInterval(() => { if (!srvDirty || !hasWork()) return; srvDirty = false; fetch('/api/autosave', { method: 'POST', body: autoBody() }).catch(() => { srvDirty = true; }); }, 20000);
addEventListener('pagehide', () => { if (srvDirty && hasWork()) try { navigator.sendBeacon('/api/autosave', autoBody()); } catch (e) {} });
let saveTimer = 0;   // 자동 저장은 잠깐 모았다가 한 번에 (끌 때마다 통째로 저장하면 버벅여요)
function saveLocal() { if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = 0; saveLocalNow(); }, 400); }
addEventListener('pagehide', () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; } saveLocalNow(); });
addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) { clearTimeout(saveTimer); saveTimer = 0; saveLocalNow(); } });

/* ============ 미디어 패널 / 업로드 ============ */
// 가져온 파일 여러 개 고르기: 빈 곳에서 끌어서 네모로 고르기 · Ctrl/Shift+클릭 · Ctrl+A → Delete 또는 [선택한 파일 지우기]
const mSel = new Set(); let mSelOn = false, mLast = null;
const shownMedia = () => Object.values(S.media).filter((m) => S.pm.has(m.id) && !m.color && !m.hide);
function mSelPaint() {
  const l = $('#media-list'); if (!l) return;
  [...mSel].forEach((id) => { if (!shownMedia().some((m) => m.id === id)) mSel.delete(id); });
  l.querySelectorAll('.mitem').forEach((it) => it.classList.toggle('msel', mSel.has(it.dataset.id)));
  const bar = $('#msel-bar'); if (!bar) return;
  bar.style.display = mSel.size ? '' : 'none';
  const b = bar.querySelector('.msel-del'); if (b) b.textContent = `🗑 선택한 파일 지우기 (${mSel.size})`;
}
async function removeMediaMany(ids) {
  ids = ids.filter((id) => S.media[id]); if (!ids.length) return;
  if (ids.length === 1) { await removeMedia(ids[0]); mSel.clear(); mSelPaint(); return; }
  const used = ids.filter((id) => S.clips.some((c) => c.mediaId === id) || S.audio.some((a) => a.mediaId === id)).length;
  if (!(await ask(used ? `파일 ${ids.length}개를 목록에서 지울까요?\n그중 ${used}개는 타임라인에서 사용 중이라 사용된 컷도 함께 삭제돼요.` : `파일 ${ids.length}개를 목록에서 지울까요?`, { danger: true, ok: '삭제' }))) return;
  push(); const set = new Set(ids); S.clips = S.clips.filter((c) => !set.has(c.mediaId)); S.audio = S.audio.filter((a) => !set.has(a.mediaId));
  await Promise.all(ids.map((id) => fetch('/api/media/' + id, { method: 'DELETE' }).catch(() => {})));
  ids.forEach((id) => { delete S.media[id]; mSel.delete(id); }); S.sel = null; changed(); toast(`파일 ${ids.length}개를 지웠어요`);
}
document.addEventListener('pointerdown', (e) => { if (!mSelOn) return; if (e.target.closest && (e.target.closest('#media-list') || e.target.closest('#msel-bar') || e.target.closest('.askbox') || e.target.closest('.dlg'))) return; mSelOn = false; if (mSel.size) { mSel.clear(); mSelPaint(); } }, true);
function mediaBand(l) {   // 빈 곳에서 끌면 네모 안에 든 파일이 골라져요
  l.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.mitem')) return;
    mSelOn = true; const keep = e.ctrlKey || e.metaKey || e.shiftKey, base = keep ? new Set(mSel) : new Set();
    if (!keep) { mSel.clear(); mSelPaint(); }
    const r0 = l.getBoundingClientRect(), x0 = e.clientX - r0.left + l.scrollLeft, y0 = e.clientY - r0.top + l.scrollTop;
    const band = E('div', 'mband'); let moved = false;
    const mv = (ev) => {
      const r = l.getBoundingClientRect(), x1 = ev.clientX - r.left + l.scrollLeft, y1 = ev.clientY - r.top + l.scrollTop;
      if (!moved && Math.hypot(x1 - x0, y1 - y0) < 4) return;
      if (!moved) { moved = true; l.append(band); }
      if (ev.clientY > r.bottom - 20) l.scrollTop += 12; else if (ev.clientY < r.top + 20) l.scrollTop -= 12;
      const L = Math.min(x0, x1), T = Math.min(y0, y1), W = Math.abs(x1 - x0), H = Math.abs(y1 - y0);
      Object.assign(band.style, { left: L + 'px', top: T + 'px', width: W + 'px', height: H + 'px' });
      mSel.clear(); base.forEach((id) => mSel.add(id));
      l.querySelectorAll('.mitem').forEach((it) => { const q = it.getBoundingClientRect(), ix = q.left - r.left + l.scrollLeft, iy = q.top - r.top + l.scrollTop; if (ix < L + W && ix + q.width > L && iy < T + H && iy + q.height > T) mSel.add(it.dataset.id); });
      mSelPaint();
    };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); band.remove(); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up); e.preventDefault();
  });
}
function fillMedia() {
  const l = $('#media-list'); if (!l) return; l.innerHTML = ''; const ms = shownMedia();
  if (!l.dataset.band) { l.dataset.band = 1; mediaBand(l); }
  if (!ms.length) { mSel.clear(); mSelPaint(); l.append(E('div', 'empty-media', '아직 가져온 파일이 없어요.<br>＋ 가져오기를 누르거나<br>파일을 끌어다 놓으세요.')); return; }
  ms.forEach((m) => {   // 썸네일 타일: 위에 그림 + 길이, 아래에 이름
    const it = E('div', 'mitem'); it.dataset.id = m.id;
    it.onclick = (e) => {
      mSelOn = true;
      if (e.shiftKey && mLast) { const ids = shownMedia().map((q) => q.id), a = ids.indexOf(mLast), b = ids.indexOf(m.id); if (a >= 0 && b >= 0) { if (!(e.ctrlKey || e.metaKey)) mSel.clear(); ids.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((id) => mSel.add(id)); } }
      else if (e.ctrlKey || e.metaKey) { if (mSel.has(m.id)) mSel.delete(m.id); else mSel.add(m.id); mLast = m.id; }
      else { mSel.clear(); mSel.add(m.id); mLast = m.id; }
      mSelPaint();
    };
    const th = E('div', 'th', m.hasVideo ? '' : '🎵'); if (m.thumb) th.style.backgroundImage = `url(/api/thumb/${m.id})`;
    th.append(E('span', 'dur', fmt(m.duration, 0)));
    const nm = E('div', 'nm', esc(m.name));
    const bt = E('div', 'btns'); const add = E('button', 'add', '＋'); add.title = '타임라인에 추가'; const rm = E('button', 'rm', '✕'); rm.title = '목록에서 제거';
    add.onclick = (e) => { e.stopPropagation(); addToTimeline(m.id, true); };
    rm.onclick = (e) => { e.stopPropagation(); if (mSel.size > 1 && mSel.has(m.id)) removeMediaMany([...mSel]); else removeMedia(m.id); };
    if (m.hasVideo) { const pb = E('button', 'add', '⧉'); pb.title = '추가 미디어로 올리기'; pb.onclick = (e) => { e.stopPropagation(); addPip(m.id, S.t); }; bt.append(add, pb, rm); } else bt.append(add, rm);
    it.append(th, nm, bt); it.draggable = true; it.ondragstart = (e) => { dragKind = m.hasVideo ? 'pipv' : 'aud'; e.dataTransfer.setData('text/x-vtk', JSON.stringify({ k: 'media', id: m.id })); e.dataTransfer.effectAllowed = 'copy'; }; it.ondblclick = () => addToTimeline(m.id, true);
    it.title = `${m.name}\n${m.hasVideo ? m.width + '×' + m.height + ' · ' : ''}더블클릭하면 타임라인에 추가돼요`;
    l.append(it);
  });
  mSelPaint();
}

/* ============ 왼쪽 탭 (미디어 · 오디오 · 텍스트 · 자막 · 템플릿) ============ */
let ltab = 'media';
function renderMedia() { if (ltab === 'media') fillMedia(); else if (ltab !== 'audio') buildLeft(); }
let subView = 'list';
// 스타일 편집: 모든 자막의 디자인을 한 번에 바꿔요
function buildSubStyle(d) {
  const subs = () => S.texts.filter((x) => x.kind === 'sub');
  const ref = subs()[0] || { font: (S.fonts[0] && S.fonts[0].family) || 'sans-serif', size: 86, color: '#ffffff', outline: 8, outlineColor: '#000000', y: 81, x: 50 };
  if (!subs().length) { d.append(E('div', 'hint', '먼저 자막을 추가해 주세요')); return; }
  d.append(E('div', 'ahow', '여기서 바꾸면 모든 자막(' + subs().length + '개)에 적용돼요'));
  const upd = () => { renderTL(); renderOv(true); saveLocal(); };
  const setAll = (k, v) => subs().forEach((q) => { q[k] = v; });
  d.append(sec('글꼴'));
  const fw = E('div', 'prop'); const sel = E('select');
  S.fonts.forEach((f) => { const o = E('option', '', esc(f.label || f.family) + (f.user ? ' (내가 추가)' : '')); o.value = f.family; if (f.family === ref.font) o.selected = true; sel.append(o); });
  sel.style.fontFamily = `"${ref.font}"`; sel.onchange = () => { push(); setAll('font', sel.value); sel.style.fontFamily = `"${sel.value}"`; upd(); }; sel.onkeydown = (e) => e.stopPropagation(); fw.classList.add('fontrow'); const ab = E('button', '', '＋ 내 폰트 추가'); ab.title = 'TTF / OTF 글꼴 파일'; ab.onclick = () => $('#font-input').click(); fw.append(sel, ab); d.append(fw);
  d.append(sec('글자 색'));
  const cw = E('div', 'colorline'); cw.append(colorPicker('', () => ref.color || '#ffffff', (v, once) => { if (once) pushOnce('subcol'); else push(); subs().forEach((q) => { q.color = v; q.colors = []; }); ref.color = v; upd(); })); d.append(cw);
  d.append(sec('크기·테두리'));
  d.append(slider('글자 크기', 20, 200, 1, ref.size, (v) => v, (v) => { setAll('size', v); upd(); }, 86));
  d.append(slider('테두리 두께', 0, 20, 1, ref.outline, (v) => v, (v) => { setAll('outline', v); upd(); }, 8));
  const oc = E('div', 'colorline'); oc.append(colorPicker('테두리 색', () => ref.outlineColor || '#000000', (v, once) => { if (once) pushOnce('subocol'); else push(); setAll('outlineColor', v); ref.outlineColor = v; upd(); })); d.append(oc);
  boxCtl(d, ref, (k, v) => { setAll(k, v); ref[k] = v; }, upd);
  d.append(sec('위치'));
  d.append(slider('세로', 0, 100, 0.5, ref.y, (v) => v + '%', (v) => { setAll('y', v); upd(); }, 81));
  d.append(slider('가로', 0, 100, 0.5, ref.x, (v) => v + '%', (v) => { setAll('x', v); upd(); }, 50));
}
function setTab(t) { if (typeof sfxAudio !== 'undefined' && sfxAudio) sfxAudio.pause(); ltab = t; document.querySelectorAll('#ltabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t)); buildLeft(); }
function itemRow(x) {
  const r = E('div', 'titem' + (isSel('t', x.id) ? ' sel' : '')); r.append(E('span', 'tm', fmt(x.start, 1)), E('span', 'tx', esc(String(x.text).replace(/\n/g, ' '))));
  r.onclick = () => { select('t', x.id); pause(); seek(x.start + 0.01); }; return r;
}
function addShortsCaption() {   // 쇼츠 자막: 아네모네 글꼴 · 크기 70 · 테두리 8
  addText('text'); const x = S.texts[S.texts.length - 1];
  const f = S.fonts.find((q) => /anemone|아네모네/i.test((q.family || '') + (q.label || ''))) || S.fonts.find((q) => /Ssurround/i.test(q.family));
  Object.assign(x, { text: '쇼츠 자막', colors: [], color: '#ffffff', size: 70, outline: 8, outlineColor: '#000000', x: 50, y: 70 });
  if (f) x.font = f.family; changed(true);
}
function addTitlePreset() {
  addText('text'); const x = S.texts[S.texts.length - 1];
  Object.assign(x, { text: '첫째 줄 제목\n둘째 줄 제목', colors: ['#ffffff', '#FFFD00'], color: '#ffffff', size: 90, y: 16 });
  const f = S.fonts.find((q) => /Ssurround/i.test(q.family)); if (f) x.font = f.family; changed(true);
}
function buildSubPane(d) {
    const sv = E('div', 'chips subtabs');
    [['list', '자막 목록'], ['style', '스타일 편집']].forEach(([k, l]) => { const t = E('button', 'chip' + (subView === k ? ' on' : ''), l); t.onclick = () => { subView = k; renderProps(); }; sv.append(t); });
    d.append(sv);
    if (subView === 'style') { buildSubStyle(d); return; }
    const bs = E('button', 'primary bigbtn', '🎙 목소리로 자막 자동 만들기'); bs.onclick = sttDialog; d.append(bs);
    const b1 = E('button', 'bigbtn', '＋ 자막 한 줄 추가 (재생 막대 위치)'); b1.onclick = () => addText('sub'); d.append(b1);
    if (S.texts.some((x) => x.kind === 'sub')) {
      d.append(sec('자막 다시 나누기 (한 줄)'));
      const rs = E('div', 'chips shiftrow'); [['fast', '⚡ 빠른 자막'], ['slow', '🐢 느린 자막']].forEach(([k, l]) => { const bb = E('button', 'chip', l); bb.title = SPLIT_TIP[k]; bb.onclick = () => resplitSubs(k); rs.append(bb); }); d.append(rs);
      d.append(sec('자막 시간 한꺼번에 맞추기'));
      const shiftAll = (dt) => { push(); S.texts.filter((x) => x.kind === 'sub').forEach((x) => { const l = x.end - x.start; x.start = Math.max(0, Math.round((x.start + dt) * 100) / 100); x.end = Math.round((x.start + l) * 100) / 100; }); changed(true); toast(`자막을 ${dt > 0 ? '늦췄어요' : '당겼어요'} (${dt > 0 ? '+' : ''}${dt}초)`); };
      const sr = E('div', 'chips shiftrow'); [[-0.5, '−0.5'], [-0.1, '−0.1'], [0.1, '+0.1'], [0.5, '+0.5']].forEach(([dt, l]) => { const bb = E('button', 'chip', l + '초'); bb.onclick = () => shiftAll(dt); sr.append(bb); }); d.append(sr);
      const gb = E('button', 'bigbtn', '↔ 자막 사이 빈틈 메우기'); gb.onclick = () => { push(); const l = S.texts.filter((x) => x.kind === 'sub').sort((a, b) => a.start - b.start); l.forEach((x, i) => { const n = l[i + 1]; if (n && n.start > x.end && n.start - x.end <= 0.6) x.end = n.start; }); changed(true); toast('0.6초 이내 빈틈을 메웠어요'); }; d.append(gb);
    }
    d.append(E('h4', '', `자막 목록 (${S.texts.filter((x) => x.kind === 'sub').length}개)`));
    const ss = S.texts.filter((x) => x.kind === 'sub').sort((p, q) => p.start - q.start); if (!ss.length) d.append(E('div', 'hint', '아직 없어요')); ss.forEach((x) => d.append(subRow(x)));
}
let stkSec = 'shape', stkSub = 'kbd';
const STK_ORDER = ['복사', '붙여넣기', '잘라내기', '되돌리기', '다시 실행', '저장', '전체 선택', '찾기', '새로 만들기', '인쇄', '화면 캡처', '바탕화면 보기', '재생 일시정지', '분할', '모든 트랙 분할', '앞부분 삭제', '뒷부분 삭제', '클립 삭제', '다시 실행 2', '속성 복사', '속성 붙여넣기', '1프레임 이동', '10프레임 이동', '이전 다음 컷', '처음으로', '끝으로', '선택 모드', '클릭 자르기 모드', '뒤로 감기', '멈춤', '빠르게 감기', '타임라인 전체 보기', '타임라인 확대', '타임라인 축소', '음량 올리기', '음량 내리기', '현재 장면 캡처', '내보내기', '줄바꿈'];
function buildLeft() {
  const b = $('#lbody'); b.innerHTML = '';
  if (ltab === 'media') {
    const h = E('div', 'mhead', '<b>가져온 파일</b>'); const bt = E('button', 'primary sm', '＋ 가져오기'); bt.id = 'btn-import'; bt.onclick = () => $('#file-input').click(); h.append(bt);
    const l = E('div'); l.id = 'media-list'; const ft = E('div');
    const bar = E('div', 'msel-bar'); bar.id = 'msel-bar'; bar.style.display = 'none';
    const bd = E('button', 'danger msel-del', '🗑 선택한 파일 지우기'); bd.onclick = () => removeMediaMany([...mSel]);
    const bx = E('button', 'msel-x', '선택 해제'); bx.onclick = () => { mSel.clear(); mSelPaint(); };
    bar.append(bd, bx);
    b.append(h, bar, l, ft); fillMedia();
  } else if (ltab === 'audio') {
    const d = E('div', 'pane'); b.append(d); buildSfx(d);
  } else if (ltab === 'text') {
    const d = E('div', 'pane'); b.append(d);
    oriChips(d);
    d.append(E('h4', '', '글자 넣기'));
    const b1 = E('button', 'primary bigbtn', '＋ 기본 텍스트'); b1.onclick = () => addText('text'); d.append(b1);
    if (curOri() === 'v') {
      const b2 = E('button', 'bigbtn', '＋ 쇼츠 제목 (2줄: 흰색 / 노랑)'); b2.onclick = addTitlePreset;
      const b3 = E('button', 'bigbtn', '＋ 쇼츠 자막'); b3.onclick = addShortsCaption;
      d.append(b2, b3);
    }
    d.append(E('h4', '', '넣은 텍스트'));
    const ts = S.texts.filter((x) => x.kind === 'text'); if (!ts.length) d.append(E('div', 'hint', '아직 없어요')); ts.forEach((x) => d.append(itemRow(x)));
  } else if (ltab === 'stk') {
    const ss = S.texts.filter((x) => x.kind === 'sticker').sort((p, q) => p.start - q.start);
    if (stkSec === 'used' && !ss.length) stkSec = 'shape';
    const pane = E('div', 'pane stkwrap'); b.append(pane); const nav = E('div', 'stknav'), d = E('div', 'stkbody'); pane.append(nav, d);
    const secs = {};
    const mkSec = (k, label) => {
      const w = E('div', 'stksec'); w.style.display = stkSec === k ? '' : 'none'; secs[k] = w;
      const nb = E('button', 'stknb' + (stkSec === k ? ' on' : ''), label); nb.dataset.k = k;
      nb.onclick = () => { stkSec = k; Object.keys(secs).forEach((q) => { secs[q].style.display = q === k ? '' : 'none'; }); nav.querySelectorAll('.stknb').forEach((x) => x.classList.toggle('on', x.dataset.k === k)); };
      nav.append(nb); d.append(w); return { w, nb };
    };
    const sShape = mkSec('shape', '도형'), sKey = mkSec('key', '단축키'), sMine = mkSec('mine', '내 이미지'), sUsed = mkSec('used', '넣은 스티커');
    sMine.nb.style.display = 'none'; sKey.nb.style.display = 'none'; if (!ss.length) sUsed.nb.style.display = 'none';
    if (stkSec === 'kbd' || stkSec === 'txt') stkSec = 'key';
    const kg = E('div', 'stk-grid stk-names'), tg = E('div', 'stk-grid stk-names');
    const subn = E('div', 'stksub'), subb = E('div', 'stksubbody'), ksub = {};
    [['kbd', '키보드형', kg], ['txt', '텍스트형', tg]].forEach(([k, lb, gr]) => {
      const bt = E('button', 'stksb' + (stkSub === k ? ' on' : ''), lb); bt.onclick = () => { stkSub = k; kg.style.display = k === 'kbd' ? '' : 'none'; tg.style.display = k === 'txt' ? '' : 'none'; subn.querySelectorAll('.stksb').forEach((q) => q.classList.toggle('on', q === bt)); }; subn.append(bt); ksub[k] = gr;
    });
    kg.style.display = stkSub === 'kbd' ? '' : 'none'; tg.style.display = stkSub === 'txt' ? '' : 'none'; subb.append(kg, tg);
    const kw = E('div', 'stkkey'); kw.append(subn, subb); sKey.w.append(kw);
    const sg = E('div', 'chips shapes');
    const SV = (vb, inner, st) => `<svg viewBox="${vb}" width="30" height="30" fill="${st ? 'none' : 'currentColor'}" ${st ? 'stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"' : ''}>${inner}</svg>`;
    const SHI = {
      rect: SV('0 0 24 24', '<rect x="3" y="6" width="18" height="12" rx="1.5"/>'),
      ellipse: SV('0 0 24 24', '<ellipse cx="12" cy="12" rx="9" ry="6.5"/>'),
      arrow: SV('0 0 24 24', '<path d="M3 9h10V5l8 7-8 7v-4H3z"/>'),
      check: SV('0 0 24 24', '<path d="M4 12.5l5 5L20 6.5" stroke-width="3.2"/>', 1),
      cross: SV('0 0 24 24', '<path d="M6 6l12 12M18 6L6 18" stroke-width="3.2"/>', 1),
      checkbox: SV('0 0 24 24', '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>', 1),
      pointer: SV('0 0 24 24', '<path d="M5 3l14 8-6 2-3 6z"/>'),
      click: SV('0 0 24 24', '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="12" cy="12" r="4"/>'),
      badge: SV('0 0 24 24', '<circle cx="12" cy="12" r="9"/><path d="M10.2 9.8l2.2-1.6v7.6"/>', 1),
      hand: SV('0 0 100 120', `<path d="${HAND_D}" stroke-width="7"/>`, 1),
      handclick: SV('0 0 100 130', `<path d="${HAND_D}" transform="translate(0 10)" stroke-width="7"/><path d="M43 8V0M33 12L27 6M53 12l6-6M29 22h-8M57 22h8" stroke-width="7"/>`, 1),
    };
    Object.keys(SHAPE_PTS).forEach((v) => { if (!SHI[v]) SHI[v] = SV('0 0 24 24', '<polygon points="' + SHAPE_PTS[v].map(([u, w]) => (u * 20 + 2).toFixed(1) + ',' + (w * 20 + 2).toFixed(1)).join(' ') + '"/>'); });
    SHI.qmark = SV('0 0 24 24', '<text x="12" y="21" font-size="26" font-weight="900" text-anchor="middle" stroke="none">?</text>'); SHI.emark = SV('0 0 24 24', '<text x="12" y="21" font-size="26" font-weight="900" text-anchor="middle" stroke="none">!</text>');
    SHI.qbadge = SV('0 0 24 24', '<circle cx="12" cy="12" r="10"/><text x="12" y="17.5" font-size="15" font-weight="900" text-anchor="middle" fill="#17171b" stroke="none">?</text>'); SHI.ebadge = SV('0 0 24 24', '<circle cx="12" cy="12" r="10"/><text x="12" y="17.5" font-size="15" font-weight="900" text-anchor="middle" fill="#17171b" stroke="none">!</text>');
    Object.keys(SHAPE_D).forEach((v) => { SHI[v] = SV('0 0 24 24', '<path transform="translate(2 2) scale(.2)" d="' + SHAPE_D[v] + '"/>'); });
    Object.keys(SHI).forEach((v) => { const b = E('button', 'chip', SHI[v]); b.title = SHAPE_NAMES[v]; b.onclick = () => addShape(v); sg.append(b); });
    sShape.w.append(sg);
    const g = E('div', 'stk-grid'); sMine.w.append(g);
    const trash = E('div', 'stk-trash', '🗑 삭제'); trash.style.display = 'none'; trash.ondragover = (e) => { e.preventDefault(); trash.classList.add('over'); }; trash.ondragleave = () => trash.classList.remove('over'); trash.ondrop = (e) => { e.preventDefault(); trash.style.display = 'none'; trash.classList.remove('over'); if (trash._del) trash._del(); };
    d.append(trash);
    const drag0 = (e, st) => { dragKind = 'sticker'; e.dataTransfer.setData('text/x-vtk', JSON.stringify({ k: 'sticker', st })); e.dataTransfer.effectAllowed = st.builtin ? 'copy' : 'copyMove'; };
    fetch('/api/stickers').then((r) => r.json()).then((l) => {
      const rk = (st) => { const n = st.id.replace(/\.[^.]+$/, '').replace(/^[^_]*_/, ''), i = STK_ORDER.indexOf(n); return i < 0 ? 999 : i; };
      l = l.slice().sort((p, q) => (q.builtin ? 1 : 0) - (p.builtin ? 1 : 0) || (p.builtin ? rk(p) - rk(q) : 0));
      l.forEach((st) => {
        if (st.builtin) {   // 편집기에 들어 있는 단축키 스티커: 같은 크기 글자 칸으로 보여줘요
          const t = E('button', 'stk-name', esc(st.id.replace(/\.[^.]+$/, '').replace(/^[^_]*_/, ''))); t.onclick = () => addSticker(st); t.draggable = true; t.ondragstart = (e) => drag0(e, st);
          const k = st.id.startsWith('단축키_'); (k ? kg : tg).append(t); sKey.nb.style.display = ''; return;
        }
        sMine.nb.style.display = '';
        const t = E('button', 'stk-tile'); t.title = st.name; const im = E('img'); im.src = '/api/sticker/file?n=' + encodeURIComponent(st.id); im.draggable = false; t.append(im); if (st.gif) t.append(E('span', 'gb', 'GIF'));
        const rm = E('span', 'stk-rm', '✕'); rm.title = '이 이미지 지우기';
        const doDel = async () => { const used = S.texts.filter((x) => x.kind === 'sticker' && x.sid === st.id); if (!(await ask('이 이미지를 목록에서 지울까요?' + (used.length ? '\n타임라인에 넣은 ' + used.length + '개도 함께 지워져요.' : ''), { danger: true, ok: '삭제' }))) return; const r = await fetch('/api/sticker/delete?n=' + encodeURIComponent(st.id), { method: 'POST' }).then((z) => z.json()).catch(() => ({})); if (!r.ok) return toast(r.error || '지우지 못했어요'); if (used.length) { push(); S.texts = S.texts.filter((x) => !(x.kind === 'sticker' && x.sid === st.id)); S.sel = null; changed(); } toast('지웠어요'); buildLeft(); };
        rm.onclick = (e) => { e.stopPropagation(); e.preventDefault(); doDel(); }; t.append(rm); t.onclick = () => addSticker(st); t.draggable = true;
        t.ondragstart = (e) => { drag0(e, st); trash._del = doDel; trash.style.display = 'flex'; }; t.ondragend = () => { trash.style.display = 'none'; trash.classList.remove('over'); }; g.append(t);
      });
      if (stkSec === 'mine' && sMine.nb.style.display === 'none') sShape.nb.click();
    }).catch(() => {});
    if (ss.length) { ss.forEach((x) => { const r = E('div', 'titem' + (isSel('t', x.id) ? ' sel' : '')); r.append(E('span', 'tm', fmt(x.start, 1)), E('span', 'tx', esc(x.name || ''))); r.onclick = () => { select('t', x.id); seek(x.start + 0.01); }; sUsed.w.append(r); }); }
  } else if (ltab === 'fx') {
    const d = E('div', 'pane'); b.append(d); buildFxTab(d);
  } else if (ltab === 'tpl') {
    const d = E('div', ''); d.style.padding = '0 12px 14px'; b.append(d); bgControls(d);
  }
}
document.querySelectorAll('#ltabs button').forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });
tlScroll.addEventListener('scroll', () => { const lb = $('#tl-labels'); if (lb) lb.scrollTop = tlScroll.scrollTop; });
async function removeMedia(id) {
  const used = S.clips.some((c) => c.mediaId === id) || S.audio.some((a) => a.mediaId === id);
  if (used && !(await ask('타임라인에서 사용 중인 파일입니다\n목록에서 지우면 사용된 컷도 함께 삭제돼요. 계속할까요?', { danger: true, ok: '삭제' }))) return;
  push(); S.clips = S.clips.filter((c) => c.mediaId !== id); S.audio = S.audio.filter((a) => a.mediaId !== id);
  await fetch('/api/media/' + id, { method: 'DELETE' }); delete S.media[id]; S.sel = null; changed();
}
function uploadFile(file) {
  return new Promise((res) => {
    const box = E('div', 'up', `<div>${esc(file.name)}</div><div class="bar"><i></i></div>`); $('#uploads').append(box);
    const bar = $('i', box), label = box.firstChild;
    const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/upload?name=' + encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { bar.style.width = (e.loaded / e.total * 100) + '%'; if (e.loaded === e.total) label.textContent = file.name + ' — 분석 중…'; } };
    xhr.onload = () => { box.remove(); if (xhr.status === 200) res(JSON.parse(xhr.responseText)); else { let m = xhr.responseText; try { m = JSON.parse(m).error; } catch (e) {} toast('가져오기 실패: ' + file.name + ' (' + m + ')'); res(null); } };
    xhr.onerror = () => { box.remove(); toast('서버와 연결이 끊겼어요'); res(null); };
    xhr.send(file);
  });
}
async function importFiles(files) {
  const list = [...files].filter((f) => /^(video|audio|image)\//.test(f.type) || /\.(mkv|mov|m4a|flac|mp4|mp3|wav|webm|avi|aac|ogg|ts|wmv|png|jpe?g|webp|gif|bmp)$/i.test(f.name));
  if (!list.length) return toast('영상·사진·오디오 파일만 가져올 수 있어요');
  for (const f of list) {
    const m = await uploadFile(f); if (!m) continue;
    S.media[m.id] = m; addToTimeline(m.id);
    if (S.clips.length === 1 && m.hasVideo) fitAll();
  }
}
$('#empty').onclick = () => $('#file-input').click();
$('#file-input').onchange = (e) => { importFiles(e.target.files); e.target.value = ''; };
let dragDepth = 0;
addEventListener('dragenter', (e) => { if ([...(e.dataTransfer.types || [])].includes('Files')) { dragDepth++; $('#veil').classList.add('on'); } });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#veil').classList.remove('on'); } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('#veil').classList.remove('on'); if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files); });

/* ============ 캡처 ============ */
async function capture() {
  layout(); const l = locate(S.t); if (!l) return toast('캡처할 영상이 없어요');
  const c = l.c, m = S.media[c.mediaId]; if (!m || !m.hasVideo) return;
  const st = clamp(c.in + (S.t - c.start) * c.speed, 0, m.duration);
  try {
    const r = await fetch('/api/capture', { method: 'POST', body: JSON.stringify({ mediaId: c.mediaId, t: st }) }).then((r) => r.json());
    if (r.error) throw new Error(r.error);
    if (r.media) { S.media[r.media.id] = r.media; renderMedia(); }
    toast(r.media ? '📷 캡처를 미디어에 넣었어요 (원본 화질 PNG도 저장됨)' : '📷 캡처 저장됨 (원본 화질 PNG)', { label: '폴더 열기', fn: () => reveal(r.file) });
  } catch (e) { toast('캡처 실패: ' + e.message); }
}
const reveal = (f) => fetch('/api/reveal', { method: 'POST', body: JSON.stringify({ file: f }) });

/* ============ 내보내기 ============ */
const modal = $('#modal');
const closeModal = () => modal.classList.remove('on');
function openModal(node) { modal.innerHTML = ''; modal.append(node); modal.classList.add('on'); }
modal.addEventListener('pointerdown', (e) => { if (e.target === modal && !modal.dataset.lock) closeModal(); });
function openExport() {
  layout(); if (!S.clips.length) return toast('내보낼 영상이 없어요');
  const d = E('div', 'dlg');
  d.innerHTML = `<h2>내보내기</h2>
  <div class="f"><label>파일 이름</label><input id="x-name" type="text" value="영상_${new Date().toISOString().slice(0, 10)}"></div>
  <div class="f"><label>형식</label><select id="x-fmt"><option value="mp4">MP4 영상</option><option value="mp3">MP3 (소리만)</option><option value="wav">WAV (소리만)</option></select></div>
  <div class="f" id="x-res-row"><label>해상도</label><select id="x-res"><option value="1080">1080p (권장)</option><option value="720">720p (빠름)</option><option value="1440">1440p</option><option value="source">원본 크기</option></select></div>
  <div class="f" id="x-q-row"><label>화질</label><select id="x-q"><option value="std">표준 (권장)</option><option value="fast">빠르게 (용량 큼)</option><option value="high">고화질 (느림)</option></select></div>
  <div class="f"><label>저장 위치</label><div class="pathrow"><input id="x-dir" type="text" placeholder="폴더 경로"><button id="x-pick" type="button">폴더 선택…</button></div></div>
  <div class="f chk"><label class="chkl"><input type="checkbox" id="x-norm" checked><span>소리 크기 자동 맞춤 (목소리 크기를 고르게)</span></label></div>
  <div class="hint" id="x-info" style="padding:0"></div>
  <div class="acts"><button id="x-cancel">취소</button><button id="x-go" class="primary">내보내기 시작</button></div>`;
  openModal(d);
  const info = () => { const f = $('#x-fmt').value; $('#x-res-row').style.display = $('#x-q-row').style.display = f === 'mp4' ? '' : 'none'; const cd = canvasDims(isNaN(+$('#x-res').value) ? 'source' : +$('#x-res').value); $('#x-info').textContent = f === 'mp4' ? `결과: ${cd.w}×${cd.h} · 길이 ${fmt(S.total, 1)}${S.texts.length ? ' · 글자 ' + S.texts.length + '개 포함' : ''}` : `길이 ${fmt(S.total, 1)}`; };
  ['#x-fmt', '#x-res'].forEach((q) => $(q).onchange = info); info();
  $('#x-dir').onkeydown = (e) => e.stopPropagation();
  fetch('/api/outdir').then((r) => r.json()).then((o) => { $('#x-dir').value = o.dir; }).catch(() => {});
  $('#x-pick').onclick = async () => { const b = $('#x-pick'); b.disabled = true; b.textContent = '선택 중…'; try { const o = await fetch('/api/pickdir', { method: 'POST', body: '{}' }).then((r) => r.json()); if (o.dir) $('#x-dir').value = o.dir; else toast('폴더 선택창을 열 수 없으면 경로를 직접 붙여넣어 주세요'); } catch (e) {} b.disabled = false; b.textContent = '폴더 선택…'; };
  $('#x-cancel').onclick = closeModal;
  $('#x-go').onclick = () => startExport({ name: $('#x-name').value, format: $('#x-fmt').value, res: $('#x-res').value, quality: $('#x-q').value, normalize: $('#x-norm').checked, outDir: $('#x-dir').value.trim() });
}
async function startExport(o) {
  const cd = canvasDims(o.res === 'source' ? 'source' : +o.res);
  layout(); const texts = S.texts.filter((x) => x.start < S.total && !tf(trkOfText(x)).h).map((x) => ({ ...x, end: Math.min(x.end, S.total), ...(x.kind === 'pip' && tf('p').m ? { vol: 0 } : {}) }));
  { const cx = document.createElement('canvas').getContext('2d'), kk = cd.w / 1080; texts.forEach((x) => { if (x.box && x.boxRadius > 0 && x.kind !== 'shape') { cx.font = `${Math.round(x.size * kk)}px "${x.font}", sans-serif`; x.boxW = String(x.text || '').split('\n').map((ln) => Math.round(cx.measureText(ln || ' ').width)); } }); }
  texts.forEach((x) => { if (x.kind === 'shape') { try { x.png = drawShape(x, cd.w).toDataURL('image/png').split(',')[1]; } catch (e) {} } });
  const body = { vhide: !!tf('v').h, clips: tf('v').m ? S.clips.map((c) => ({ ...c, mute: true })) : S.clips, audio: tf('a').m ? [] : S.audio, canvas: cd, fps: FPS, quality: o.quality, format: o.format, name: o.name, outDir: o.outDir, texts, bg: S.bg, tpl: tplOn(), normalize: !!o.normalize };
  const d = E('div', 'dlg', `<h2>내보내는 중…</h2><div class="pg"><i></i></div><div class="dim" id="x-pct">0%</div><div class="err" id="x-err"></div><div class="acts"><button id="x-stop">중단</button></div>`);
  modal.dataset.lock = '1'; openModal(d);
  let id;
  try { const r = await fetch('/api/export', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json()); if (r.error) throw new Error(r.error); id = r.id; }
  catch (e) { delete modal.dataset.lock; d.innerHTML = `<h2>내보내기 실패</h2><div class="err">${esc(e.message)}</div><div class="acts"><button id="x-rep">🚩 오류 보내기</button><button id="x-ok">닫기</button></div>`; $('#x-ok').onclick = closeModal; $('#x-rep').onclick = () => reportDialog('내보내기 실패: ' + e.message); return; }
  $('#x-stop').onclick = async () => { await fetch(`/api/job/${id}/cancel`, { method: 'POST' }); clearInterval(iv); delete modal.dataset.lock; closeModal(); toast('내보내기를 중단했어요'); };
  const iv = setInterval(async () => {
    const j = await fetch('/api/job/' + id).then((r) => r.json()).catch(() => null); if (!j) return;
    $('.pg i', d).style.width = (j.progress * 100) + '%'; $('#x-pct').textContent = Math.round(j.progress * 100) + '%';
    if (j.status === 'done') {
      clearInterval(iv); delete modal.dataset.lock;
      d.innerHTML = `<h2>✅ 내보내기 완료</h2><div class="hint" style="padding:0;word-break:break-all">${esc(j.file)}</div><div class="acts"><button id="x-open" class="primary">폴더 열기</button><button id="x-ok">닫기</button></div>`;
      $('#x-open').onclick = () => reveal(j.file); $('#x-ok').onclick = closeModal;
    } else if (j.status === 'error') {
      clearInterval(iv); delete modal.dataset.lock;
      d.innerHTML = `<h2>내보내기 실패</h2><div class="err">${esc(j.error)}</div><div class="acts"><button id="x-rep">🚩 오류 보내기</button><button id="x-ok">닫기</button></div>`; $('#x-ok').onclick = closeModal; $('#x-rep').onclick = () => reportDialog('내보내기 실패: ' + j.error);
    }
  }, 500);
}

/* ============ 효과음 폴더 ============ */
let sfxAudio = null;
function buildSfx(d) {
  const render = async () => {
    let r; try { r = await fetch('/api/sfx').then((x) => x.json()); } catch (e) { showGone(); return; }
    d.innerHTML = '';
    { const rb = E('button', 'primary bigbtn', '🎙 내 목소리 녹음하기'); rb.style.marginBottom = '10px'; rb.onclick = recordDialog; d.append(rb); }
    const up = E('div', 'btnrow'); up.style.padding = '0'; const ub = E('button', 'primary bigbtn', '＋ 내 컴퓨터에서 효과음 파일 추가'); const fi = E('input'); fi.type = 'file'; fi.multiple = true; fi.accept = 'audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac'; fi.hidden = true;
    ub.onclick = () => fi.click();
    fi.onchange = async () => { let ok = 0; for (const f of fi.files) { const r = await fetch('/api/sfx/upload?name=' + encodeURIComponent(f.name), { method: 'POST', body: f }).then((x) => x.json()).catch(() => ({})); if (r.ok) ok++; } toast(ok + '개 추가했어요 (목록 맨 위 [내 효과음])'); render(); };
    up.append(ub, fi); d.append(up);
    const own = r.files.some((x) => x.own); r.files = own ? r.files.filter((x) => x.own) : r.files;
    if (!r.files.length) d.append(E('div', 'hint', '아직 효과음이 없어요'));
    if (r.files.length) {
      const q = E('input', 'wide'); q.type = 'text'; q.placeholder = `검색 (${r.files.length}개)`; q.onkeydown = (e) => e.stopPropagation(); d.append(q);
      const list = E('div', 'sfx-list'); d.append(list);
      const draw = () => {
        list.innerHTML = ''; const w = q.value.trim().toLowerCase(); const fs = r.files.filter((x) => !w || x.rel.toLowerCase().includes(w));
        if (!fs.length) list.append(E('div', 'hint', '파일이 없어요'));
        fs.slice(0, 300).forEach((x) => {
          const row = E('div', 'sfx-row'); row.append(E('span', 'nm', (x.own ? '⭐ ' : '') + esc((x.own ? x.rel.slice(2) : x.rel).replace(/^기본 효과음\//, '').replace(/\.(mp3|wav|m4a|ogg|aac)$/i, ''))));
          row.firstChild.title = x.rel;
          const pl = E('button', '', '▶ 듣기'); pl.onclick = () => { if (sfxAudio) sfxAudio.pause(); sfxAudio = new Audio('/api/sfx/file?p=' + encodeURIComponent(x.rel)); sfxAudio.play().catch(() => toast('이 형식은 미리듣기가 안 돼요 (추가는 가능)')); };
          const ad = E('button', 'primary', '＋ 추가'); ad.onclick = async () => {
            ad.disabled = true; ad.textContent = '…';
            try { const m = await fetch('/api/sfx/add', { method: 'POST', body: JSON.stringify({ rel: x.rel, hide: true }) }).then((z) => z.json()); if (m.error) throw new Error(m.error);
              S.media[m.id] = m; push(); S.audio.push({ id: nid(), mediaId: m.id, start: S.t, in: 0, out: m.duration, vol: 100 }); changed(true); toast('재생 막대 위치에 추가했어요: ' + x.name); }
            catch (e) { toast('추가 실패: ' + e.message); } ad.disabled = false; ad.textContent = '＋ 추가';
          };
          row.draggable = true; row.ondragstart = (e) => { e.dataTransfer.setData('text/x-vtk', JSON.stringify({ k: 'sfx', rel: x.rel, name: x.name })); e.dataTransfer.effectAllowed = 'copy'; };
          row.append(pl, ad); list.append(row);
        });
        if (fs.length > 300) list.append(E('div', 'hint', '결과가 많아요. 검색으로 좁혀 보세요 (300개까지 표시)'));
      };
      q.oninput = draw; draw();
    }
  };
  render();
}

/* ============ 단축키 ============ */
const KEYS = [
  ['재생 / 일시정지', 'Space'], ['저장', 'Ctrl+S'],
  ['분할 (재생 막대 위치)', 'Ctrl+B'], ['모든 트랙 분할', 'Ctrl+Shift+B'],
  ['앞부분 / 뒷부분 삭제', 'Q / W'], ['선택한 클립 삭제', 'Delete'],
  ['실행 취소', 'Ctrl+Z'], ['다시 실행', 'Ctrl+Shift+Z'],
  ['복사 / 붙여넣기', 'Ctrl+C / V'], ['속성 복사 / 붙여넣기', 'Ctrl+Shift+C / V'],
  ['1프레임 이동', '← →'], ['10프레임 이동', 'Shift+← →'],
  ['이전 / 다음 컷으로', '↑ ↓'], ['처음 / 끝으로', 'Home / End'],
  ['선택 모드', 'A'], ['클릭 자르기 모드', 'B'],
  ['뒤로 / 멈춤 / 빠르게', 'J / K / L'], ['타임라인 전체 보기', 'Shift+Z'],
  ['타임라인 확대 / 축소', 'Ctrl+= / Ctrl+-'], ['음량 올리기 / 내리기', 'Ctrl+. / Ctrl+,'],
  ['현재 장면 캡처', 'Ctrl+P'], ['내보내기', 'Ctrl+E'],
  ['글자 칸에서 줄바꿈', 'Enter'],
];
function showKeys() {
  const d = E('div', 'dlg', '<h2>단축키</h2>'); const g = E('div', 'keys');
  KEYS.forEach(([a, k]) => g.append(E('div', 'k', `<span>${a}</span><span>${k.split(' / ').map((x) => '<kbd>' + esc(x) + '</kbd>').join(' ')}</span>`)));
  d.append(g); const a = E('div', 'acts'); const b = E('button', 'primary', '닫기'); b.onclick = closeModal; a.append(b); d.append(a); openModal(d);
}
addEventListener('keyup', (e) => { if (e.key === ' ' && !e.target.matches('input[type=text],input[type=number],textarea')) e.preventDefault(); });
document.addEventListener('pointerdown', (e) => { const a = document.activeElement; if (a && a.matches && a.matches('input[type=text],input[type=number],textarea') && !e.target.closest('input,textarea')) a.blur(); }, true);
addEventListener('keydown', (e) => {
  const tg = e.target;
  if (tg.matches && tg.matches('input[type=text],input[type=number],textarea')) { if (e.key === 'Escape') tg.blur(); return; }
  if (tg !== document.body && tg.matches && tg.matches('select,button,input[type=range],input[type=checkbox],input[type=color]') && !(modal.classList.contains('on'))) { if (e.key === ' ' || e.key === 'Delete') tg.blur(); }
  if (modal.classList.contains('on')) { if (e.key === 'Escape' && !modal.dataset.lock) closeModal(); return; }
  const ctrl = e.ctrlKey || e.metaKey, k = e.key.toLowerCase(); let h = true;
  if (ctrl && (e.altKey || e.shiftKey) && (e.code === 'KeyC' || e.code === 'KeyV')) {
    if (e.code === 'KeyC') copyAttr(); else if (e.code === 'KeyV') pasteAttr(); else h = false;
  } else if (ctrl) {
    if (k === 'a' && mSelOn && ltab === 'media') { shownMedia().forEach((m) => mSel.add(m.id)); mSelPaint(); }
    else if (k === 'b') e.shiftKey ? splitAll() : splitCmd();
    else if (k === 'z') e.shiftKey ? redo() : undo();
    else if (k === 'y') redo();
    else if (k === 'c') copy(); else if (k === 'v') paste();
    else if (k === 's') { saveLocal(); toast('저장됨 (자동 저장도 켜져 있어요)'); }
    else if (k === 'e') openExport(); else if (k === 'p') capture();
    else if (e.key === '=' || e.key === '+') zoomBy(1.25); else if (e.key === '-') zoomBy(0.8);
    else if (e.key === '.') volStep(10); else if (e.key === ',') volStep(-10);
    else h = false;
  } else if (e.altKey) h = false;
  else switch (e.key) {
    case ' ': toggle(); break;
    case 'Delete': case 'Backspace': if (mSelOn && mSel.size && ltab === 'media') removeMediaMany([...mSel]); else del(); break;
    case 'ArrowLeft': pause(); seek(S.t - (e.shiftKey ? 10 : 1) * FRAME); break;
    case 'ArrowRight': pause(); seek(S.t + (e.shiftKey ? 10 : 1) * FRAME); break;
    case 'ArrowUp': case 'ArrowDown': {
      pause(); layout(); const pts = [...S.clips.map((c) => c.start), S.total];
      if (e.key === 'ArrowUp') seek([...pts].reverse().find((p) => p < S.t - 0.02) ?? 0); else seek(pts.find((p) => p > S.t + 0.02) ?? S.total); break; }
    case 'Home': pause(); seek(0); break;
    case 'End': pause(); layout(); seek(S.total); break;
    case 'Escape': select(null); break;
    case '?': showKeys(); break;
    default:
      if (e.shiftKey && k === 'z') fitAll();
      else if (k === 'q') trimLeft(); else if (k === 'w') trimRight();
      else if (k === 'b') setMode(true); else if (k === 'a') setMode(false);
      else if (k === 'k') pause();
      else if (k === 'l') { initAudio(); if (reverse) { reverse = 0; } shuttle = playing ? Math.min(4, shuttle * 2) : 1; if (!playing) play(); else video.playbackRate = clamp(cur.speed * shuttle, 0.0625, 16); }
      else if (k === 'j') { pause(); reverse = 1; lastTick = performance.now(); requestAnimationFrame(tick); }
      else h = false;
  }
  if (h) e.preventDefault();
});
function setMode(on) { S.splitMode = on; document.body.classList.toggle('split-mode', on); $('#t-mode').classList.toggle('on', on); $('#t-mode').textContent = on ? '✂ 클릭 자르기 중 (A로 해제)' : '클릭 자르기 모드'; }

/* ============ 버튼 연결 ============ */
$('#btn-play').onclick = toggle;
$('#btn-prev').onclick = () => { pause(); seek(0); };
$('#btn-next').onclick = () => { pause(); layout(); seek(S.total); };
$('#btn-export').onclick = openExport; $('#btn-capture').onclick = capture; $('#btn-keys').onclick = showKeys;
$('#btn-new').onclick = async () => { const has = S.clips.length || S.audio.length || S.texts.length; if (has && !(await ask('새 동영상을 시작할까요?\n저장하지 않은 작업은 사라져요. (가져온 파일 목록도 비워져요)', { ok: '시작' }))) return; curProj = null; push(); S.clips = []; S.audio = []; S.texts = []; S.tpl = null; S.bg = 'none'; S.sel = null; S.pm = new Set(); S.t = 0; changed(); buildLeft(); };
$('#sel-canvas').onchange = (e) => setCanvas(e.target.value);
$('#t-undo').onclick = undo; $('#t-redo').onclick = redo; $('#t-split').onclick = splitCmd; $('#t-left').onclick = trimLeft; $('#t-right').onclick = trimRight; $('#t-del').onclick = del;
$('#t-mode').onclick = () => setMode(!S.splitMode);
$('#t-cpattr').onclick = copyAttr; $('#t-pastattr').onclick = pasteAttr;
async function openSample() {
  if ((S.clips.length || S.texts.length) && !(await ask('지금 작업 중인 타임라인을 샘플로 바꿀까요?'))) return;
  try {
    const r = await fetch('/api/sample').then((r) => r.json()); if (r.error) throw new Error(r.error);
    r.media.forEach((m) => { S.media[m.id] = m; }); push(); const pj = r.project;
    S.clips = pj.clips; S.audio = pj.audio || []; S.texts = pj.texts || []; S.bg = nb(pj.bg); S.tpl = pj.tpl || null; S.canvas = pj.canvas || 'original'; S.trk = pj.trk || {}; S.sel = null; S.t = 0;
    changed(true); fitAll(); toast('샘플을 열었어요! 자막이나 제목을 눌러서 고쳐 보세요');
  } catch (e) { toast('샘플을 열 수 없어요: ' + e.message); }
}

$('#t-zin').onclick = () => zoomBy(1.25); $('#t-zout').onclick = () => zoomBy(0.8); $('#t-fit').onclick = fitAll;
$('#t-zoom').oninput = (e) => setZoom(+e.target.value);
[video, spare].forEach((el) => { el.addEventListener('ended', () => { if (playing && cur && el === video) advance(cur); }); el.addEventListener('loadedmetadata', () => { if (el === video) updateStage(); }); });

/* ============ 창을 닫으면 프로그램도 종료 ============ */
const ping = () => fetch('/api/ping').catch(() => showGone());
setInterval(ping, 5000); ping();
addEventListener('focus', ping); document.addEventListener('visibilitychange', () => { if (!document.hidden) ping(); });
addEventListener('pagehide', () => { try { navigator.sendBeacon('/api/bye'); } catch (e) {} });

/* ============ 편집기 창 (위쪽 회색 줄 없이 한 줄로) ============ */
(() => {
  const wv = window.chrome && window.chrome.webview; if (!wv) return;   // 엣지 창으로 열렸을 땐 그대로
  const top = $('#top'), box = $('#win-btns'); box.hidden = false; document.body.classList.add('framed');
  const send = (m) => wv.postMessage(m), MAX = '<path d="M.5.5h9v9h-9z"/>', RESTORE = '<path d="M2.5.5h7v7M.5 2.5h7v7h-7z"/>';
  $('#win-min').onclick = () => send('win:min'); $('#win-max').onclick = () => send('win:max'); $('#win-close').onclick = () => send('win:close');
  const place = () => {   // 버튼 높이를 위쪽 줄에 맞추고, 내보내기 버튼 옆에 자리를 비워 둬요
    const h = top.getBoundingClientRect().height; box.style.height = h + 'px'; document.documentElement.style.setProperty('--winh', h + 'px');
    const z = parseFloat(getComputedStyle(top).zoom) || 1; top.style.paddingRight = (box.getBoundingClientRect().width + 8) / z + 'px';
  };
  place(); addEventListener('resize', place); new ResizeObserver(place).observe(top);
  wv.addEventListener('message', (e) => { if (e.data === 'win:max' || e.data === 'win:normal') { const mx = e.data === 'win:max'; $('#win-max svg').innerHTML = mx ? RESTORE : MAX; $('#win-max').title = mx ? '이전 크기로' : '최대화'; } });
  addEventListener('mousedown', (e) => {   // 위쪽 줄의 빈 곳을 끌면 창이 움직이고, 두 번 누르면 최대화
    if (e.button !== 0 || e.clientY > top.getBoundingClientRect().bottom || e.target.closest('button,input,select,textarea,a,label,video,canvas,[contenteditable]')) return;
    if (e.detail === 2) send('win:max'); else send('win:drag');
  }, true);
  send('win:hello');
})();

/* 큰 영상의 가벼운 미리보기 사본이 다 만들어지면 알아서 바꿔 써요 */
setInterval(async () => {
  if (!Object.values(S.media).some((m) => m.liteWait)) return;
  try {
    const l = await fetch('/api/media').then((r) => r.json());
    l.forEach((m) => { const o = S.media[m.id]; if (o && o.liteWait && !m.liteWait) { o.lite = m.lite; o.liteWait = false; } });
  } catch (e) {}
}, 8000);

/* ============ 시작 ============ */
(async () => {
  try { (await fetch('/api/media').then((r) => r.json())).forEach((m) => { S.media[m.id] = m; }); } catch (e) { toast('서버에 연결할 수 없어요'); }
  try {
    let o = null; try { o = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
    if (!o || !((o.clips || []).length || (o.texts || []).length)) {   // 브라우저 저장이 비었거나 망가졌으면 컴퓨터에 남은 자동 저장에서 이어서
      const a = await fetch('/api/autosave').then((r) => r.json()).catch(() => null);
      if (a && a.data && ((a.data.clips || []).length || (a.data.texts || []).length)) { o = { ...a.data, pm: a.pm || [], proj: a.proj || null }; try { localStorage.setItem(KEY, JSON.stringify(o)); } catch (e) {} }
    }
    if (o) {
      S.clips = (o.clips || []).filter((c) => S.media[c.mediaId]); S.audio = (o.audio || []).filter((a) => S.media[a.mediaId]);
      S.texts = o.texts || []; S.bg = nb(o.bg); S.tpl = o.tpl || null; S.canvas = o.canvas || 'original'; S.trk = o.trk || {}; S.zoom = o.zoom || 60; curProj = o.proj || null;
    }
  } catch (e) {}
  { const used = [...S.clips, ...S.audio].map((c) => c.mediaId); let pm = []; try { pm = (JSON.parse(localStorage.getItem(KEY) || 'null') || {}).pm || []; } catch (e) {} S.pm = new Set([...pm, ...used].filter((id) => S.media[id])); pmBoot = false; }
  loadFonts(); fetch('/api/caps').then((r) => r.json()).then((c) => { if (c && c.ass === false) toast('이 컴퓨터의 ffmpeg는 글자 넣기(자막)를 지원하지 않아요. 내보낼 때 글자가 빠질 수 있어요', null, 9000); }).catch(() => {});
  buildLeft(); changed(true); if (S.clips.length) fitAll();
  if (window.__home) window.__home();
  window.__vtk = { S, addText, addPip, renderProps, openSample, loadFonts, seek, splitCmd, trimLeft, trimRight, del, addToTimeline, importFiles, fitAll, loadProjectData };
})();
/* ============ 오류 보내기 ============ */
// 보내기 전에 내용을 보여 주고, 사용자가 고치거나 지울 수 있어요. 사용자 이름·집 폴더 경로·이메일은 가려요.
function reportDialog(what) {
  const d = E('div', 'dlg rep', '<h2>🚩 오류 보내기</h2>');
  const ta = E('textarea', 'rep-ta'); ta.spellcheck = false; ta.onkeydown = (e) => e.stopPropagation(); ta.value = '불러오는 중…'; d.append(ta);
  const note = E('div', 'rep-note', '보낼 내용이에요. 사용자 이름과 폴더 경로는 가렸어요. 보내고 싶지 않은 부분은 지워도 돼요.'); d.append(note);
  const a = E('div', 'acts'); const c = E('button', '', '취소'); c.onclick = closeModal; const cp = E('button', '', '📋 복사'); const go = E('button', 'primary', '보내기'); go.disabled = true;
  a.append(c, cp, go); d.append(a); openModal(d);
  cp.onclick = async () => { try { await navigator.clipboard.writeText(ta.value); toast('복사했어요'); } catch (e) { ta.select(); document.execCommand('copy'); toast('복사했어요'); } };
  (async () => {
    const info = await fetch('/api/report/info').then((r) => r.json()).catch(() => ({ log: [] }));
    const head = `[무슨 일이 있었나요?]\n(여기에 적어 주세요)\n\n` + (what ? `[오류]\n${what}\n\n` : '') + `[환경] 단동샘 편집기 v${info.version || '?'} / ${info.os || '?'} / 메모리 ${info.mem || '?'}\n\n[최근 기록]\n`;
    const lines = [...(info.log || []), ...CLIENT_LOG];
    let body = head + (lines.length ? lines.join('\n') : '(없음)');
    try { body = (await fetch('/api/report/mask', { method: 'POST', body: JSON.stringify({ text: body }) }).then((r) => r.json())).text || body; } catch (e) {}
    ta.value = body; ta.focus(); ta.setSelectionRange(ta.value.indexOf('(여기에'), ta.value.indexOf('(여기에') + 13);
    if (!info.form) { go.remove(); note.textContent = '아직 오류를 받는 곳이 준비되지 않았어요. 복사해서 단동샘에게 보내 주세요.'; return; }
    go.disabled = false;
    go.onclick = async () => {
      let t = ta.value; try { t = (await fetch('/api/report/mask', { method: 'POST', body: JSON.stringify({ text: t }) }).then((r) => r.json())).text || t; } catch (e) {}
      if (t.length > 1800) { const i = t.indexOf('[최근 기록]'); t = i > 0 ? t.slice(0, i) + '[최근 기록]\n…' + t.slice(i).slice(-(1800 - i - 20)) : t.slice(0, 1800); }   // 주소가 너무 길면 안 열려서 오래된 기록부터 줄여요
      window.open(info.form.replace('XXX', encodeURIComponent(t)), '_blank', 'noopener'); closeModal(); toast('설문지가 열리면 맨 아래 [제출]을 눌러 주세요', null, 6000);
    };
  })();
}
$('#btn-report').onclick = () => reportDialog('');
$('#btn-help').onclick = async () => {
  const r = await fetch('/api/help').then((x) => x.json()).catch(() => ({ url: '' }));
  if (r.url) { window.open(r.url, '_blank'); return; }
  const d = E('div', 'dlg', '<h2>❓ 사용법 링크</h2>'); const f = E('div', 'f'); f.append(E('label', '', '사용법 유튜브 영상이나 웹페이지 주소를 붙여넣으세요 (한 번만 넣으면 돼요)'));
  const i = E('input'); i.type = 'text'; i.placeholder = 'https://'; i.onkeydown = (e) => e.stopPropagation(); f.append(i); d.append(f);
  const a2 = E('div', 'acts'); const c = E('button', '', '취소'); c.onclick = closeModal; const ok = E('button', 'primary', '저장하고 열기');
  ok.onclick = async () => { const z = await fetch('/api/help', { method: 'POST', body: JSON.stringify({ url: i.value }) }).then((x) => x.json()).catch(() => ({})); if (z.error) return toast(z.error); closeModal(); if (i.value.trim()) window.open(i.value.trim(), '_blank'); };
  a2.append(c, ok); d.append(a2); openModal(d); i.focus();
};

/* ============ 동영상 저장 / 열기 / 파일 ============ */
const projData = () => JSON.parse(JSON.stringify({ clips: S.clips, audio: S.audio, texts: S.texts, bg: S.bg, tpl: S.tpl, canvas: S.canvas, zoom: S.zoom, trk: S.trk,
  media: Object.fromEntries([...S.clips, ...S.audio, ...S.texts.filter((x) => x.kind === 'pip')].map((c) => c.mediaId).filter((v, i, ar) => ar.indexOf(v) === i).map((id) => [id, { name: (S.media[id] || {}).name, size: (S.media[id] || {}).size }])) }));
const hhmm = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
function openedNote(j) { if (j && j.restoredFrom) toast(`파일이 망가져서 ${hhmm(j.restoredFrom)}에 백업한 상태로 열었어요`, null, 8000); }
// 이전 상태로 되돌리기: 저장할 때마다 남겨 둔 백업 중에서 골라요
async function restoreDialog(p, after) {
  const l = await fetch('/api/backups?id=' + p.id).then((r) => r.json()).catch(() => []);
  const d = E('div', 'dlg', `<h2>⏪ 이전 상태로 되돌리기</h2><div class="dim">${esc(p.name)}</div>`); const lst = E('div', 'projlist'); d.append(lst);
  if (!l.length) lst.append(E('div', 'hint', '아직 남아 있는 이전 상태가 없어요'));
  l.forEach((b) => {
    const r = E('div', 'projrow'); r.append(E('div', 'pn', `<b>${hhmm(b.t)}</b><small>클립 ${b.clips}개</small>`));
    const go = E('button', 'primary sm', '되돌리기'); go.onclick = async () => {
      const j = await fetch(`/api/backup?id=${p.id}&t=${b.t}`).then((x) => x.json()).catch(() => ({ error: '열 수 없어요' })); if (j.error) return toast(j.error);
      await fetch('/api/backup/snap', { method: 'POST', body: JSON.stringify({ id: p.id }) }).catch(() => {});   // 지금 상태도 남겨 둬서 다시 돌아올 수 있어요
      closeModal(); if (after) after(); curProj = { id: p.id, name: p.name }; loadProjectData(j.data); await saveProject(p.name); toast(`${hhmm(b.t)} 상태로 되돌렸어요`);
    };
    r.append(go); lst.append(r);
  });
  const a = E('div', 'acts'); const c = E('button', '', '닫기'); c.onclick = closeModal; a.append(c); d.append(a); openModal(d);
}
async function saveProject(name) {
  const r = await fetch('/api/project/save', { method: 'POST', body: JSON.stringify({ id: curProj && curProj.id, name, data: projData() }) }).then((x) => x.json()).catch(() => ({}));
  if (!r.id) { toast('저장하지 못했어요'); return false; }
  curProj = { id: r.id, name: r.name }; saveLocal(); toast('💾 저장했어요: ' + r.name); return true;
}

// AI가 만든 .dsp 는 모양이 조금씩 달라서, 빠진 값은 채우고 이상한 값은 고쳐서 열어요
function normalizeProject(d) {
  d = d || {}; const NF = (x) => String(x || '').normalize('NFC');
  let mp = d.media || {}; if (Array.isArray(mp)) { const o = {}; mp.forEach((m, i) => { if (typeof m === 'string') o['m' + (i + 1)] = { name: m }; else if (m) o[m.id || 'm' + (i + 1)] = { name: m.name || m.file }; }); mp = o; }
  Object.keys(mp).forEach((k) => { if (typeof mp[k] === 'string') mp[k] = { name: mp[k] }; mp[k].name = NF(mp[k].name || mp[k].file); });
  const used = new Set(); const uid = (id) => { let v = id && !used.has(id) ? id : nid(); used.add(v); return v; };
  const mid = (c) => { if (c.mediaId !== undefined && c.mediaId !== null) return c.mediaId; const nm = NF(c.name || c.file || c.media); if (!nm) return c.mediaId; let k = Object.keys(mp).find((q) => mp[q].name === nm); if (!k) { k = 'x' + Object.keys(mp).length; mp[k] = { name: nm }; } return k; };
  const num = (v, def) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : def);
  const clips = (d.clips || []).map((c) => { const q = Object.assign({}, dflt(), c); q.id = uid(c.id); q.mediaId = mid(c); q.in = num(c.in, 0); q.out = num(c.out, 0); q.speed = num(c.speed, 1) || 1; q.vol = num(c.vol, 100); return q; }).filter((c) => c.out > c.in);
  const audio = (d.audio || []).map((c) => { const q = Object.assign({ vol: 100 }, c); q.id = uid(c.id); q.mediaId = mid(c); q.start = Math.max(0, num(c.start, 0)); q.in = num(c.in, 0); q.out = num(c.out, 0); q.vol = num(c.vol, 100); return q; }).filter((c) => c.out > c.in);
  const font0 = (S.fonts[0] && S.fonts[0].family) || 'sans-serif';
  const texts = (d.texts || []).map((t) => { const kind = ['text', 'sub', 'sticker', 'shape', 'fx', 'zoom', 'pip', 'bg'].includes(t.kind) ? t.kind : (t.kind === 'title' || t.kind === 'caption' ? (t.kind === 'title' ? 'text' : 'sub') : 'sub'); const isT = kind === 'text';
    const q = Object.assign({ colors: [], color: '#ffffff', font: font0, size: isT ? 90 : 86, outline: 8, outlineColor: '#000000', x: 50, y: isT ? 42 : 81 }, t); q.kind = kind; q.id = uid(t.id); q.text = String(t.text === undefined || t.text === null ? '' : t.text); q.start = Math.max(0, num(t.start, 0)); q.end = num(t.end, q.start + 2); if (q.end <= q.start) q.end = q.start + 2; if (!Array.isArray(q.colors)) q.colors = []; return q; });
  let tpl = d.tpl; const TD = { top: 22, bottom: 22, topColor: '#000000', midColor: '#000000', botColor: '#000000', fitMid: false };
  if (typeof tpl === 'string') { const k = tpl.replace(/\s/g, ''); const f = [...TPLS, ...myTpls()].find((x) => x.n.replace(/\s/g, '') === k); tpl = f ? { ...f.v } : (/없|none|null/i.test(k) ? null : { ...TPLS[0].v }); }
  else if (tpl && typeof tpl === 'object') tpl = Object.assign({}, TD, tpl); else tpl = null;
  const canvas = ['original', '16:9', '9:16', '1:1', '4:3'].includes(d.canvas) ? d.canvas : 'original';
  return { media: mp, clips, audio, texts, tpl, bg: 'none', canvas, zoom: d.zoom };
}
const lk = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/\.[a-z0-9]{2,4}$/i, '').replace(/\(\d+\)|[\s_\-.,]+/g, '');
/* 원본 영상을 못 찾았을 때: 빼 버리지 않고 "다시 연결" 창을 먼저 보여 줘요. 결과: { 옛id: 새id } 또는 null(그냥 열기) */
function relinkDialog(miss) {
  return new Promise((resolve) => {
    const bg = E('div', 'askbg'), bx = E('div', 'askbox relink');
    bx.append(E('div', 'ask-t', '영상 파일을 찾지 못했어요'), E('div', 'ask-d', '옮기거나 이름을 바꾼 파일이에요.\n새 위치의 파일을 골라 연결해 주세요.'));
    const got = {}, list = E('div', 'rl-list'); bx.append(list);
    const fi = E('input'); fi.type = 'file'; fi.accept = 'video/*,audio/*,.mkv,.mov,.m4a,.flac'; fi.multiple = true; fi.hidden = true; bx.append(fi);
    const okb = E('button', 'primary', '연결하고 열기'), skip = E('button', '', '빼고 열기'), allb = E('button', '', '📂 한꺼번에 고르기');
    let target = null;
    const draw = () => {
      list.innerHTML = '';
      miss.forEach((m) => { const r = E('div', 'rl-row'); const ok = !!got[m.id];
        r.append(E('div', 'rl-n', (ok ? '✅ ' : '❓ ') + esc(m.name) + (ok ? '<small>→ ' + esc(S.media[got[m.id]].name) + '</small>' : '')));
        const b = E('button', 'sm', ok ? '다시 고르기' : '파일 고르기'); b.onclick = () => { target = m; fi.multiple = false; fi.click(); }; r.append(b); list.append(r); });
      const n = Object.keys(got).length; okb.disabled = !n; okb.textContent = n ? `연결하고 열기 (${n}/${miss.length})` : '연결하고 열기';
    };
    const lkm = (a, b) => a === b || (lk(a) && lk(a) === lk(b));
    fi.onchange = async () => {
      const files = [...fi.files]; fi.value = ''; if (!files.length) return;
      if (target) { const f = files[0], m = target; target = null; const r = await uploadFile(f); if (r) { S.media[r.id] = r; got[m.id] = r.id; } draw(); return; }
      for (const f of files) {   // 한꺼번에 고르기: 이름이 같은 것끼리 자동으로 짝지어요
        const m = miss.find((x) => !got[x.id] && lkm(x.name, f.name)) || (files.length === 1 && miss.length === 1 ? miss[0] : null); if (!m) continue;
        const r = await uploadFile(f); if (r) { S.media[r.id] = r; got[m.id] = r.id; } draw(); }
      draw();
    };
    allb.onclick = () => { target = null; fi.multiple = true; fi.click(); };
    const done = (v) => { bg.remove(); resolve(v); };
    skip.onclick = () => done(null); okb.onclick = () => done(got);
    const row = E('div', 'ask-b'); row.append(allb, skip, okb); bx.append(row); bg.append(bx); document.body.append(bg); draw();
  });
}
function loadProjectData(d) {
  if (d && !d.__mgDone && mgNeeds(d)) { d.__mgDone = true; if (d.__job) S.mgJob = d.__job; mgPrepare(d).then(() => loadProjectData(d)); return; }
  const fitTpl = !!(d && d.__fitTpl); d = normalizeProject(d); d.__fitTpl = fitTpl;
  const mp = d.media || {}, map = {};   // 다른 컴퓨터/폴더에서 온 파일은 이름·크기가 같은 파일로 연결
  Object.keys(mp).forEach((id) => { if (S.media[id]) { map[id] = id; return; } const f = Object.values(S.media).find((m) => m.name === mp[id].name && (!mp[id].size || m.size === mp[id].size)) || Object.values(S.media).find((m) => m.name === mp[id].name) || Object.values(S.media).find((m) => lk(m.name) && lk(m.name) === lk(mp[id].name)); if (f) map[id] = f.id; });
  const usedIds = new Set([...(d.clips || []), ...(d.audio || []), ...(d.texts || []).filter((t) => t.kind === 'pip')].map((c) => c.mediaId));
  const lost = Object.keys(mp).filter((id) => !map[id] && !S.media[id] && usedIds.has(id)).map((id) => ({ id, name: mp[id].name || id }));
  if (lost.length && !d.__relinked) { relinkDialog(lost).then((got) => { d.__relinked = true; if (got) Object.assign(map, got); finishLoad(d, map); }); return; }
  finishLoad(d, map);
}
const TPL_OVERLAP = 0.015;   // 영상 위·아래 끝이 띠 밑으로 살짝(화면 높이의 1.5%씩) 들어가게
function fitTplMid() {   // 쇼츠 템플릿이 있으면 영상 위·아래 끝이 띠에 살짝 겹치게 맞춰요(퍼센트가 아니라 띠 위치 기준). 일부러 크기를 바꾼 조각은 그대로 둬요
  const tp = tplOn(); if (!tp) return 0; let n = 0;
  const W = 1, H = 1 / canvasRatio(), midH = H * Math.max(0.05, 1 - ((+tp.top || 0) + (+tp.bottom || 0)) / 100);
  S.clips.forEach((c) => {
    const m = S.media[c.mediaId]; if (!m || !m.width || !m.height || c.fit === 'cover' || (c.scale != null && +c.scale !== 100)) return;
    if (tp.fitMid) { c.fit = 'cover'; n++; return; }
    const odd = ((((+c.rot || 0) % 360) + 360) % 360) % 180 !== 0, rw = odd ? m.height : m.width, rh = odd ? m.width : m.height;
    const base = Math.min(W / rw, H / rh), top = +tp.top || 0, bot = +tp.bottom || 0, ov = TPL_OVERLAP * 100, r1 = (x) => Math.round(x * 10) / 10;
    if (top > 0 && bot > 0) {   // 위·아래 띠가 다 있으면: 띠 사이를 채우고 양쪽 띠에 살짝 겹치게, 칸 한가운데로
      const want = Math.max(W / rw, (midH + 2 * TPL_OVERLAP * H) / rh), sc = Math.round(want / base * 100), shift = r1((top + 100 - bot) / 2 - 50);
      if (sc > 100 || shift) { if (sc > 100) c.scale = Math.min(400, sc); if (shift && !+c.y) c.y = shift; n++; }
      return;
    }
    if (+c.y || (!top && !bot)) return;   // 띠가 한쪽만 있으면(상단형 등): 키우지 않고 그 띠 바로 밑(위)에 살짝 겹치게 붙여요
    const hv = rh * base / H * 100;   // 영상 높이(화면 높이 대비 %)
    if (top > 0 && 50 - hv / 2 > top - ov) { c.y = r1(top - ov + hv / 2 - 50); n++; }
    else if (bot > 0 && 50 + hv / 2 < 100 - bot + ov) { c.y = r1(100 - bot + ov - hv / 2 - 50); n++; }
  });
  return n;
}
function finishLoad(d, map) {
  let miss = 0; const fix = (l) => (l || []).filter((c) => { const t = map[c.mediaId] || (S.media[c.mediaId] ? c.mediaId : null); if (!t) { miss++; return false; } c.mediaId = t; return true; });
  d.texts = (d.texts || []).filter((x) => { if (x.kind !== 'pip') return true; const t = map[x.mediaId] || (S.media[x.mediaId] ? x.mediaId : null); if (!t) { miss++; return false; } x.mediaId = t; return true; });
  push(); S.clips = fix(d.clips); S.audio = fix(d.audio); S.pm = new Set([...Object.values(map), ...S.clips.map((c) => c.mediaId), ...S.audio.map((c) => c.mediaId)].filter((id) => S.media[id])); S.texts = d.texts || []; S.bg = nb(d.bg); S.tpl = d.tpl || null; S.canvas = d.canvas || 'original'; S.sel = null; S.t = 0;
  if (d.__fitTpl) fitTplMid();
  changed(true); fitAll(); if (S.canvas) { const sc = $('#sel-canvas'); if (sc) sc.value = S.canvas; }
  toast(miss ? `열었어요. 단, 원본 파일 ${miss}개를 찾지 못해 빠졌어요 (미디어 탭에서 다시 가져와 주세요)` : '동영상을 열었어요', null, miss ? 8000 : 3500);
}
function fmtDate(ms) { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
async function quickSave() {
  if (!S.clips.length && !S.audio.length && !S.texts.length) return toast('저장할 작업이 없어요');
  if (curProj) return saveProject(curProj.name);
  const n = await askText('동영상 이름을 적어 주세요', '내 동영상 ' + fmtDate(Date.now()).split(' ')[0].replace('/', '월') + '일'); if (n) saveProject(n);
}
async function openProjects() {
  const d = E('div', 'dlg proj', '<h2>📁 내 동영상</h2>');
  const f = E('div', 'f'); f.append(E('label', '', '지금 작업을 이 이름으로 저장'));
  const row = E('div', 'btnrow'); const ni = E('input'); ni.type = 'text'; ni.value = curProj ? curProj.name : ''; ni.placeholder = '동영상 이름'; ni.onkeydown = (e) => e.stopPropagation();
  const sb = E('button', 'primary', '💾 저장'); row.append(ni, sb); f.append(row); d.append(f);
  const lst = E('div', 'projlist'); d.append(E('div', 'dim', '저장한 동영상')); d.append(lst);
  const refresh = async () => {
    lst.innerHTML = ''; const l = await fetch('/api/projects').then((r) => r.json()).catch(() => []);
    if (!l.length) lst.append(E('div', 'hint', '아직 저장한 동영상이 없어요'));
    l.forEach((p) => {
      const r = E('div', 'projrow' + (curProj && curProj.id === p.id ? ' cur' : '')); r.append(E('div', 'pn', `<b>${esc(p.name)}</b><small>${fmtDate(p.updated)} · 클립 ${p.clips}개</small>`));
      const ob = E('button', 'primary sm', '열기'); ob.onclick = async () => { const j = await fetch('/api/project?id=' + p.id).then((x) => x.json()); if (j.error) return toast(j.error); closeModal(); curProj = { id: j.id, name: j.name }; loadProjectData(j.data); openedNote(j); };
      const rb = E('button', 'sm', '되돌리기'); rb.onclick = () => restoreDialog(p);
      const db = E('button', 'sm', '삭제'); db.onclick = async () => { if (!(await ask(`'${p.name}' 동영상을 삭제할까요?\n되돌릴 수 없어요`, { danger: true, ok: '삭제' }))) return; await fetch('/api/project?id=' + p.id, { method: 'DELETE' }); if (curProj && curProj.id === p.id) curProj = null; refresh(); };
      r.append(ob, rb, db); lst.append(r);
    });
  };
  sb.onclick = async () => { const n = ni.value.trim(); if (!n) return toast('이름을 적어 주세요'); if (curProj && curProj.name !== n) curProj = null; if (await saveProject(n)) refresh(); };
  const fb = E('div', 'btnrow'); const ex = E('button', '', '📤 파일로 내보내기 (.dsp)'); const im = E('button', '', '📥 파일 열기'); const fi = E('input'); fi.type = 'file'; fi.accept = '.dsp,.json'; fi.hidden = true;
  ex.onclick = () => { const nm = (ni.value.trim() || (curProj && curProj.name) || '동영상').replace(/[\\/:*?"<>|]/g, ''); const bl = new Blob([JSON.stringify({ app: 'dandongsam', v: 1, name: nm, data: projData() })], { type: 'application/json' }); const a = E('a'); a.href = URL.createObjectURL(bl); a.download = nm + '.dsp'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };
  im.onclick = () => fi.click();
  fi.onchange = async () => { try { const j = JSON.parse(await fi.files[0].text()); if (!j.data) throw 0; closeModal(); curProj = null; loadProjectData(j.data); } catch (e) { toast('편집 파일을 읽을 수 없어요'); } };
  fb.append(ex, im, fi); d.append(fb);
  const a2 = E('div', 'acts'); const c = E('button', '', '닫기'); c.onclick = closeModal; a2.append(c); d.append(a2); openModal(d); refresh();
}
$('#btn-save').onclick = quickSave; $('#btn-proj').onclick = openProjects;
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); quickSave(); } });

/* ============ 칸 크기 조절 (경계선을 끌어서) ============ */
{
  const body = document.body, LK = 'vtk.layout.v1', DEF = { lw: 380, rw: 350, th: 340 };
  let L = Object.assign({}, DEF); try { Object.assign(L, JSON.parse(localStorage.getItem(LK) || '{}')); } catch (e) {}
  /* 화면 크기에 맞춰 전체 크기를 자동으로 맞춰요 (기준: 가로 1920 · 세로 940 → 그보다 작은 화면은 비율대로 줄임) */
  let ui = 1;
  const calcUi = () => { ui = Math.max(0.55, Math.min(1, innerWidth / 1920, innerHeight / 940)); document.documentElement.style.setProperty('--ui', ui.toFixed(3)); };
  const lim = () => ({ lw: [240, Math.max(300, innerWidth / ui - 700)], rw: [240, Math.max(300, innerWidth / ui - 700)], th: [170, Math.max(220, innerHeight / ui - 300)] });
  const apply = () => { calcUi(); const m = lim(); ['lw', 'rw', 'th'].forEach((k) => { L[k] = clamp(+L[k] || DEF[k], m[k][0], m[k][1]); body.style.setProperty('--' + k, (L[k] * ui).toFixed(1) + 'px'); }); };
  const refresh = () => { updateStage(); renderTL(); };
  const wire = (id, key, axis, sign) => {
    const g = $(id); let st = null;
    g.addEventListener('pointerdown', (e) => { st = { p: axis === 'x' ? e.clientX : e.clientY, v: L[key] }; g.setPointerCapture(e.pointerId); g.classList.add('drag'); body.classList.add('resizing'); body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'; e.preventDefault(); });
    g.addEventListener('pointermove', (e) => { if (!st) return; L[key] = st.v + sign * ((axis === 'x' ? e.clientX : e.clientY) - st.p) / ui; apply(); refresh(); });
    const end = () => { if (!st) return; st = null; g.classList.remove('drag'); body.classList.remove('resizing'); body.style.cursor = ''; try { localStorage.setItem(LK, JSON.stringify(L)); } catch (e) {} refresh(); };
    g.addEventListener('pointerup', end); g.addEventListener('pointercancel', end);
    g.addEventListener('dblclick', () => { L[key] = DEF[key]; apply(); try { localStorage.setItem(LK, JSON.stringify(L)); } catch (e) {} refresh(); });
  };
  wire('#g-left', 'lw', 'x', 1); wire('#g-right', 'rw', 'x', -1); wire('#g-tl', 'th', 'y', -1);
  apply(); window.addEventListener('resize', () => { apply(); refresh(); });
}



/* ============ 🤖 자동 편집 (AI에게 맡긴 결과를 편집기에서 열기) ============ */
(function autoEdit() {
  const copy = async (t) => { try { await navigator.clipboard.writeText(t); } catch (e) { const a = document.createElement('textarea'); a.value = t; document.body.append(a); a.select(); try { document.execCommand('copy'); } catch (e2) {} a.remove(); } };
  const post = (u, b) => fetch(u, { method: 'POST', body: JSON.stringify(b || {}) }).then((x) => x.json()).catch(() => ({ error: '서버에 연결할 수 없어요' }));
  const JK = 'vtk.autojob.v1', RK = 'vtk.autoratio.v1';
  const ld = (k, d) => { try { return localStorage.getItem(k) || d; } catch (e) { return d; } };
  const sv = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  async function openResult(it) {
    toast('불러오는 중… 영상이 길면 잠시 걸려요', null, 6000);
    const r = await post('/api/auto/open', { file: it.file });
    if (r.error) return toast(r.error, null, 6000);
    (r.media || []).forEach((m) => { S.media[m.id] = m; });
    closeModal(); curProj = null; r.data.__fitTpl = true; r.data.__job = r.job; S.mgJob = r.job || null; loadProjectData(r.data);   // AI가 만든 결과: 쇼츠 템플릿 가운데 칸에 맞춰 열어요
    if (r.missing && r.missing.length) toast(`폴더에서 ${r.missing.length}개를 찾지 못했어요: ${r.missing.join(', ')}`, null, 9000);
    else if (r.linked && r.linked.length) toast(`이름이 달라도 ${r.linked.length}개를 알아서 이어 붙였어요`, null, 5000);
  }
  async function show() {
    const info = await fetch('/api/auto/jobs').then((r) => r.json()).catch(() => null);
    if (!info) return toast('서버에 연결할 수 없어요');
    let sel = info.jobs.find((j) => j.path === ld(JK, '')) || info.jobs[0] || null, ratio = ld(RK, '9:16'), ai = ld('vtk.autoai.v1', 'codex'), skillOpen = false, aiOpen = false;   // 주로 쓰는 AI는 기억해 둬요
    const skillMemo = {}, sttMemo = {};   // 메뉴를 누를 때마다 화면을 다시 그려도, 전에 받아 둔 내용을 바로 보여 줘서 아래쪽이 깜빡이지 않게 해요
    let opt = {}; try { opt = JSON.parse(ld('vtk.autoopt.v1', '{}')); } catch (e) {} const saveOpt = () => sv('vtk.autoopt.v1', JSON.stringify(opt));
    const d = E('div', 'dlg auto-dlg', '<h2><i>✨</i>AI 자동 편집</h2>');
    const xb = E('button', 'auto-x', '✕ 닫기'); xb.onclick = closeModal; d.querySelector('h2').append(xb);   // 제목 줄 오른쪽 끝에 (다른 버튼과 겹치지 않게)
    const body = E('div'); d.append(body);
    const reload = async () => { closeModal(); await show(); };
    const draw = () => {
      body.innerHTML = '';
      const grid = E('div', 'agrid'); body.append(grid);
      const L = E('div', 'acol aleft'), Rt = E('div', 'acol aright'); grid.append(L, Rt);
      // 왼쪽: 작업 폴더
      L.append(E('div', 'ahead', '📂 작업 폴더'));
      const lst = E('div', 'ajobs'); L.append(lst);
      if (!info.jobs.length) lst.append(E('div', 'hint', '아직 없어요. 아래에서 만들어 보세요.'));
      info.jobs.forEach((j) => {
        const r = E('div', 'ajob' + (sel && sel.path === j.path ? ' on' : ''));
        const main = E('button', 'ajm', `<b>${esc(j.name)}</b><small>영상 ${j.videos} · 결과 ${j.results.length} · ${fmtDate(j.mtime)}</small>`);
        main.onclick = async () => { sel = j; sv(JK, j.path); draw(); post('/api/auto/openfolder', { path: j.path }); };
        r.append(main);
        if (j.kind !== 'legacy') { const x = E('button', 'ajx', '✕'); x.title = j.kind === 'extra' ? '목록에서 빼기 (폴더는 그대로)' : '폴더 지우기'; x.onclick = async () => {
          if (j.kind === 'extra') { await post('/api/auto/delete', { what: 'unlink', path: j.path }); }
          else { if (!(await ask(`'${j.name}' 작업 폴더를 통째로 지울까요?\n폴더 안의 영상과 결과 파일이 모두 사라지고, 되돌릴 수 없어요.`, { danger: true, ok: '지우기' }))) return; const z = await post('/api/auto/delete', { what: 'job', path: j.path }); if (z.error) return toast(z.error, null, 6000); }
          if (sel && sel.path === j.path) sv(JK, ''); reload(); }; r.append(x); }
        lst.append(r);
      });
      const nb = E('div', 'abtns');
      const b1 = E('button', 'primary', '＋ 새 작업'), b2 = E('button', '', '📂 내 폴더 지정');
      b1.onclick = () => { nb.innerHTML = ''; nb.classList.add('typing'); const i = E('input'); i.type = 'text'; i.placeholder = '작업 이름 (예: 쇼츠_1호)'; i.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') go.click(); }; const go = E('button', 'primary', '만들기');
        go.onclick = async () => { const z = await post('/api/auto/new', { name: i.value }); if (z.error) return toast(z.error); sv(JK, z.path); reload(); }; nb.append(i, go); i.focus(); };
      b2.onclick = async () => { b2.disabled = true; const pk = await post('/api/auto/pick'); let pth = pk.path;
        if (!pth && pk.canceled) { b2.disabled = false; return; }   // 폴더 선택 창에서 취소했으면 그냥 닫아요
        if (!pth) { pth = await askText('폴더 주소를 입력해 주세요', ''); }
        b2.disabled = false; if (!pth) return; const z = await post('/api/auto/add', { path: pth }); if (z.error) return toast(z.error); sv(JK, z.path); reload(); };
      nb.append(b1, b2); L.append(nb);
      L.append(footer());
      // 오른쪽: 선택한 작업
      if (!sel) { Rt.append(E('div', 'aempty', '왼쪽에서 작업을 만들거나<br>폴더를 지정해 주세요')); return; }
      const top = E('div', 'atop'); top.append(E('div', 'ahead', esc(sel.name)));
      const ob = E('button', 'sm', '📁 폴더 열기'); ob.onclick = async () => { const z = await post('/api/auto/openfolder', { path: sel.path }); if (z.error) toast(z.error); }; top.append(ob);
      Rt.append(top, E('div', 'apath', esc(sel.path)));
      // 영상 모양
      const rr = E('div', 'arow'); rr.append(E('span', 'alab', '영상 모양'));
      const rc = chips([['9:16', '📱 세로 (쇼츠)'], ['16:9', '🖥 가로 (유튜브)']], ratio, (v) => { ratio = v; sv(RK, v); draw(); }); rc.classList.add('seg'); rr.append(rc); Rt.append(rr);
      const lecture = ratio !== '9:16' && opt.kind === 'lecture';   // 강의/일반 구분은 가로 영상에만 있어요
      if (ratio !== '9:16') { const kr = E('div', 'arow'); kr.append(E('span', 'alab', '영상 종류'));
        const kc = chips([['normal', '🎬 일반 영상'], ['lecture', '📚 강의 영상']], lecture ? 'lecture' : 'normal', (v) => { opt.kind = v; saveOpt(); draw(); }); kc.classList.add('seg'); kr.append(kc); Rt.append(kr); }
      // 만들 영상(장르)과 진행 방식: 편집설정.json 에 저장되고, AI는 단동샘스킬/장르/ 안의 그 장르 파일을 읽어요
      const GENRES = [['none', '🎬 일반', '장르 없이 컷 편집과 자막'], ['tips', '💡 생활 꿀팁', '살림·주방·청소·수납 영상으로 후킹 대본·자막'], ['docu', '📜 다큐 쇼핑', '제품의 역사·원리를 이야기로 풀어 쇼핑과 연결'], ['product', '🛒 상품 소개', '불편 → 해결 → 특징 → 구매 유도'], ['aigen', '🤖 AI 생성 영상', 'AI로 만든 장면들을 이야기 순서대로 편집'], ['overseas', '🌏 해외 영상 요약', '사용 권한 확인 · 번역 · 독창적 해설 · 출처 표시']];
      const MODES = [['auto', '⚡ 완전 자동', '중간 질문 없이 끝까지'], ['step', '✋ 단계별 확인', '기획·대본·컷 계획마다 보여 주고 확인받기'], ['text', '📝 글만 받기', '영상 편집 없이 대본이나 장면별 생성 프롬프트만 받기']];
      const genre = ratio === '9:16' && GENRES.some((g) => g[0] === opt.genre) ? opt.genre : 'none', mode = ['script', 'prompt'].includes(opt.mode) ? 'text' : MODES.some((m) => m[0] === opt.mode) ? opt.mode : 'auto';
      const row3 = (label, list, cur, set) => { const w = E('div', 'arow ap'); w.append(E('span', 'alab', label)); const c = chips(list.map(([k, l]) => [k, l]), cur, (k) => { set(k); saveOpt(); draw(); }); c.classList.add('seg', 'wrapchips'); [...c.children].forEach((b, i) => { b.title = list[i][2]; }); w.append(c); Rt.append(w); };
      if (ratio === '9:16') row3('만들 영상', GENRES, genre, (k) => { opt.genre = k; });
      row3('진행 방식', MODES, mode, (k) => { opt.mode = k; });
      // AI 목소리: 초보는 직접 녹음하기 어려워서, AI가 대본을 엣지 무료 목소리로 읽어 내레이션을 만들어요 (인터넷 필요)
      const VOICES = [['none', '🎙 내 목소리', '내가 녹음한 내레이션을 쓰거나, 내레이션 없이 만들어요'], ['female', '👩 AI 여자', '무료 AI 목소리(선희)로 대본을 읽어 넣어요 · 인터넷이 필요해요'], ['male', '👨 AI 남자', '무료 AI 목소리(인준)로 대본을 읽어 넣어요 · 인터넷이 필요해요']];
      const VNAME = { female: 'ko-KR-SunHiNeural', male: 'ko-KR-InJoonNeural' }, voiceKey = VNAME[opt.voice] ? opt.voice : 'none';
      if (mode !== 'text') row3('목소리', VOICES, voiceKey, (k) => { opt.voice = k; });
      const voice = mode !== 'text' && VNAME[voiceKey] ? { name: VNAME[voiceKey], rate: ratio === '9:16' ? '+10%' : '+0%' } : null;
      // 제작 모드: 모션그래픽을 넣을지, 어떻게 섞을지 (모션그래픽스킬/SKILL.md 가 이 값을 읽어요)
      const MMODES = [['off', '🎬 일반', '지금처럼 컷 편집과 자막만 (모션그래픽 없이)'], ['mix', '🎥 촬영+모션', '직접 찍은 영상 위에 필요한 곳만 모션그래픽을 덮어요'], ['only', '✨ 모션만', '영상 없이 대본·내레이션에 맞춰 모션그래픽만으로 만들어요'], ['multi', '🧩 복합', '폴더에 넣어 둔 실사·AI 영상·사진과 모션그래픽을 섞어요']];
      const mmode = mode !== 'text' && MMODES.some((m) => m[0] === opt.mg) ? opt.mg : 'off';
      const mgSty = opt.mgStyle && (opt.mgStyle === 'auto' || MG.STYLES[opt.mgStyle]) ? opt.mgStyle : 'auto', mgAmt = ['low', 'mid', 'high'].includes(opt.mgAmt) ? opt.mgAmt : 'mid';
      if (mode !== 'text') row3('제작 모드', MMODES, mmode, (k) => { opt.mg = k; });
      if (mmode !== 'off') {
        row3('모션 스타일', [['auto', '🤖 AI가 고르기', '영상 내용을 보고 AI가 골라요'], ...Object.entries(MG.STYLES).map(([k, v]) => [k, v.n, v.tip])], mgSty, (k) => { opt.mgStyle = k; });
        if (mmode !== 'only') row3('모션 비중', [['low', '적게', '1분에 1~2개'], ['mid', '보통', '1분에 2~3개'], ['high', '많이', '1분에 4~5개']], mgAmt, (k) => { opt.mgAmt = k; });
      }
      const motion = mmode === 'off' ? null : { mode: mmode, style: mgSty, amount: mmode === 'only' ? null : mgAmt };
      const LAND = ratio !== '9:16';   // 가로(롱폼)는 글자 크기 기준이 달라 훨씬 작게 잡아요
      const SUBDEF = { kind: 'sub', font: 'Cafe24 Ssurround', size: LAND ? 34 : 86, color: '#ffffff', outline: LAND ? 4 : 7, outlineColor: '#000000', x: 50, y: LAND ? 88 : 70 };
      const TITLEDEF = { kind: 'text', font: 'Cafe24 Ssurround', size: 90, color: '#ffffff', colors: ['#ffffff', '#FFFD00'], outline: 8, outlineColor: '#000000', x: 50, y: 16, lines: 2 };
      const subs = myStyles('sub'), titles = myStyles('text'), tpls = myTpls();
      opt.subBy = opt.subBy || {}; const typeKey = ratio + '|' + (lecture ? 'lec' : 'nor'), typeWord = lecture ? '강의' : ratio === '9:16' ? '숏폼' : '롱폼';   // 영상 종류마다 고른 자막 스타일을 따로 기억해요
      const stored = opt.subBy[typeKey], byName = subs.findIndex((t) => String(t.n).includes(typeWord));
      const SH_F = (S.fonts.find((q) => /anemone|아네모네/i.test((q.family || '') + (q.label || ''))) || S.fonts.find((q) => /Ssurround/i.test(q.family)) || {}).family || 'Cafe24 Ssurround';
      const SHORTSUB = { kind: 'sub', font: SH_F, size: 70, color: '#ffffff', outline: 8, outlineColor: '#000000', x: 50, y: 70 };
      const subKey = stored !== undefined && (stored === 'def' || (stored === 'shorts' && ratio === '9:16') || subs[+String(stored).slice(1)]) ? stored : (byName >= 0 && (lecture || ratio !== '9:16' || String(subs[byName].n).includes('숏폼')) ? 'm' + byName : (ratio === '9:16' ? 'shorts' : (subs.length ? 'm' + (subs.length - 1) : 'def')));
      const titleKey = opt.title !== undefined && (['none', 'preset'].includes(opt.title) || titles[+opt.title.slice(1)]) ? opt.title : 'preset';
      const tplKey = opt.tpl !== undefined && (opt.tpl === 'none' || TPLS[+opt.tpl.slice(1)] || tpls[+opt.tpl.slice(1)]) ? opt.tpl : 't0';
      const cardsL = myCards(), cardKey = opt.card !== undefined && (opt.card === 'none' || (opt.card[0] === 'r' && CARD_RECS[+opt.card.slice(1)]) || (opt.card[0] === 'm' && cardsL[+opt.card.slice(1)])) ? opt.card : 'none';
      const stepCard = (() => {   // 강의 영상: 단계가 바뀔 때 넣을 제목 화면 설정
        if (!lecture || cardKey === 'none') return null;
        if (cardKey[0] === 'm') { const c = cardsL[+cardKey.slice(1)]; return { name: c.n, items: c.items }; }
        const c = CARD_RECS[+cardKey.slice(1)], fg = cardFg(c.col);
        return { name: c.n, seconds: 2.5, bg: { kind: 'bg', color: c.col, opacity: 100 }, small: c.small ? { kind: 'text', text: c.small, size: 56, y: c.low ? 64 : 36, x: 50, color: fg, outline: 0 } : null, title: { kind: 'text', text: c.title || '(그 단계의 주제 이름)', size: 120, y: c.low ? 42 : c.small ? 52 : 50, x: 50, color: fg, outline: 0 } };
      })();
      const cardSum = !stepCard ? '' : stepCard.items ? '내 제목 화면 · 배경 ' + ((stepCard.items.find((q) => q.kind === 'bg') || {}).color || '없음') + ' · 글자 ' + stepCard.items.filter((q) => q.kind === 'text').length + '개' : '배경 ' + stepCard.bg.color + ' · 위쪽 글 ' + (stepCard.small ? '"' + stepCard.small.text.replace('{n}', '번호') + '"' : '없음') + ' · 제목 크기 ' + stepCard.title.size + ' · 글자색 ' + (cardFg(stepCard.bg.color) === '#ffffff' ? '흰색' : '검정') + ' · ' + stepCard.seconds + '초';
      const styleOfKey = (k, list, def) => { if (k === 'shorts') return SHORTSUB; if (k === 'def' || k === 'preset') return def; const v = { kind: def.kind, ...list[+k.slice(1)].v }; return v; };   // 내 스타일은 저장한 값 그대로 써요 (가로라고 자동으로 줄이지 않아요)
      const settings = { 설명: '단동샘 편집기가 만든 편집 설정입니다. 편집파일_만드는법.txt 의 [편집설정.json] 설명대로 따라 주세요.', canvas: ratio,
        tpl: ratio === '9:16' ? (tplKey === 'none' ? null : { ...(tplKey[0] === 't' ? TPLS[+tplKey.slice(1)].v : tpls[+tplKey.slice(1)].v) }) : null,
        title: ratio === '9:16' && titleKey !== 'none' ? styleOfKey(titleKey, titles, TITLEDEF) : null,
        portrait: LAND ? (['rot90', 'rot270', 'keep'].includes(opt.por) ? opt.por : 'rot90') : null, subtitle: styleOfKey(subKey, subs, SUBDEF), subSplit: opt.split === 'fast' ? 'fast' : 'slow', lecture, stepCard, genre: lecture ? 'lecture' : (genre === 'none' ? null : genre), mode, voice, motion };
      post('/api/auto/settings', { path: sel.path, settings });
      const pick = (label, list, cur, set) => { const w = E('div', 'arow ap'); w.append(E('span', 'alab', label)); const c = chips(list, cur, (k) => { set(k); saveOpt(); draw(); }); c.classList.add('seg', 'wrapchips'); w.append(c); dz.append(w); };
      const dz = E('div'), dOpen = ld('vtk.autodesign', '0') === '1';   // 꾸미기(템플릿·제목·자막·자막 나누기)는 접어 두고 고른 것만 한 줄로 보여 줘요
      if (ratio === '9:16') {
        pick('템플릿', [['none', '🚫 없음'], ...TPLS.map((t, i) => ['t' + i, t.n]), ...tpls.map((t, i) => ['m' + i, '⭐ ' + t.n])], tplKey, (k) => { opt.tpl = k; });
        pick('쇼츠 제목', [['none', '🚫 안 넣기'], ['preset', '2줄 (흰색 / 노랑)'], ...titles.map((t, i) => ['m' + i, '⭐ ' + t.n])], titleKey, (k) => { opt.title = k; });
      }
      if (lecture) { pick('템플릿', [['none', '🚫 안 넣기'], ...CARD_RECS.map((c, i) => ['r' + i, c.n]).filter((_, i) => ['STEP 번호 + 제목', '자료 받기'].includes(CARD_RECS[i].n))], cardKey, (k) => { opt.card = k; }); if (cardSum) dz.append(E('div', 'apath', esc(cardSum))); }
      if (LAND) pick('세로 영상', [['rot90', '↻ 90° 돌려서 꽉 채우기'], ['rot270', '↺ 반대로 90°'], ['keep', '그대로 두기']], ['rot270', 'keep'].includes(opt.por) ? opt.por : 'rot90', (k) => { opt.por = k; });
      pick('자막', [['def', '기본'], ...(ratio === '9:16' ? [['shorts', '쇼츠 자막']] : []), ...subs.map((t, i) => ['m' + i, '⭐ ' + t.n])], subKey, (k) => { opt.subBy[typeKey] = k; });
      pick('자막 나누기', SPLIT_MODES, opt.split === 'fast' ? 'fast' : 'slow', (k) => { opt.split = k; });
      if (!subs.length) dz.append(E('div', 'apath', '기본 = 글꼴 Cafe24 쑥쑥 · 흰 글자 · 검정 테두리 ' + SUBDEF.outline + ' · 크기 ' + SUBDEF.size + ' · 가로 50% · 세로 ' + SUBDEF.y + '% · 편집기에서 "내 자막 스타일"을 저장하면 여기서 고를 수 있어요'));
      { const sum = [...dz.querySelectorAll('.chip.on')].map((b) => b.textContent.replace(/^[^0-9A-Za-z가-힣⭐]+/, '')).join(' · ');
        const hr = E('div', 'arow ap'); hr.append(E('span', 'alab', '꾸미기')); const hc = E('div', 'chips seg wrapchips'); const hb = E('button', 'chip', esc(sum) + (dOpen ? ' ▴' : ' ▾')); hb.title = dOpen ? '접기' : '템플릿·제목·자막 바꾸기'; hb.style.cssText = 'grid-column:1/-1;width:100%;max-width:none;white-space:normal;height:auto;min-height:44px;padding:8px 14px';
        hb.onclick = () => { sv('vtk.autodesign', dOpen ? '0' : '1'); draw(); }; hc.append(hb); hr.append(hc); dz.hidden = !dOpen; Rt.append(hr, dz); }
      const P = sel.path, R = P + info.sep + '결과', rt = ratio === '9:16' ? '9:16 세로 (쇼츠)' : '16:9 가로 (유튜브)', cv = ratio;
      const por = settings.portrait === 'keep' ? '세로로 찍은 영상은 돌리지 말고 그대로 둬.' : '세로로 찍은 영상(화면이 세로인 영상)은 가로 화면에 꽉 차도록 클립의 rot 를 ' + (settings.portrait === 'rot270' ? '270' : '90') + ' 으로 하고 fit 은 contain 으로 해 줘(자르거나 흐린 배경으로 채우지 마).';
      const tail0 = `영상 모양은 ${rt}야. .dsp 의 "canvas" 값은 "${cv}"로 해 줘. ${ratio === '9:16' ? '폴더 안의 "편집설정.json"에 적힌 템플릿·제목·자막 스타일을 그대로 .dsp 에 써 줘.' + (settings.title ? ' 쇼츠 제목은 영상 내용에 맞게 2줄로 지어 줘.' : '') : '가로 영상이라 제목 글자와 색 띠 템플릿은 넣지 마(.dsp 의 "tpl" 은 null, 제목 글자 항목은 만들지 마). 컷 편집(말 없는 구간·군말·반복 잘라내기)을 한 뒤 하단 자막만 넣고, 자막 스타일은 폴더 안 "편집설정.json"의 subtitle 값을 그대로 써 줘(가로 롱폼 크기라 쇼츠보다 작아). ' + por} 원본 영상은 이름도 내용도 바꾸지 말고 그대로 연결해 줘(비율 보정용 복사본은 만들지 마. 편집기가 알아서 맞춰). 내레이션이 있으면 영상 조각은 소리를 끄고 내레이션은 따로 audio 로 넣어 줘. 중간에 승인을 묻지 말고 끝까지 만들어 줘. 음성 인식이 안 되면 자막을 지어내지 말고 못 만들었다고 알려 줘.` + (lecture ? ' 이 영상은 시청자가 화면을 보며 따라 하는 강의(실습) 영상이야. "하단 자막만"은 제목 글자와 색 띠를 빼라는 뜻일 뿐, 화면 강조를 빼라는 뜻이 아니야. 버튼·메뉴·입력칸을 눌러야 하는 말이 나오는 순간에는 그 위치에 화살표나 네모 테두리를 넣고 누르는 순간에는 클릭 표시를 넣어 줘. 단계가 끝나거나 결과를 확인하는 순간에는 체크 표시를 넣고, 하면 안 되는 것은 ✖ 표시를 넣어 줘. 글씨가 작거나 좁은 영역을 보여 줄 때는 부드러운 확대를 넣어 줘. 예시 이미지나 비교 자료가 있으면 그 말을 하는 타이밍에 띄우고, 여러 곳을 한꺼번에 강조하지 말고 한 번에 한 곳씩 2~4초만 보여 줘. 자막과 중요한 글씨를 가리지 않게 해 줘. 위치를 확신할 수 없는 곳에는 넣지 마. 토큰을 아끼려고 화면 이미지는 "누르세요·클릭·선택·열어"처럼 위치가 필요한 말이 나온 시각에서만 가로 640px 이하로 줄여 보고(여러 장은 한 장에 모아서), 영상 한 편에 전체 20장을 넘기지 마. 확대와 체크는 이미지 없이 말의 타이밍만으로 넣어도 돼. 도형과 확대 만드는 법은 "편집파일_만드는법.txt"의 "강의·화면 녹화용 효과"에 있어. 끝나면 어떤 시각에 어떤 강조를 몇 개 넣었는지 알려 줘.' : '');
      const SPLIT_RULE = { fast: ' 자막은 "빠른 자막"으로 나눠 줘: 무조건 한 줄, 조사·어미 뒤에서 바로 끊어 1~2어절씩(공백 포함 8자 이내), 한 컷이 0.5~1초가 되게 톡톡 끊어 줘. 꾸미는 말과 조사 없는 말(예: "아침", "물 한")은 뒤 말과 붙여 줘. 예) 아침 공복에 / 따뜻한 / 물 한 잔을 / 마시면 / 혈액순환이 / 활발해지고 / 하루가 / 정말 / 가뿐해집니다. 자막 항목마다 "one": true 를 넣어 줘.', slow: ' 자막은 "느린 자막"으로 나눠 줘: 무조건 한 줄, 연결어미·종결어미에서 끊어 뜻이 끝나는 구나 짧은 절 단위로(공백 포함 8~13자, 뜻이 찢어지지 않게 최대 14자까지), 한 컷이 2초 이상 보이게 해 줘. 너무 길면 조사 뒤에서 나누고, 꾸미는 말(예: "따뜻한") 뒤에서는 끊지 마. 예) 아침 공복에 / 따뜻한 물 한 잔을 마시면 / 혈액순환이 활발해지고 / 하루가 정말 가뿐해집니다. 자막 항목마다 "one": true 를 넣어 줘.' };
      const GFILE = { tips: '생활꿀팁', docu: '다큐쇼핑', product: '상품소개', aigen: 'AI생성영상', overseas: '해외영상요약', lecture: '강의편집' }, gName = (GENRES.find((g) => g[0] === settings.genre) || [0, '📚 강의 편집'])[1].replace(/^\S+\s/, '');
      const MODE_RULE = { auto: '', step: ' 기획, 대본, 컷 계획을 만들 때마다 먼저 보여 주고 내가 좋다고 하면 다음 단계로 넘어가 줘.', text: ' 이번에는 .dsp 를 만들지 말고 글만 써 줘: 장르에 맞게 대본은 "결과" 폴더에 "대본.txt"로, AI 생성 영상이면 장면별 이미지·영상 생성 프롬프트를 "결과" 폴더에 "프롬프트.txt"로 저장해 줘.' };
      const GENRE_RULE = settings.genre ? ` 이 영상은 "${gName}" 영상이야. 폴더 안 "단동샘스킬/장르/${GFILE[settings.genre]}.md"를 읽고 그 규칙대로 만들어 줘.` : '';
      const GENRE_GPT = settings.genre ? ` 이 영상은 "${gName}" 영상이야. 첨부한 "${GFILE[settings.genre]}.md"를 읽고 그 규칙대로 만들어 줘.` : '';
      const VOICE_RULE = voice ? ' 내레이션은 내 목소리 대신 AI 목소리로 넣어 줘: 대본을 한 줄에 한 문장씩 "결과/대본.txt"로 저장한 뒤, "단동샘스킬/SKILL.md"의 "AI 목소리" 순서대로 단동샘스킬/scripts/narrate.py 를 실행해 이 폴더에 "내레이션.mp3"를 만들고(목소리·빠르기는 편집설정.json 의 voice), audio 에 넣어 줘. 영상 조각은 소리를 끄고 내레이션 길이에 맞춰 이어 붙이고, 자막은 narrate.py 가 만든 단어 시각으로 만들어 줘. 파이썬 실행이나 인터넷이 안 되면 대본.txt 만 저장하고 알려 줘.' : '';
      const MG_WHAT = { mix: '촬영 영상 위에 필요한 곳만 모션그래픽을 덮어(texts 의 kind "mg")', only: '영상 파일 없이 내레이션(또는 AI 목소리)에 맞춰 장면마다 모션그래픽 조각(clips 의 mg)으로 영상 전체를', multi: '폴더에 있는 실사·AI 영상·사진 조각과 모션그래픽 조각(clips 의 mg)을 섞어' };
      const MOTION_RULE = motion ? ` 이번엔 모션그래픽도 넣어 줘: ${MG_WHAT[motion.mode]} 만들어 줘. 폴더 안 "모션그래픽스킬/SKILL.md"(스킬 목록에 $dandongsam-motion 이 있으면 그것)를 읽고, "편집설정.json"의 motion 값(제작 모드·스타일·비중)과 "편집파일_만드는법.txt"의 [모션그래픽] 규격대로 .dsp 에 모션그래픽 설계도(mg)만 적어 줘. 모션그래픽 영상 파일은 직접 만들지 마(편집기가 열 때 만들어). 같은 모양을 연달아 쓰지 말고, 대본에 없는 숫자는 지어내지 마.` : '';
      const MOTION_GPT = motion ? MOTION_RULE.replace('폴더 안 "모션그래픽스킬/SKILL.md"(스킬 목록에 $dandongsam-motion 이 있으면 그것)', '첨부한 모션그래픽 "SKILL.md"').replace(' 모션그래픽 영상 파일은 직접 만들지 마(편집기가 열 때 만들어).', ' 모션그래픽 영상 파일이나 HTML 은 만들지 마(편집기가 열 때 만들어).') : '';
      const tail = tail0 + GENRE_RULE + (MODE_RULE[settings.mode] || '') + VOICE_RULE + MOTION_RULE + (SPLIT_RULE[settings.subSplit] || '') + (stepCard ? ' 강의에서 주제(단계)가 바뀌는 곳마다, 폴더 안 "편집설정.json"의 stepCard 대로 제목 화면을 넣어 줘: .dsp 의 texts 에 kind "bg"(color, opacity, start, end)인 색 배경 항목 하나와, 화면 가운데(x 50)에 제목을 보여 주는 kind "text" 항목(small 이 있으면 위쪽 작은 글 항목도)을 같은 시간(seconds 초 동안)으로 만들어 줘. 제목 글은 그 단계의 주제 이름으로 지어 주고, stepCard 에 items 가 있으면 그 항목들을 그대로 복사해서 start/end 만 맞춰 줘.' : '');
      const AI = {
        codex: { name: 'Codex', how: 'Codex에서 이 폴더를 작업 폴더로 열고 아래 말을 보내요. (영상이 커도 첨부 없이 돼요)', prompt: `이 폴더(${P})에 있는 영상과 소스를 편집해 줘. 스킬 목록에 $dandongsam-shorts-codex 가 있으면 그것을 써 줘. 폴더 안에 "단동샘스킬" 폴더가 있으면 그 안의 SKILL.md 를 먼저 읽고 그 순서와 scripts 안의 파이썬 스크립트를 그대로 따라 줘. 먼저 "편집파일_만드는법.txt"를 읽고, 불필요한 구간은 자르고 자막을 넣은 다음, 단동샘 편집기에서 열 수 있는 편집 파일(.dsp)을 "${R}" 폴더에 만들어 줘. ${tail}` },
        gpt: { name: 'ChatGPT', how: `채팅에 영상 파일과 폴더 안의 "편집파일_만드는법.txt", "편집설정.json", "받아적기" 폴더 안의 파일${settings.genre ? `, "단동샘스킬/장르/${GFILE[settings.genre]}.md"` : ''}${motion ? ', "모션그래픽스킬/SKILL.md"' : ''}을 첨부하고 아래 말을 보내요. 받은 .dsp 파일은 아래 "📥 받은 결과 가져오기"로 열어요.`, prompt: `첨부한 영상을 편집해 줘. 첨부한 "편집파일_만드는법.txt"와 "편집설정.json"을 읽고, 불필요한 구간은 자르고 자막을 넣은 다음, 단동샘 편집기에서 열 수 있는 편집 파일(.dsp)을 만들어서 파일로 줘. 첨부한 ".words.json" 파일(받아적기)이 있으면 음성 인식을 따로 하지 말고 그 단어 시각으로 말 없는 구간·군말·되풀이한 말을 잘라 영상을 여러 조각(clips 의 in/out)으로 나누고, 자막도 그 시각으로 만들어 줘. 받아적기 파일이 없고 소리를 알아들을 수 없으면 자막을 지어내지 말고 알려 줘. media 의 name 은 첨부한 영상 파일 이름 그대로(경로 없이) 쓰고, .dsp 는 설명(//) 없는 순수 JSON 으로, 시간은 초 단위 숫자로 써 줘. ${(GENRE_RULE ? tail.replace(GENRE_RULE, GENRE_GPT) : tail).replace(MOTION_RULE || '\u0000', MOTION_GPT)}` },
        claude: { name: 'Claude 앱', how: 'Claude 앱에서 이 폴더를 연결한 뒤 아래 말을 보내요.', prompt: `"${P}" 폴더에 있는 영상과 소스를 편집해 줘. 폴더 안에 "단동샘스킬" 폴더가 있으면 그 안의 SKILL.md 를 먼저 읽고 그 순서와 scripts 안의 파이썬 스크립트를 그대로 따라 줘. 먼저 폴더 안의 "편집파일_만드는법.txt"를 읽고, 불필요한 구간은 자르고 자막을 넣은 다음, 단동샘 편집기에서 열 수 있는 편집 파일(.dsp)을 "${R}" 폴더에 만들어 줘. ${tail} 폴더에 접근할 수 없으면 추측하지 말고 먼저 알려 줘.` },
        cc: { name: 'Claude Code', how: '아래 버튼으로 이 폴더에서 Claude Code 를 열고 문구를 붙여 넣어요. (직접 열 땐 폴더 주소창에 cmd 입력 → claude)', prompt: `현재 폴더(${P})에 있는 영상과 소스를 편집해 줘. 폴더 안에 "단동샘스킬" 폴더가 있으면 그 안의 SKILL.md 를 먼저 읽고 그 순서와 scripts 안의 파이썬 스크립트를 그대로 따라 줘. 먼저 "편집파일_만드는법.txt"를 읽고, 불필요한 구간은 자르고 자막을 넣은 다음, 단동샘 편집기에서 열 수 있는 편집 파일(.dsp)을 "${R}" 폴더에 만들어 줘. ${tail} 이 폴더의 파일이 보이지 않으면 추측하지 말고 먼저 알려 줘.`, term: true },
      };
      if (!AI[ai]) ai = 'codex';
      Rt.append(E('div', 'asub', 'AI에게 보낼 말'));
      const tabs = E('div', 'chips aitabs');   // 주로 쓰는 AI 하나만 보이고, 누르면 4개가 펼쳐져요
      if (!aiOpen) { const t = E('button', 'chip on', AI[ai].name + ' ▾'); t.title = '다른 AI 고르기'; t.onclick = () => { aiOpen = true; draw(); }; tabs.append(t); }
      else Object.keys(AI).forEach((k) => { const t = E('button', 'chip' + (ai === k ? ' on' : ''), AI[k].name); t.onclick = () => { ai = k; aiOpen = false; sv('vtk.autoai.v1', k); draw(); }; tabs.append(t); });
      Rt.append(tabs, E('div', 'ahow', esc(AI[ai].how)), E('div', 'abox', esc(AI[ai].prompt)));
      const row = E('div', 'abtns'); const cb = E('button', 'primary', '📋 스킬 복사'); cb.onclick = async () => { await copy(AI[ai].prompt); cb.textContent = '✅ 복사했어요'; setTimeout(() => { cb.textContent = '📋 스킬 복사'; }, 2000); }; row.append(cb);
      { // 🎤 받아 적기: 편집기가 작업 폴더의 영상 말소리를 먼저 글로 받아 적어 "받아적기" 폴더에 둬요 (AI가 그 시각으로 컷·자막을 만들어요)
        const at = sel.path, sm = sttMemo[at], sb = E('button', '', sm ? sm.t : '🎤 받아 적기'); if (sm) sb.disabled = sm.d; sb.title = '편집기가 이 폴더 영상의 말을 미리 받아 적어 "받아적기" 폴더에 둬요. AI가 이걸로 말 없는 구간을 자르고 자막을 만들어요 (ChatGPT는 이 파일도 첨부)';
        let polling = false;
        const paint = (st) => {
          if (!st || st.error) return; const j = st.job;
          if (st.dl.state === 'running') { sb.textContent = `⬇ 음성 인식 모델 받는 중 ${st.dl.pct}%`; sb.disabled = true; return true; }
          if (j.mine && j.state === 'running') { sb.textContent = `⏳ 받아 적는 중 ${j.pct}%`; sb.disabled = true; return true; }
          sb.disabled = false;
          if (st.dl.state === 'error') { sb.textContent = '🎤 받아 적기'; toast(st.dl.msg, null, 7000); return false; }
          sb.textContent = st.files && st.done >= st.files ? `✅ 받아 적기 끝 (${st.done}개)` : st.done ? `🎤 받아 적기 (${st.done}/${st.files})` : '🎤 받아 적기';
          return false;
        };
        const paint0 = paint; const paintM = (st) => { const v = paint0(st); sttMemo[at] = { t: sb.textContent, d: sb.disabled }; return v; };
        const wait = () => new Promise((r) => setTimeout(r, 900));
        const poll = async (started) => { if (polling) return; polling = true; let sawDl = false, sawRun = !!started;
          while (sel && sel.path === at && document.body.contains(sb)) {
            const st = await fetch('/api/auto/stt?path=' + encodeURIComponent(at)).then((x) => x.json()).catch(() => null); if (!st || st.error) break;
            if (paintM(st)) { if (st.dl.state === 'running') sawDl = true; else sawRun = true; await wait(); continue; }
            if (sawDl && st.have && !sawRun) { sawDl = false; const z = await post('/api/auto/stt', { path: at }); if (z.error) { toast(z.error, null, 6000); break; } sawRun = true; await wait(); continue; }   // 모델을 다 받았으면 바로 받아 적어요
            if (sawRun && st.job.mine && st.job.state === 'error') toast(st.job.err, null, 7000);
            else if (sawRun && st.job.mine && st.job.state === 'done') toast(st.files ? `받아 적었어요 (${st.done}/${st.files}개) → 받아적기 폴더` : '받아 적을 영상이 폴더에 없어요', null, 5000);
            break;
          }
          polling = false; };
        sb.onclick = async () => { const z = await post('/api/auto/stt', { path: at }); if (z.error) return toast(z.error, null, 6000); sb.disabled = true; poll(!!z.ok); };
        fetch('/api/auto/stt?path=' + encodeURIComponent(at)).then((x) => x.json()).then((st) => { if (paintM(st)) poll(); }).catch(() => {});
        row.append(sb);
      }
      if (AI[ai].term) { const tb = E('button', '', '▶ Claude Code 열기'); tb.onclick = async () => { const z = await post('/api/auto/terminal', { path: sel.path }); if (z.error) toast(z.error, null, 6000); }; row.append(tb); }
      Rt.append(row);
      { // 작업 폴더에 복사된 스킬 (단동샘스킬 폴더)
        const sk = E('div'); Rt.append(sk); const at = sel.path;
        const fill = (r) => {
          sk.innerHTML = ''; if (r.error) return; const off = r.off || [];
          const one = (name, icon, info, title) => {   // 스킬 하나: 이름 줄 + [보기] [폴더 열기] [✕]
            if (off.includes(name)) {   // 지운 스킬: 다시 넣을 수 있어요
              sk.append(E('div', 'apath', esc(icon + ' ' + name + ' · 지웠어요')));
              const rb = E('div', 'abtns'), bk = E('button', '', '↩ 다시 넣기'); bk.title = '편집기에 있는 원본을 이 작업 폴더에 다시 복사해요';
              bk.onclick = async () => { const z = await post('/api/auto/delete', { what: 'skillback', path: at, name }); if (z.error) return toast(z.error); delete skillMemo[at]; draw(); };
              rb.append(bk); sk.append(rb); return;
            }
            if (!info) return;
            const ln = E('div', 'apath', esc(icon + ' ' + name + ' · 파일 ' + info.files.length + '개')); ln.title = info.dir + '\n' + info.files.join('\n'); sk.append(ln);
            const br = E('div', 'abtns'), main = name === '단동샘스킬', open = () => (main ? skillOpen : !box.hidden);
            const vb = E('button', '', '📖 스킬 보기'); vb.title = title;
            const fb = E('button', '', '📁 스킬 폴더 열기'); fb.onclick = async () => { const z = await post('/api/auto/openfolder', { path: info.dir }); if (z.error) toast(z.error); };
            const xb = E('button', 'ajx', '✕'); xb.title = '이 작업 폴더에서 스킬 지우기 (편집기 안의 원본은 그대로)';
            xb.onclick = async () => {
              if (!(await ask(`'${name}'을(를) 이 작업 폴더에서 지울까요?\n지우면 AI가 이 작업에서 이 스킬을 쓰지 못해요. [다시 넣기]로 언제든 되돌릴 수 있어요.`, { danger: true, ok: '지우기' }))) return;
              const z = await post('/api/auto/delete', { what: 'skill', path: at, name }); if (z.error) return toast(z.error); delete skillMemo[at]; draw();
            };
            const box = E('div', 'abox'); box.textContent = info.text; box.style.whiteSpace = 'pre-wrap'; box.style.maxHeight = '320px'; box.style.overflow = 'auto'; box.hidden = main ? !skillOpen : true;
            vb.textContent = open() ? '📖 스킬 접기' : '📖 스킬 보기';
            vb.onclick = () => { box.hidden = !box.hidden; if (main) skillOpen = !box.hidden; vb.textContent = box.hidden ? '📖 스킬 보기' : '📖 스킬 접기'; };
            br.append(vb, fb, xb); sk.append(br, box);
          };
          if (!r.exists && !r.motion && !off.length) return;
          sk.append(E('div', 'asub', '복사된 스킬'));
          one('단동샘스킬', '📦', r.exists ? { dir: r.dir, files: r.files, text: r.text } : null, 'SKILL.md 내용 보기');
          if (motion || off.includes('모션그래픽스킬')) one('모션그래픽스킬', '🎬', r.motion, '모션그래픽 SKILL.md 내용 보기');   // 모션그래픽을 넣을 때만
        };
        if (skillMemo[at]) fill(skillMemo[at].r);
        fetch('/api/auto/skill?path=' + encodeURIComponent(at)).then((x) => x.json()).then((r) => {
          const key = JSON.stringify(r), old = skillMemo[at]; skillMemo[at] = { r, key };
          if (!sel || sel.path !== at || !document.body.contains(sk)) return;
          if (!old || old.key !== key) fill(r);   // 바뀐 게 있을 때만 다시 그려요
        }).catch(() => {});
      }
      // 결과
      Rt.append(E('div', 'asub', '완성된 결과 (눌러서 열기)'));
      { const ib = E('button', 'primary aimp', '📥 받은 결과(.dsp) 가져오기'); const fi = E('input'); fi.type = 'file'; fi.accept = '.dsp,.json,.txt'; fi.hidden = true; ib.onclick = async () => { const r = await post('/api/auto/pickfile', { path: sel.path, from: ai === 'gpt' ? 'downloads' : '' }); if (r.unsupported) return fi.click(); if (r.canceled) return; if (r.error) return toast(r.error, null, 6000); openResult({ file: r.file }); }; ib.title = 'ChatGPT 등에서 내려받은 .dsp 파일을 고르면 이 작업에 넣고 바로 열어요';
        fi.onchange = async () => { const f = fi.files[0]; if (!f) return; const txt = await f.text(); const r = await fetch('/api/auto/import?path=' + encodeURIComponent(sel.path) + '&name=' + encodeURIComponent(f.name), { method: 'POST', body: txt }).then((x) => x.json()).catch(() => ({ error: '서버에 연결할 수 없어요' })); if (r.error) return toast(r.error, null, 7000); openResult({ file: r.file }); };
        Rt.append(ib, fi); }
      const rl = E('div', 'ajobs res'); Rt.append(rl);
      if (!sel.results.length) rl.append(E('div', 'hint', '아직 결과가 없어요'));
      sel.results.forEach((it) => { const r = E('div', 'ajob'); const m = E('button', 'ajm', `<b>🎬 ${esc(it.name)}</b><small>${fmtDate(it.mtime)}</small>`); m.onclick = () => openResult(it);
        const x = E('button', 'ajx', '✕'); x.title = '이 결과 지우기'; x.onclick = async () => { if (!(await ask(`'${it.name}' 결과 파일을 지울까요?`, { danger: true, ok: '지우기' }))) return; const z = await post('/api/auto/delete', { what: 'result', path: it.file }); if (z.error) return toast(z.error); reload(); }; r.append(m, x); rl.append(r); });
    };
    const footer = () => {
      const f = E('div', 'afoot'); f.append(E('div', 'apath', '저장 위치: ' + esc(info.root)));
      const rb = E('button', 'sm', '위치 바꾸기'); rb.onclick = async () => { const pk = await post('/api/auto/pick'); let pth = pk.path; if (!pth && pk.canceled) return; if (!pth) pth = await askText('폴더 주소를 입력해 주세요', info.root); if (!pth) return; const z = await post('/api/auto/root', { path: pth }); if (z.error) return toast(z.error); reload(); };
      const bb = E('div', 'abtns'); bb.append(rb); f.append(bb); return f;
    };
    draw(); openModal(d);
  }
  $('#btn-auto').onclick = show;
})();



/* ============ 🏠 홈 화면 (프로그램을 켜면 먼저 보여요) ============ */
(function homeScreen() {
  const LK = 'vtk.links.v1', YT = 'UCTDxLD2JeQOimx6KIGfwtHw';
  const links = () => { try { return JSON.parse(localStorage.getItem(LK) || '{}'); } catch (e) { return {}; } };
  const setLinks = (o) => { try { localStorage.setItem(LK, JSON.stringify({ ...links(), ...o })); } catch (e) {} };
  const open = (u) => window.open(u, '_blank', 'noopener');
  let el = null;
  const hide = () => { if (el) { el.remove(); el = null; } };
  const cardList = (title, url, items, box) => {
    box.innerHTML = '';
    if (!items.length) { box.append(E('div', 'hm-empty', '최신 글을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.')); return; }
    items.slice(0, 6).forEach((it) => { const c = E('button', 'hm-card'); c.innerHTML = `<div class="hm-th" style="${it.thumb ? `--im:url('${esc(it.thumb)}')` : ''}"></div><div class="hm-tt">${esc(it.title)}</div>`; c.onclick = () => open(it.url); box.append(c); });
  };
  const RELEASE_PAGE = 'https://github.com/dandong5864/dandongsam-editor/releases/latest';
  // 설치할 때 윈도우의 파란 경고 창이 뜰 수 있어서, 미리 무엇을 누르면 되는지 그림으로 보여 줘요
  function smartGuide(title, okLabel, pre) {
    return new Promise((done) => {
      const bg = E('div', 'askbg'), bx = E('div', 'askbox sgbox');
      bx.append(E('div', 'ask-t', title));
      bx.append(E('div', 'ask-d', (pre ? pre + '\n\n' : '') + '설치할 때 아래처럼 파란 창이 뜰 수 있어요.\n① <b>추가 정보</b>를 누르고 ② <b>실행</b>을 누르면 설치돼요.'));
      const fig = E('div', 'sg-fig');
      fig.append(E('div', 'sg-win', '<div class="sg-h">Windows의 PC 보호</div><div class="sg-p">Microsoft Defender SmartScreen에서 인식할 수 없는 앱의 시작을 차단했습니다.</div><div class="sg-link">추가 정보<span class="sg-n">①</span></div><div class="sg-btns"><span class="sg-b">실행 안 함</span></div>'));
      fig.append(E('div', 'sg-arrow', '→'));
      fig.append(E('div', 'sg-win', '<div class="sg-h">Windows의 PC 보호</div><div class="sg-p">앱: DandongsamEditor-Setup.exe<br>게시자: 알 수 없는 게시자</div><div class="sg-btns"><span class="sg-b sg-hi">실행<span class="sg-n">②</span></span><span class="sg-b">실행 안 함</span></div>'));
      bx.append(fig);
      const row = E('div', 'ask-b'), no = E('button', '', '취소'), ok = E('button', 'primary', okLabel);
      const end = (v) => { bg.remove(); done(v); };
      no.onclick = () => end(false); ok.onclick = () => end(true); row.append(no, ok); bx.append(row);
      bg.append(bx); document.body.append(bg); ok.focus();
    });
  }
  async function runUpdate(u) {
    if (!(await smartGuide('새 버전으로 업데이트할까요?', '업데이트', '작업 중인 내용은 자동으로 저장되고, 설치하는 동안 편집기가 잠깐 꺼졌다가 다시 열려요.'))) return;
    try { saveLocalNow(); } catch (e) {}
    const bg = E('div', 'askbg'), bx = E('div', 'askbox'); const t = E('div', 'ask-t', '내려받는 중… 0%'), bar = E('div', 'upbar', '<i></i>'), row = E('div', 'ask-b');
    bx.append(t, bar, row); bg.append(bx); document.body.append(bg);
    const fail = (msg) => { t.textContent = msg; bar.remove(); row.innerHTML = ''; const lk = E('button', 'primary', '⬇ 직접 받으러 가기'); lk.onclick = async () => { if (await smartGuide('설치 파일을 직접 받으러 갈까요?', '받으러 가기')) window.open(RELEASE_PAGE, '_blank', 'noopener'); }; const cl = E('button', '', '닫기'); cl.onclick = () => bg.remove(); const rp = E('button', '', '🚩 오류 보내기'); rp.onclick = () => { bg.remove(); reportDialog('업데이트 실패: ' + msg); }; row.append(rp, cl, lk); };
    const st = await fetch('/api/update/start', { method: 'POST' }).then((r) => r.json()).catch(() => ({ ok: false }));
    if (!st.ok) return fail(st.error || '업데이트를 시작하지 못했어요');
    const poll = async () => {
      const x = await fetch('/api/update/status').then((r) => r.json()).catch(() => null); if (!x) return fail('서버와 연결이 끊겼어요');
      if (x.state === 'error') return fail(x.err || '내려받지 못했어요');
      if (x.state === 'ready') {
        t.textContent = '설치하고 있어요…\n잠시 후 편집기가 다시 열려요'; bar.querySelector('i').style.width = '100%';
        const r = await fetch('/api/update/install', { method: 'POST' }).then((q) => q.json()).catch(() => ({ ok: true }));   // 서버가 꺼지면 연결이 끊기는 게 정상이에요
        if (!r.ok) return fail(r.error || '설치하지 못했어요');
        if (r.test) { t.textContent = '(시험) 설치 단계까지 왔어요'; return; }
        setTimeout(() => { try { window.close(); } catch (e) {} }, 8000); return;
      }
      t.textContent = '내려받는 중… ' + x.pct + '%'; bar.querySelector('i').style.width = x.pct + '%'; setTimeout(poll, 500);
    };
    poll();
  }
  async function show() {
    hide(); el = E('div'); el.id = 'home';
    const wrap = E('div', 'hm-wrap'); el.append(wrap);
    wrap.append(E('div', 'hm-brand', '<span class="logo">▶</span> 단동샘 편집기'));
    addVer(wrap.lastChild);
    // 새 버전 알림 (인터넷이 안 되면 아무것도 안 보여요)
    fetch('/api/update/check').then((r) => r.json()).then((u) => { if (!u || !u.newer || !el) return; const bar = E('div', 'hm-upd'); bar.append(E('span', '', '🔔 새 버전 <b>v' + esc(u.latest) + '</b>이 나왔어요'));
      const ub = E('button', 'primary', '⬆ 업데이트'); ub.onclick = () => runUpdate(u); bar.append(ub); wrap.insertBefore(bar, wrap.children[1] || null); }).catch(() => {});
    // 시작하기
    const top = E('div', 'hm-top'); wrap.append(top);
    const big = E('button', 'hm-new', '<b>＋</b><span>새 동영상 만들기</span>'); big.onclick = () => { hide(); $('#btn-new').onclick(); };
    top.append(big);
    const side = E('div', 'hm-side'); top.append(side);
    if (S.clips.length) { const b = E('button', 'hm-btn cont', '↩ 이어서 편집하기'); b.onclick = hide; side.append(b); }
    const ba = E('button', 'hm-btn', 'AI 자동 편집'); ba.onclick = () => { hide(); $('#btn-auto').onclick(); }; side.append(ba);
    // 내 동영상
    wrap.append(E('h3', '', '내 동영상'));
    const pl = E('div', 'hm-grid'); wrap.append(pl);
    fetch('/api/projects').then((r) => r.json()).catch(() => []).then((l) => {
      if (!l.length) { pl.append(E('div', 'hm-empty', '아직 저장한 동영상이 없어요. 편집 중에 💾 저장을 눌러 보세요.')); return; }
      l.slice(0, 12).forEach((p) => { const c = E('button', 'hm-proj', `<div class="hm-pi">🎬</div><div class="hm-pn">${esc(p.name)}</div><small>${fmtDate(p.updated)} · 클립 ${p.clips}개</small>`);
        c.onclick = async () => { const j = await fetch('/api/project?id=' + p.id).then((x) => x.json()).catch(() => ({ error: '열 수 없어요' })); if (j.error) return toast(j.error); hide(); curProj = { id: j.id, name: j.name }; loadProjectData(j.data); openedNote(j); };
        const w = E('div', 'hm-pw'); const x = E('button', 'hm-pdel', '🗑 삭제'); x.title = '이 동영상 삭제';
        x.onclick = async (ev) => { ev.stopPropagation(); if (!(await ask(`'${p.name}' 동영상을 삭제할까요?\n되돌릴 수 없어요. 가져온 영상 파일은 지워지지 않아요`, { danger: true, ok: '삭제' }))) return; await fetch('/api/project?id=' + p.id, { method: 'DELETE' }); if (curProj && curProj.id === p.id) curProj = null; w.remove(); if (!pl.children.length) pl.append(E('div', 'hm-empty', '아직 저장한 동영상이 없어요. 편집 중에 💾 저장을 눌러 보세요.')); };
        const rv = E('button', 'hm-pdel hm-prev', '⏪ 되돌리기'); rv.title = '이전 상태로 되돌리기'; rv.onclick = (ev) => { ev.stopPropagation(); restoreDialog(p, hide); };
        w.append(c, x, rv); pl.append(w); });
    });
    const cols = E('div', 'hm-cols'); wrap.append(cols); const yc = E('div', 'hm-col'), bc = E('div', 'hm-col'), xc = E('div', 'hm-col'); cols.append(yc, bc, xc);
    // 유튜브
    const yh = E('div', 'hm-h yt'); yh.append(E('h3', '', '<i>▶</i>단동샘 유튜브')); const yb = E('button', 'hm-link', '채널 열기 ↗'); yb.onclick = () => open('https://www.youtube.com/channel/' + YT); yh.append(yb); yc.append(yh);
    const yg = E('div', 'hm-grid cards'); yc.append(yg); yg.append(E('div', 'hm-empty', '불러오는 중…'));
    fetch('/api/feed/youtube?channel=' + YT).then((r) => r.json()).catch(() => ({ list: [] })).then((r) => cardList('유튜브', '', r.list || [], yg));
    // 블로그
    const bh = E('div', 'hm-h lib'); bh.append(E('h3', '', '<i>📚</i>단동샘 자료실'));
    const bu = links().blog || 'https://happydandong.blogspot.com/';
    if (bu) { const bb = E('button', 'hm-link', '자료실 열기 ↗'); bb.onclick = () => open(/^https?:/i.test(bu) ? bu : 'https://' + bu); bh.append(bb); }
    bc.append(bh);
    const bg = E('div', 'hm-grid cards'); bc.append(bg);
    if (!bu) {
      const f = E('div', 'hm-setblog'); const i = E('input'); i.type = 'text'; i.placeholder = '자료실(블로그) 주소 (예: https://내블로그.blogspot.com)'; i.onkeydown = (e) => e.stopPropagation();
      const ok = E('button', 'primary', '저장'); ok.onclick = () => { const v = i.value.trim(); if (!v) return; setLinks({ blog: v }); show(); }; f.append(i, ok); bg.append(f);
    } else { bg.append(E('div', 'hm-empty', '불러오는 중…')); fetch('/api/feed/blog?url=' + encodeURIComponent(bu)).then((r) => r.json()).catch(() => ({ list: [] })).then((r) => cardList('블로그', bu, r.list || [], bg)); }
    // 자동 편집 예시 영상 (목록: public/examples.json) — 좋아요 많은 순서로, 숫자 없이 순위만 보여 줘요
    const xh = E('div', 'hm-h ex'); const xt = E('h3', '', '<i>✨</i><span>영상 갤러리</span>'); xh.append(xt); xc.append(xh); const xs = E('div', 'hm-sub', '♥ 좋아요를 눌러 주세요'); xc.append(xs);
    const xg = E('div', 'hm-grid cards'); xc.append(xg); xg.append(E('div', 'hm-empty', '불러오는 중…'));
    fetch('/api/feed/examples').then((r) => r.json()).catch(() => ({ list: [] })).then((r) => {
      if (r.title) xt.querySelector('span').textContent = r.title; if (r.hint) xs.textContent = r.hint;   // 칸 이름·안내 문구는 examples.json에서 바꿀 수 있어요
      if (r.canSend || r.form) { const fb = E('button', 'hm-link', '⬆ ' + (r.sendLabel || '영상 갤러리에 올리기')); fb.title = '이 편집기로 만든 영상 링크를 보내 주세요'; fb.onclick = () => (r.canSend ? brag(r.sendText, r.title, r.sendLabel) : open(r.form)); xh.append(fb); }
      if (r.more) { const xb = E('button', 'hm-link', '전체 보기 ↗'); xb.onclick = () => open(r.more); xh.append(xb); }
      xg.innerHTML = ''; const l = r.list || [];
      if (!l.length) { xg.append(E('div', 'hm-empty', '예시 영상을 준비하고 있어요.')); return; }
      l.forEach((it) => {
        const w = E('div', 'hm-exw'); const c = E('button', 'hm-card');
        c.innerHTML = `<div class="hm-th" style="${it.thumb ? `--im:url('${esc(it.thumb)}')` : ''}">${it.rank ? `<span class="hm-rank r${Math.min(it.rank, 4)}">${it.rank}위</span>` : ''}</div><div class="hm-tt">${esc(it.title)}</div>`;
        c.onclick = () => open(it.url); w.append(c);
        if (r.canLike) {
          const h = E('button', 'hm-like' + (it.liked ? ' on' : ''), it.liked ? '♥' : '♡'); h.title = it.liked ? '좋아요 취소' : '좋아요';
          h.onclick = async (ev) => { ev.stopPropagation(); if (h.disabled) return; h.disabled = true; const on = !h.classList.contains('on');
            const z = await fetch('/api/examples/like', { method: 'POST', body: JSON.stringify({ key: it.key, on }) }).then((x) => x.json()).catch(() => ({ error: '인터넷 연결을 확인해 주세요' }));
            h.disabled = false; if (z.error) return toast(z.error); h.classList.toggle('on', z.liked); h.textContent = z.liked ? '♥' : '♡'; h.title = z.liked ? '좋아요 취소' : '좋아요'; if (z.liked) toast('좋아요를 눌렀어요. 순위는 잠시 뒤에 바뀌어요'); };
          w.append(h);
        }
        xg.append(w);
      });
    });
    document.body.append(el);
  }
  // 영상 갤러리에 올리기: 링크만 붙여 넣으면 바로 보내져요 (단동샘이 확인한 뒤 갤러리에 올라가요)
  function brag(msg, box, label) {
    const d = E('div', 'dlg'); box = box || '영상 갤러리'; d.append(E('h2', '', '⬆ ' + esc(label || '영상 갤러리에 올리기')));
    const p = E('div', 'brag-msg'); p.textContent = msg || `단동샘 편집기로 만든 영상을 올려 주세요!\n제작된 영상 링크를 붙여 넣고 보내기를 누르면, 확인한 뒤 ${box}에 올라가요.`; d.append(p);
    const fld = (lb, ph) => { const f = E('div', 'f'); f.append(E('label', '', lb)); const i = E('input'); i.type = 'text'; i.placeholder = ph; i.onkeydown = (e) => e.stopPropagation(); f.append(i); d.append(f); return i; };
    const li = fld('영상 링크', '제작된 영상 링크를 붙여 넣어 주세요'), ti = fld('제목', '안 써도 돼요'), ni = fld('이름', '안 써도 돼요');
    const a2 = E('div', 'acts'); const c = E('button', '', '취소'); c.onclick = closeModal; const ok = E('button', 'primary', '보내기');
    ok.onclick = async () => { if (!li.value.trim()) { li.focus(); return toast('제작된 영상 링크를 붙여 넣어 주세요'); } ok.disabled = true;
      const z = await fetch('/api/examples/send', { method: 'POST', body: JSON.stringify({ link: li.value, title: ti.value, name: ni.value }) }).then((x) => x.json()).catch(() => ({ error: '서버에 연결할 수 없어요' }));
      ok.disabled = false; if (z.error) return toast(z.error); closeModal(); toast(`보냈어요! 확인한 뒤 ${box}에 올라가요`); };
    a2.append(c, ok); d.append(a2); openModal(d); li.focus();
  }
  window.__home = show;
  $('.brand').style.cursor = 'pointer'; $('.brand').title = '홈 화면'; $('.brand').onclick = show;
})();


/* ============ 🎙 목소리 → 자막 (Whisper large-v3-turbo) ============ */
function splitCaption(text, maxc) {
  const t = text.replace(/\s+/g, ' ').trim(); if (t.length <= maxc) return [t];
  const words = t.split(' '), out = []; let cur = '';
  words.forEach((w) => { if (cur && (cur + ' ' + w).length > maxc) { out.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w; });
  if (cur) out.push(cur); return out;
}
/* ⚡ 빠른 자막 / 🐢 느린 자막: 나누는 규칙은 subsplit.js */
const SPLIT_MODES = [['fast', '⚡ 빠른 자막'], ['slow', '🐢 느린 자막']];   // "기본"은 뺐어요. 고른 적 없으면 느린 자막
const SPLIT_TIP = { fast: '1~2어절 · 8자 이내 · 0.5~1초씩 톡톡 (젊은 층)', slow: '뜻이 끝나는 곳에서 · 8~13자 · 2초 이상 (어르신)' };
const splitMode = () => { try { const v = localStorage.getItem('vtk.subsplit'); return ['fast', 'slow'].includes(v) ? v : 'slow'; } catch (e) { return 'slow'; } };
const setSplitMode = (v) => { try { localStorage.setItem('vtk.subsplit', v); } catch (e) {} };
function putSplitSubs(list, mode, base) {   // 나눈 결과를 자막으로 넣어요. 무조건 한 줄: 가장 긴 줄이 화면 폭에 들어가게 글자 크기를 한꺼번에 맞춰요
  base = base || S.texts.find((t) => t.kind === 'sub') || {};
  const font = base.font || (S.fonts[0] && S.fonts[0].family) || 'sans-serif', outline = base.outline === undefined ? 8 : base.outline; let size = base.size || 86;
  const cx = document.createElement('canvas').getContext('2d'); cx.font = `${size}px "${font}", sans-serif`;
  const wMax = list.reduce((a, q) => Math.max(a, cx.measureText(q.text).width), 0) + outline * 2, room = 1080 * 0.92;
  if (wMax > room) size = Math.max(30, Math.floor(size * room / wMax));
  const keep = {}; ['box', 'boxColor', 'boxOpacity', 'boxRadius', 'colors'].forEach((k) => { if (base[k] !== undefined) keep[k] = base[k]; });
  list.forEach((q, i) => { const nx = list[i + 1]; let st = +q.start || 0, en = +q.end || st + (mode === 'slow' ? 2 : 0.7); if (nx && en > nx.start) en = nx.start;
    S.texts.push({ ...keep, colors: [], id: nid(), kind: 'sub', one: true, split: mode, start: +st.toFixed(2), end: +Math.max(st + 0.2, en).toFixed(2), text: q.text, color: base.color || '#ffffff', font, size, outline, outlineColor: base.outlineColor || '#000000', x: base.x === undefined ? 50 : base.x, y: base.y || 81 }); });
  return list.length;
}
function resplitSubs(mode) {   // 이미 있는 자막을 빠른/느린 자막으로 다시 나눠요 (시간은 원래 자막 시간 안에서 글자 수 비율로)
  const old = S.texts.filter((x) => x.kind === 'sub').sort((a, b) => a.start - b.start); if (!old.length) return toast('먼저 자막을 만들어 주세요');
  push(); const base = { ...old[0] }; S.texts = S.texts.filter((x) => x.kind !== 'sub');
  const n = putSplitSubs(subSplit(subSplit.fromSubs(old), mode), mode, base); changed(true); renderProps(); toast(`${mode === 'fast' ? '⚡ 빠른' : '🐢 느린'} 자막 ${n}개로 다시 나눴어요`);
}
async function sttDialog() {
  if (!S.clips.length) return toast('먼저 영상을 타임라인에 넣어 주세요');
  const api = (u, b) => fetch(u, b === undefined ? {} : { method: 'POST', body: JSON.stringify(b) }).then((r) => r.json()).catch(() => ({ error: '서버에 연결할 수 없어요' }));
  const d = E('div', 'dlg stt-dlg', '<h2>🎙 목소리로 자막 만들기</h2>');
  const info = E('div', 'ahow', '영상 속 말소리를 내 컴퓨터가 글로 바꿔요. 인터넷으로 영상이 나가지 않아요.');
  const bar = E('div', 'sttbar', '<i></i>'), msg = E('div', 'sttmsg', ''), opt = E('label', 'sttopt'), act = E('div', 'acts');
  const cb = E('input'); cb.type = 'checkbox'; cb.checked = S.texts.some((x) => x.kind === 'sub'); opt.append(cb, ' 만들기 전에 지금 자막을 모두 지우기');
  const modeRow = E('div', 'arow ap'); modeRow.append(E('span', 'alab', '자막 나누기'));
  const modeChips = E('div', 'chips seg'); SPLIT_MODES.forEach(([k, l]) => { const b = E('button', 'chip' + (splitMode() === k ? ' on' : ''), l); b.title = SPLIT_TIP[k] || '한 줄에 16자 안팎으로 묶어요'; b.onclick = () => { setSplitMode(k); [...modeChips.children].forEach((q) => q.classList.toggle('on', q === b)); }; modeChips.append(b); }); modeRow.append(modeChips);
  const go = E('button', 'primary bigbtn', '🎙 자막 만들기'), dl = E('button', 'primary bigbtn', '⬇ 음성 인식 모델 내려받기 (약 570MB · 한 번만)'), stop = E('button', 'bigbtn', '⏹ 멈추기'), close = E('button', '', '닫기');
  close.onclick = () => { alive = false; closeModal(); };
  act.append(close); d.append(info, modeRow, opt, dl, go, stop, bar, msg, act); openModal(d);
  let alive = true; const prog = (p) => { bar.firstChild.style.width = p + '%'; };
  const finish = (raw) => {
    // 단어 단위로 받았으면 실제 말한 시간에 맞춰 문장으로 묶어요 (아니면 문장 단위 그대로)
    let segs = raw; const avg = raw.reduce((a, q) => a + q.text.length, 0) / Math.max(1, raw.length), mode = splitMode();
    if (raw.length > 3 && avg <= 7) {
      const words = []; raw.forEach((q) => { if (q.sp || !words.length) words.push({ text: q.text, start: q.start, end: q.end }); else { const w = words[words.length - 1]; w.text += q.text; w.end = q.end; } });
      if (mode !== 'def') { push(); if (cb.checked) S.texts = S.texts.filter((x) => x.kind !== 'sub'); const n = putSplitSubs(subSplit(words, mode), mode); changed(true); closeModal(); alive = false; toast(`${mode === 'fast' ? '⚡ 빠른' : '🐢 느린'} 자막 ${n}개를 만들었어요. 틀린 글자는 목록에서 고쳐 주세요`, null, 7000); if (rtab === 'sub') renderProps(); return; }
      segs = []; let cur = null;
      words.forEach((w) => { if (cur && ((cur.text + ' ' + w.text).length > 16 || w.start - cur.end > 0.7 || /[.?!。]$/.test(cur.text))) { segs.push(cur); cur = null; } if (!cur) cur = { text: w.text, start: w.start, end: w.end }; else { cur.text += ' ' + w.text; cur.end = w.end; } });
      if (cur) segs.push(cur); segs.direct = true;
    }
    if (mode !== 'def' && !segs.direct) { push(); if (cb.checked) S.texts = S.texts.filter((x) => x.kind !== 'sub'); const n = putSplitSubs(subSplit(subSplit.fromSubs(segs), mode), mode); changed(true); closeModal(); alive = false; toast(`자막 ${n}개를 만들었어요. 틀린 글자는 목록에서 고쳐 주세요`, null, 7000); if (rtab === 'sub') renderProps(); return; }
    segs.forEach((q, i) => { const nx = segs[i + 1]; q.end = Math.min(q.end + 0.15, nx ? nx.start : q.end + 0.15); });
    push(); layout(); if (cb.checked) S.texts = S.texts.filter((x) => x.kind !== 'sub');
    const base = S.texts.find((t) => t.kind === 'sub') || {}; let n = 0;
    segs.forEach((sg) => { const parts = segs.direct ? [sg.text] : splitCaption(sg.text, 16), tot = parts.reduce((a, p) => a + p.length, 0) || 1; let t0 = sg.start;
      parts.forEach((p) => { const t1 = t0 + (sg.end - sg.start) * p.length / tot; S.texts.push({ id: nid(), kind: 'sub', start: +t0.toFixed(2), end: +Math.max(t0 + 0.2, t1).toFixed(2), text: p, colors: [], color: base.color || '#ffffff', font: base.font || (S.fonts[0] && S.fonts[0].family) || 'sans-serif', size: base.size || 86, outline: base.outline === undefined ? 8 : base.outline, outlineColor: base.outlineColor || '#000000', x: 50, y: base.y || 81 }); t0 = t1; n++; }); });
    changed(true); closeModal(); alive = false; toast(`자막 ${n}개를 만들었어요. 틀린 글자는 목록에서 고쳐 주세요`, null, 7000); if (rtab === 'sub') renderProps();
  };
  const tick = async () => {
    if (!alive) return; const st = await api('/api/stt/status'); if (!alive) return;
    dl.style.display = !st.have && st.dl.state !== 'running' ? '' : 'none';
    const dling = st.dl.state === 'running', running = st.job.state === 'running';
    go.style.display = st.have && !running ? '' : 'none'; stop.style.display = running ? '' : 'none'; opt.style.display = st.have && !running ? '' : 'none';
    bar.style.display = dling || running ? '' : 'none';
    if (dling) { prog(st.dl.pct); msg.textContent = st.dl.msg; }
    else if (running) { prog(st.job.pct); msg.textContent = `${st.job.msg} ${st.job.pct}%`; }
    else if (st.dl.state === 'error') msg.textContent = st.dl.msg;
    else if (st.job.state === 'error') msg.textContent = st.job.err;
    else if (st.job.state === 'done' && st.job.segs && waiting) { waiting = false; if (!st.job.segs.length) { msg.textContent = '목소리를 찾지 못했어요. 소리가 있는 영상인지 확인해 주세요'; } else return finish(st.job.segs); }
    else msg.textContent = st.have ? '' : '처음 한 번만 음성 인식 모델을 내려받아요.';
    setTimeout(tick, 900);
  };
  let waiting = false;
  dl.onclick = async () => { await api('/api/stt/download', {}); tick(); };
  go.onclick = async () => { layout(); const clips = S.clips.map((c) => ({ mediaId: c.mediaId, in: c.in, out: c.out, speed: c.speed || 1, start: c.start, mute: !!c.mute })); const r = await api('/api/stt/start', { clips, lang: 'ko' }); if (r.error) return toast(r.error); waiting = true; };
  stop.onclick = () => { waiting = false; api('/api/stt/stop', {}); };
  tick();
}


/* ===== 왼쪽 목록 → 타임라인으로 끌어다 놓기 ===== */
(function dropToTimeline() {
  const isOurs = (e) => [...(e.dataTransfer.types || [])].includes('text/x-vtk');
  const tAt = (e) => Math.max(0, (e.clientX - inner.getBoundingClientRect().left) / S.zoom);
  const insertAt = (t) => { let idx = 0, edge = 0; layout(); for (const c of S.clips) { if (c.start + dur(c) / 2 < t) { idx++; edge = c.start + dur(c); } } return { idx, edge }; };
  const hide = () => { $('#drop-line').style.display = 'none'; $('#drop-line').style.height = ''; clearIns(); };
  tlScroll.addEventListener('dragover', (e) => {
    if (!isOurs(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    const t = tAt(e), dl = $('#drop-line'); dl.style.display = 'block'; dl.style.top = $('#track-v').offsetTop + 'px';
    const onP = !!e.target.closest('#track-p'); if (onP) { dl.style.top = $('#track-p').offsetTop + 'px'; dl.style.height = $('#track-p').offsetHeight + 'px'; } else dl.style.height = '';
    { const ht = dragKind === 'pipv' ? $('#track-p') : dragKind === 'sticker' ? $('#track-k') : null; if (ht && ht.contains(e.target)) showIns(ht, laneHit(ht, e.clientY).line); else clearIns(); }
    const onV = !!e.target.closest('#track-v') || !!e.target.closest('#ruler'); dl.style.left = ((!onP && (onV || !S.clips.length) ? insertAt(t).edge : t) * S.zoom - 1) + 'px';
  });
  tlScroll.addEventListener('dragleave', (e) => { if (!tlScroll.contains(e.relatedTarget)) hide(); });
  tlScroll.addEventListener('drop', async (e) => {
    if (!isOurs(e)) return; e.preventDefault(); e.stopPropagation(); hide();
    let p; try { p = JSON.parse(e.dataTransfer.getData('text/x-vtk')); } catch (er) { return; }
    const t = tAt(e);
    if (p.k === 'media') {
      const m = S.media[p.id]; if (!m) return;
      if (m.hasVideo && e.target.closest('#track-p')) { addPip(m.id, t, null, null, laneHit($('#track-p'), e.clientY).lane); return; }
      const { idx } = insertAt(t);
      push(); layout();
      if (m.hasVideo) { const c = { id: nid(), mediaId: m.id, in: 0, out: defDur(m), ...dflt(), fit: (S.clips[0] && S.clips[0].fit) || 'contain' }; S.clips.splice(idx, 0, c); layout(); S.sel = { type: 'v', id: c.id }; changed(true); seek(c.start + 0.01, true); }
      else { S.audio.push({ id: nid(), mediaId: m.id, start: Math.round(t * 100) / 100, in: 0, out: m.duration, vol: 100 }); changed(true); }
    } else if (p.k === 'sticker') {
      push(); layout(); const x = { id: nid(), kind: 'sticker', sid: p.st.id, name: p.st.name, start: Math.round(t * 100) / 100, end: Math.round((t + 3) * 100) / 100, text: '', scale: p.st.builtin ? 80 : 30, rot: 0, x: 50, y: p.st.builtin ? 37 : 40 }; if (e.target.closest('#track-k')) x.lane = laneHit($('#track-k'), e.clientY).lane;
      S.texts.push(x); S.sel = { type: 't', id: x.id }; changed(true);
    } else if (p.k === 'sfx') {
      try { const m = await fetch('/api/sfx/add', { method: 'POST', body: JSON.stringify({ rel: p.rel, hide: true }) }).then((z) => z.json()); if (m.error) throw new Error(m.error);
        S.media[m.id] = m; push(); S.audio.push({ id: nid(), mediaId: m.id, start: Math.round(t * 100) / 100, in: 0, out: m.duration, vol: 100 }); changed(true); toast('추가했어요: ' + p.name); } catch (er) { toast('추가 실패: ' + er.message); }
    }
  });
})();


/* ============ 🎙 녹음하기 (영상을 보면서 내 목소리 녹음) ============ */
async function recordDialog() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast('이 창에서는 녹음을 쓸 수 없어요');
  const d = E('div', 'dlg rec-dlg', '<h2>🎙 녹음하기</h2>');
  const info = E('div', 'ahow', '재생 막대 위치부터 영상을 보면서 녹음해요. 스피커 소리가 같이 녹음되지 않게 이어폰을 쓰면 좋아요.');
  const sel = E('select'), meter = E('div', 'recmeter', '<i></i>'), msg = E('div', 'sttmsg', ''), opt = E('label', 'sttopt'), act = E('div', 'acts');
  const cb = E('input'); cb.type = 'checkbox'; cb.checked = true; opt.append(cb, ' 녹음하는 동안 영상 소리 끄기');
  const go = E('button', 'primary bigbtn', '⏺ 녹음 시작'), stop = E('button', 'bigbtn', '⏹ 녹음 끝내기'), close = E('button', '', '닫기'); stop.style.display = 'none';
  act.append(close); d.append(info, sel, meter, opt, go, stop, msg, act); openModal(d);
  let stream = null, rec = null, chunks = [], startAt = 0, raf = 0, ctx = null, wasMuted = false, alive = true;
  const cleanup = () => { alive = false; cancelAnimationFrame(raf); if (stream) stream.getTracks().forEach((t) => t.stop()); if (ctx) ctx.close().catch(() => {}); stream = null; };
  close.onclick = () => { if (rec && rec.state === 'recording') { rec.onstop = null; rec.stop(); if (playing) pause(); video.muted = wasMuted; } cleanup(); closeModal(); };
  const open = async (id) => {
    cancelAnimationFrame(raf); if (stream) stream.getTracks().forEach((t) => t.stop());
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) { msg.textContent = '마이크를 쓸 수 없어요. 마이크가 연결돼 있는지, 허용을 눌렀는지 확인해 주세요.'; go.disabled = true; return false; }
    go.disabled = false; msg.textContent = '마이크 준비됨 — 말해 보면 아래 막대가 움직여요';
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); const src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an); const buf = new Uint8Array(an.fftSize);
    const loop = () => { if (!alive) return; an.getByteTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v - 128)); meter.firstChild.style.width = Math.min(100, m / 128 * 160) + '%'; raf = requestAnimationFrame(loop); }; loop(); return true;
  };
  if (!(await open())) return;
  try { const ds = (await navigator.mediaDevices.enumerateDevices()).filter((x) => x.kind === 'audioinput'); ds.forEach((x, i) => { const o = E('option', '', esc(x.label || '마이크 ' + (i + 1))); o.value = x.deviceId; sel.append(o); }); } catch (e) {}
  sel.onchange = () => open(sel.value);
  go.onclick = async () => {
    go.style.display = 'none'; sel.disabled = true; cb.disabled = true;
    for (let n = 3; n > 0; n--) { msg.textContent = `${n}…`; await new Promise((r) => setTimeout(r, 800)); if (!alive) return; }
    startAt = Math.round(S.t * 100) / 100; chunks = [];
    const mt = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)); rec = new MediaRecorder(stream, mt ? { mimeType: mt } : undefined);
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      cleanup(); msg.textContent = '저장하는 중…'; stop.style.display = 'none';
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' }); const nm = '녹음_' + new Date().toTimeString().slice(0, 8).replace(/:/g, '');
      const m = await fetch('/api/record?name=' + encodeURIComponent(nm), { method: 'POST', body: blob }).then((r) => r.json()).catch(() => ({ error: '서버에 연결할 수 없어요' }));
      if (m.error) { msg.textContent = m.error; return; }
      S.media[m.id] = m; push(); S.audio.push({ id: nid(), mediaId: m.id, start: startAt, in: 0, out: m.duration, vol: 100 }); changed(true); closeModal(); toast('녹음을 추가했어요 (추가 소리 줄)', null, 4000);
    };
    wasMuted = video.muted; if (cb.checked) video.muted = true;
    rec.start(250); stop.style.display = ''; msg.textContent = '🔴 녹음 중…';
    if (S.clips.length) play();
  };
  stop.onclick = () => { if (playing) pause(); video.muted = wasMuted; rec.stop(); };
}

/* ============ ✨ 효과: 장면 전환 · 모자이크/블러 ============ */
function applyTrans() {
  const vb = $('#vbox'), tf = $('#trfx'); if (!vb || !tf) return;
  let op = 1, sc = 1, white = 0;
  if (S.clips.length) {
    const lc = locate(S.t), c = lc.c, i = lc.i, p = S.t - c.start, rem = c.start + dur(c) - S.t, tr = c.trans;
    if (tr && tr.type && tr.type !== 'none') { const D = Math.min(tr.dur || 0.5, dur(c) / 2); if (p >= 0 && p < D) { const u = clamp(p / D, 0, 1); if (tr.type === 'black') op = u; else if (tr.type === 'white') white = 1 - u; else if (tr.type === 'zoom') { op = u; sc = 1 + 0.35 * (1 - u); } } }
    const nt = S.clips[i + 1] && S.clips[i + 1].trans;
    if (nt && (nt.type === 'black' || nt.type === 'white')) { const D = Math.min(nt.dur || 0.5, dur(c) / 2); if (rem > 0 && rem < D) { const u = clamp(rem / D, 0, 1); if (nt.type === 'black') op = Math.min(op, u); else white = Math.max(white, 1 - u); } }
  }
  const z = zoomState(S.t);
  vb.style.transformOrigin = z.Z !== 1 ? `${z.fx}% ${z.fy}%` : '';
  vb.style.opacity = op; vb.style.transform = [sc !== 1 ? `scale(${sc})` : '', z.Z !== 1 ? `scale(${z.Z})` : ''].filter(Boolean).join(' '); tf.style.opacity = white;
}
/* 부드러운 확대: 시작·끝에서 서서히 커졌다 돌아와요 (미리보기와 내보내기 계산이 같아요) */
function zoomState(t) {
  let Z = 1, best = 0, fx = 50, fy = 50;
  S.texts.forEach((x) => {
    if (x.kind !== 'zoom' || t < x.start || t >= x.end) return;
    const e = Math.max(0.05, Math.min(x.ease == null ? 0.5 : x.ease, (x.end - x.start) / 2));
    const m = smooth01(Math.min((t - x.start) / e, (x.end - t) / e));
    Z += ((x.scale || 150) / 100 - 1) * m; if (m >= best) { best = m; fx = x.x; fy = x.y; }
  });
  return { Z: Math.round(Z * 1000) / 1000, fx, fy };
}
function addZoom() {
  push(); layout();
  const x = { id: nid(), kind: 'zoom', scale: 150, ease: 0.5, start: Math.round(S.t * 100) / 100, end: Math.round((S.t + 3) * 100) / 100, text: '', x: 50, y: 50 };
  S.texts.push(x); S.sel = { type: 't', id: x.id }; changed(true); if (ltab === 'fx') buildLeft();
}
function renderZoomProps(p, x) {
  const upd = () => { renderTL(); renderOv(true); applyTrans(); saveLocal(); };
  p.append(E('div', 'sel-title', '확대 효과'));
  p.append(slider('확대 크기', 110, 400, 5, x.scale || 150, (v) => v + '%', (v) => { x.scale = v; upd(); }, 150));
  p.append(slider('커지는 속도', 0.1, 2, 0.1, x.ease == null ? 0.5 : x.ease, (v) => v + '초', (v) => { x.ease = v; upd(); }, 0.5));
  p.append(sec('어디를 크게 볼까요 (미리보기의 🔍를 끌어도 돼요)'));
  p.append(slider('가로 위치', 0, 100, 0.5, x.x, (v) => v + '%', (v) => { x.x = v; upd(); }, 50));
  p.append(slider('세로 위치', 0, 100, 0.5, x.y, (v) => v + '%', (v) => { x.y = v; upd(); }, 50));
  p.append(sec('나오는 시간'));
  const r2 = E('div', 'row2');
  r2.append(timeBox('시작', x.start, (t) => { push(); x.start = clamp(t, 0, x.end - 0.2); changed(true); }), timeBox('끝', x.end, (t) => { push(); x.end = Math.max(x.start + 0.2, t); changed(true); }));
  p.append(r2);
}
function addFx(mode) {
  push(); layout();
  const x = { id: nid(), kind: 'fx', mode, level: 50, start: Math.round(S.t * 100) / 100, end: Math.round((S.t + 3) * 100) / 100, text: '', x: 50, y: 40, w: 28, h: 28 };
  S.texts.push(x); S.sel = { type: 't', id: x.id }; changed(true); if (ltab === 'fx') buildLeft();
}
function renderFxProps(p, x) {
  const upd = () => { renderTL(); renderOv(true); saveLocal(); };
  p.append(E('div', 'sel-title', x.mode === 'blur' ? '블러' : '모자이크'));
  { const mc = chips([['mosaic', '▦ 모자이크'], ['blur', '🌫 블러']], x.mode, (v) => { push(); x.mode = v; renderProps(); upd(); }); mc.classList.add('wide2'); p.append(mc); }
  p.append(slider('세기', 1, 100, 1, x.level || 50, (v) => v, (v) => { x.level = v; upd(); }, 50));
  p.append(sec('크기·위치'));
  p.append(slider('너비', 2, 150, 0.5, x.w, (v) => v + '%', (v) => { x.w = v; upd(); }, 28));
  p.append(slider('높이', 2, 150, 0.5, x.h, (v) => v + '%', (v) => { x.h = v; upd(); }, 28));
  p.append(slider('가로 위치', 0, 100, 0.5, x.x, (v) => v + '%', (v) => { x.x = v; upd(); }, 50));
  p.append(slider('세로 위치', 0, 100, 0.5, x.y, (v) => v + '%', (v) => { x.y = v; upd(); }, 40));
  p.append(sec('나오는 시간'));
  const r2 = E('div', 'row2');
  r2.append(timeBox('시작', x.start, (t) => { push(); x.start = clamp(t, 0, x.end - 0.1); changed(true); }), timeBox('끝', x.end, (t) => { push(); x.end = Math.max(x.start + 0.1, t); changed(true); }));
  p.append(r2);
}
function buildFxTab(d) {
  d.append(sec('모션그래픽'));
  { const r = E('div', 'chips wide2'); Object.entries(MG.TYPES).forEach(([k, v]) => { const b = E('button', 'chip', v.ico + ' ' + v.n); b.title = v.tip; b.onclick = () => mgDialog({ type: k }, (s, len) => mgAdd(s, len)); r.append(b); }); d.append(r); }
  { const ml = S.texts.filter((x) => x.kind === 'pip' && x.mg).sort((a, b) => a.start - b.start); if (ml.length) { d.append(E('h4', '', '넣은 모션그래픽')); ml.forEach((x) => { const row = E('div', 'titem' + (isSel('t', x.id) ? ' sel' : '')); row.append(E('span', 'tm', fmt(x.start, 1)), E('span', 'tx', esc(MG.label(x.mg)))); row.onclick = () => { select('t', x.id); seek(x.start + 0.01); }; d.append(row); }); } }
  d.append(sec('모자이크 · 블러 (가릴 부분)'));
  const r = E('div', 'chips wide2'); const m1 = E('button', 'chip', '▦ 모자이크 추가'), m2 = E('button', 'chip', '🌫 블러 추가'); m1.onclick = () => addFx('mosaic'); m2.onclick = () => addFx('blur'); r.append(m1, m2); d.append(r);
  d.append(sec('확대 효과')); const zr = E('div', 'chips wide2'); const zb = E('button', 'chip', '＋ 추가'); zb.onclick = addZoom; zr.append(zb); d.append(zr);
  const zl = S.texts.filter((x) => x.kind === 'zoom').sort((a, b) => a.start - b.start);
  if (zl.length) { d.append(E('h4', '', '넣은 확대')); zl.forEach((x) => { const row = E('div', 'titem' + (isSel('t', x.id) ? ' sel' : '')); row.append(E('span', 'tm', fmt(x.start, 1)), E('span', 'tx', '확대 ' + (x.scale || 150) + '%')); row.onclick = () => { select('t', x.id); seek(x.start + 0.01); }; d.append(row); }); }
  const fl = S.texts.filter((x) => x.kind === 'fx').sort((a, b) => a.start - b.start);
  if (fl.length) { d.append(E('h4', '', '넣은 효과')); fl.forEach((x) => { const row = E('div', 'titem' + (isSel('t', x.id) ? ' sel' : '')); row.append(E('span', 'tm', fmt(x.start, 1)), E('span', 'tx', x.mode === 'blur' ? '블러' : '모자이크')); row.onclick = () => { select('t', x.id); seek(x.start + 0.01); }; d.append(row); }); }
}

/* ============ 도형 (사각형 · 원) ============ */
const hexA = (h, a) => { h = String(h || '#000000').replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); const n = parseInt(h, 16) || 0; return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp(a, 0, 1)})`; };
const SHAPE_NAMES = { rect: '사각형', ellipse: '원', arrow: '화살표', check: '체크 표시', cross: 'X 표시', checkbox: '체크박스', pointer: '마우스 포인터', click: '클릭 표시', badge: '번호 동그라미', hand: '손가락 포인터', handclick: '손가락 클릭', heart: '하트', star: '별', triangle: '삼각형', diamond: '마름모', pentagon: '오각형', hexagon: '육각형', plus: '더하기', bolt: '번개', chevron: '꺾쇠', darrow: '양쪽 화살표', bubble: '말풍선', bubble2: '둥근 말풍선', qmark: '물음표', emark: '느낌표', qbadge: '물음표 동그라미', ebadge: '느낌표 동그라미', cloud: '구름', sparkle: '반짝임', burst: '강조 폭발', turn: '되돌아가는 화살표', para: '평행사변형', banner: '리본', bulb: '전구', magnifier: '돋보기', ring: '링', prohibit: '금지' };
const GLYPH = { qmark: '?', emark: '!' }, BADGE_CH = { qbadge: '?', ebadge: '!' };
const SHAPE_PTS = {
  arrow: [[0, .3], [.58, .3], [.58, 0], [1, .5], [.58, 1], [.58, .7], [0, .7]],
  check: [[.04, .56], [.2, .4], [.4, .6], [.8, .08], [.96, .24], [.4, .92]],
  cross: [[.2, 0], [.5, .3], [.8, 0], [1, .2], [.7, .5], [1, .8], [.8, 1], [.5, .7], [.2, 1], [0, .8], [.3, .5], [0, .2]],
  pointer: [[0, 0], [0, .86], [.21, .67], [.36, 1], [.5, .94], [.35, .62], [.64, .62]],
  star: [[0.5,0.04],[0.618,0.378],[0.976,0.385],[0.69,0.602],[0.794,0.945],[0.5,0.74],[0.206,0.945],[0.31,0.602],[0.024,0.385],[0.382,0.378]],
  triangle: [[.5, 0], [1, 1], [0, 1]], diamond: [[.5, 0], [1, .5], [.5, 1], [0, .5]],
  pentagon: [[0.5,0.03],[0.976,0.375],[0.794,0.935],[0.206,0.935],[0.024,0.375]],
  hexagon: [[.25, 0], [.75, 0], [1, .5], [.75, 1], [.25, 1], [0, .5]],
  plus: [[.35, 0], [.65, 0], [.65, .35], [1, .35], [1, .65], [.65, .65], [.65, 1], [.35, 1], [.35, .65], [0, .65], [0, .35], [.35, .35]],
  bolt: [[.6, 0], [.12, .58], [.46, .58], [.34, 1], [.88, .4], [.52, .4]],
  chevron: [[0, 0], [.45, 0], [1, .5], [.45, 1], [0, 1], [.55, .5]],
  sparkle: [[.5,0],[.62,.38],[1,.5],[.62,.62],[.5,1],[.38,.62],[0,.5],[.38,.38]],
  burst: [[0.5,0.0],[0.596,0.143],[0.75,0.067],[0.762,0.238],[0.933,0.25],[0.857,0.404],[1.0,0.5],[0.857,0.596],[0.933,0.75],[0.762,0.762],[0.75,0.933],[0.596,0.857],[0.5,1.0],[0.404,0.857],[0.25,0.933],[0.238,0.762],[0.067,0.75],[0.143,0.596],[0.0,0.5],[0.143,0.404],[0.067,0.25],[0.238,0.238],[0.25,0.067],[0.404,0.143]],
  para: [[.22,0],[1,0],[.78,1],[0,1]], banner: [[0,.1],[1,.1],[.9,.5],[1,.9],[0,.9],[.1,.5]],
  darrow: [[0, .5], [.2, .12], [.2, .34], [.8, .34], [.8, .12], [1, .5], [.8, .88], [.8, .66], [.2, .66], [.2, .88]]
};
// 곡선이 있는 도형 (가로·세로 100 칸 안에 그린 선)
const SHAPE_D = {
  heart: 'M50 97C8 63 0 41 0 27C0 11 12 2 26 2C36 2 45 8 50 18C55 8 64 2 74 2C88 2 100 11 100 27C100 41 92 63 50 97Z',
  bubble: 'M16 4H84Q98 4 98 18V58Q98 72 84 72H48L26 96L30 72H16Q2 72 2 58V18Q2 4 16 4Z',
  cloud: 'M26 84C11 84 2 72 2 59C2 46 12 38 25 38C28 20 42 8 60 8C77 8 90 20 92 36C97 40 99 48 99 58C99 72 88 84 74 84Z',
  turn: 'M8 96C8 44 36 22 68 22V4L98 32L68 60V42C46 42 28 58 28 96Z',
  bulb: 'M50 2C28 2 12 18 12 38C12 52 20 60 28 70C32 75 33 80 33 86H67C67 80 68 75 72 70C80 60 88 52 88 38C88 18 72 2 50 2ZM36 91H64V98H36Z',
  magnifier: 'M42 3A39 39 0 1 1 42 81A39 39 0 1 1 42 3ZM42 19A23 23 0 1 0 42 65A23 23 0 1 0 42 19ZM67 62L79 50L98 71L86 83Z',
  ring: 'M50 2A48 48 0 1 1 50 98A48 48 0 1 1 50 2ZM50 18A32 32 0 1 0 50 82A32 32 0 1 0 50 18Z',
  prohibit: 'M50 2A48 48 0 1 1 50 98A48 48 0 1 1 50 2ZM50 16A34 34 0 1 0 50 84A34 34 0 1 0 50 16ZM22 33L33 22L78 67L67 78Z',
  bubble2: 'M50 4C24 4 3 21 3 41C3 53 10 63 21 70L15 97L46 77C47 77 49 77 50 77C76 77 97 61 97 41C97 21 76 4 50 4Z'
};
const SHAPE_START = { qmark: { w: 13, h: 18, fillColor: '#FF3B30', stroke: true, strokeColor: '#ffffff', strokeW: 6 }, emark: { w: 9, h: 18, fillColor: '#FF3B30', stroke: true, strokeColor: '#ffffff', strokeW: 6 }, qbadge: { w: 10, h: 10, fillColor: '#2F80ED' }, ebadge: { w: 10, h: 10, fillColor: '#FF3B30' }, cloud: { w: 26, h: 18, fillColor: '#ffffff', stroke: true, strokeColor: '#000000', strokeW: 5 }, sparkle: { w: 14, h: 14, fillColor: '#FFD60A' }, burst: { w: 22, h: 22, fillColor: '#FFD60A', stroke: true, strokeColor: '#FF3B30', strokeW: 5 }, turn: { w: 18, h: 16, fillColor: '#FF3B30', stroke: true, strokeColor: '#ffffff', strokeW: 4 }, para: { w: 28, h: 12 }, banner: { w: 34, h: 12, fillColor: '#FF3B30' }, bulb: { w: 12, h: 18, fillColor: '#FFD60A' }, magnifier: { w: 15, h: 15, fillColor: '#2F80ED' }, ring: { w: 16, h: 16, fillColor: '#FF3B30' }, prohibit: { w: 16, h: 16, fillColor: '#FF3B30' }, heart: { w: 18, h: 17, fillColor: '#FF3B30' }, star: { w: 18, h: 17, fillColor: '#FFD60A' }, triangle: { w: 18, h: 16 }, diamond: { w: 16, h: 18 }, pentagon: { w: 18, h: 17 }, hexagon: { w: 18, h: 16 }, plus: { w: 15, h: 15, fillColor: '#22C55E' }, bolt: { w: 12, h: 18 }, chevron: { w: 12, h: 16 }, darrow: { w: 28, h: 12, fillColor: '#FF3B30', stroke: true, strokeColor: '#ffffff', strokeW: 4 }, bubble: { w: 28, h: 22, fillColor: '#ffffff', stroke: true, strokeColor: '#000000', strokeW: 5 }, bubble2: { w: 28, h: 22, fillColor: '#ffffff', stroke: true, strokeColor: '#000000', strokeW: 5 }, hand: { w: 10, h: 12, fillColor: '#ffffff', stroke: true, strokeColor: '#000000', strokeW: 5 }, handclick: { w: 13, h: 15, fillColor: '#ffffff', stroke: true, strokeColor: '#000000', strokeW: 5 }, badge: { w: 9, h: 9, fillColor: '#FF3B30', num: '1', numColor: '#ffffff' }, arrow: { w: 26, h: 13, fillColor: '#FF3B30', stroke: true, strokeColor: '#ffffff', strokeW: 4 }, click: { w: 9, h: 9, fillColor: '#FFE14D', fillOpacity: 45, stroke: true, strokeColor: '#FFD21F', strokeW: 6 }, check: { w: 12, h: 12, fillColor: '#22C55E' }, cross: { w: 12, h: 12, fillColor: '#FF3B30' }, checkbox: { w: 12, h: 12, fill: false, stroke: true, strokeColor: '#ffffff', strokeW: 8, radius: 15, checkColor: '#22C55E' }, pointer: { w: 9, h: 12, fillColor: '#ffffff', stroke: true, strokeColor: '#000000', strokeW: 4, shadow: true } };
const SHAPE_DEF = { fill: true, fillColor: '#FFFD00', fillOpacity: 100, stroke: false, strokeColor: '#ffffff', strokeW: 6, strokeStyle: 'solid', strokeOpacity: 100, radius: 0, shadow: false, shadowColor: '#000000', shadowOpacity: 60, shadowBlur: 12, shadowX: 6, shadowY: 8, opacity: 100, lock: true };
// 도형을 캔버스에 그림 (미리보기와 내보내기가 똑같이 이 함수를 써요). Wc = 화면 가로 픽셀
const HAND_D = 'M36 12 a7 7 0 0 1 14 0 L50 46 a6 6 0 0 1 12 0 L62 52 a6 6 0 0 1 12 0 L74 58 a6 6 0 0 1 12 0 L86 82 Q86 108 62 112 L44 112 Q32 112 26 100 L10 74 Q6 66 14 62 Q20 60 25 66 L36 80 Z';
function drawShape(x, Wc) {
  const k = Wc / 1080, w = Math.max(1, x.w / 100 * Wc), h = Math.max(1, x.h / 100 * Wc), sw = x.stroke ? Math.max(0, x.strokeW) * k : 0;
  const sb = x.shadow ? x.shadowBlur * k : 0, sx = x.shadow ? x.shadowX * k : 0, sy = x.shadow ? x.shadowY * k : 0;
  const pad = Math.ceil(sw / 2 + sb * 2 + Math.max(Math.abs(sx), Math.abs(sy)) + 3);
  const rot = (x.rot || 0) * Math.PI / 180, ca = Math.abs(Math.cos(rot)), sa = Math.abs(Math.sin(rot));
  const CW = Math.ceil(w * ca + h * sa + 2 * pad), CH = Math.ceil(w * sa + h * ca + 2 * pad);
  const cv = document.createElement('canvas'); cv.width = CW; cv.height = CH; const g = cv.getContext('2d');
  g.translate(CW / 2, CH / 2); g.rotate(rot);
  g.beginPath(); let P2 = null, SPARK = null;
  if (x.shape === 'hand' || x.shape === 'handclick') {   // 손가락 모양 (직접 그린 벡터)
    const click = x.shape === 'handclick', VH = click ? 130 : 120, dy = click ? 10 : 0;
    const mt = new DOMMatrix().translate(-w / 2, -h / 2).scale(w / 100, h / VH).translate(0, dy);
    P2 = new Path2D(); P2.addPath(new Path2D(HAND_D), mt);
    if (click) { SPARK = new Path2D(); [-90, -135, -45, 180, 0].forEach((ag) => { const r = ag * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); const sp = new Path2D(); sp.moveTo(43 + 14 * c, 22 + 14 * s); sp.lineTo(43 + 22 * c, 22 + 22 * s); SPARK.addPath(sp, new DOMMatrix().translate(-w / 2, -h / 2).scale(w / 100, h / VH)); }); }
  } else if (SHAPE_D[x.shape]) { P2 = new Path2D(); P2.addPath(new Path2D(SHAPE_D[x.shape]), new DOMMatrix().translate(-w / 2, -h / 2).scale(w / 100, h / 100)); } else
  if (x.shape === 'ellipse' || x.shape === 'click' || x.shape === 'badge' || BADGE_CH[x.shape]) g.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (SHAPE_PTS[x.shape]) { SHAPE_PTS[x.shape].forEach(([u, v], i) => { const px = (u - 0.5) * w, py = (v - 0.5) * h; if (i) g.lineTo(px, py); else g.moveTo(px, py); }); g.closePath(); }
  else { const r = Math.min(clamp((x.radius || 0) / 100, 0, 0.5) * Math.min(w, h), w / 2, h / 2), l = -w / 2, t = -h / 2; g.moveTo(l + r, t); g.arcTo(l + w, t, l + w, t + h, r); g.arcTo(l + w, t + h, l, t + h, r); g.arcTo(l, t + h, l, t, r); g.arcTo(l, t, l + w, t, r); g.closePath(); }
  const setShadow = () => { if (x.shadow) { g.shadowColor = hexA(x.shadowColor, (x.shadowOpacity == null ? 60 : x.shadowOpacity) / 100); g.shadowBlur = sb; g.shadowOffsetX = sx; g.shadowOffsetY = sy; } };
  const noShadow = () => { g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetX = 0; g.shadowOffsetY = 0; };
  const GL = GLYPH[x.shape];
  const glyph = (st) => { g.save(); const fs = h * 0.92; g.font = `800 ${fs}px "Cafe24 Ssurround", "Malgun Gothic", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; const m = g.measureText(GL).width || 1; g.scale(w / m, 1); if (st) g.strokeText(GL, 0, fs * 0.04); else g.fillText(GL, 0, fs * 0.04); g.restore(); };
  let shadowed = false;
  if (x.fill) { setShadow(); shadowed = true; g.fillStyle = hexA(x.fillColor, (x.fillOpacity == null ? 100 : x.fillOpacity) / 100); if (GL) glyph(0); else if (P2) g.fill(P2); else g.fill(); noShadow(); }
  if (x.stroke && sw > 0) {
    if (!shadowed) setShadow();
    g.lineWidth = sw; g.lineJoin = 'round'; g.lineCap = 'butt';
    if (x.strokeStyle === 'dashed') g.setLineDash([sw * 3, sw * 2]); else if (x.strokeStyle === 'dotted') { g.setLineDash([0.01, sw * 2]); g.lineCap = 'round'; } else g.setLineDash([]);
    g.strokeStyle = hexA(x.strokeColor, (x.strokeOpacity == null ? 100 : x.strokeOpacity) / 100); if (GL) glyph(1); else if (P2) g.stroke(P2); else g.stroke();
    if (SPARK) { g.setLineDash([]); g.lineCap = 'round'; g.stroke(SPARK); }
  }
  if ((x.shape === 'badge' && String(x.num || '').length) || BADGE_CH[x.shape]) {   // 동그라미 안의 번호·물음표·느낌표
    noShadow(); const s = (BADGE_CH[x.shape] || String(x.num)).slice(0, 3), m = Math.min(w, h), fs = m * (s.length >= 3 ? 0.4 : s.length === 2 ? 0.52 : 0.64);
    g.font = `800 ${fs}px "Cafe24 Ssurround", "Malgun Gothic", sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = x.numColor || '#ffffff'; g.fillText(s, 0, fs * 0.06);
  }
  if (x.shape === 'checkbox') {   // 상자 안의 체크 표시
    noShadow(); g.beginPath(); SHAPE_PTS.check.forEach(([u, v], i) => { const px = (0.1 + u * 0.8 - 0.5) * w, py = (0.1 + v * 0.8 - 0.5) * h; if (i) g.lineTo(px, py); else g.moveTo(px, py); }); g.closePath();
    g.fillStyle = x.checkColor || '#22C55E'; g.fill();
  }
  return cv;
}
function addShape(type) {
  push(); layout();
  const x = { id: nid(), kind: 'shape', shape: type, ...SHAPE_DEF, start: Math.round(S.t * 100) / 100, end: Math.round((S.t + 3) * 100) / 100, text: '', x: 50, y: 50, w: type === 'ellipse' ? 30 : 40, h: type === 'ellipse' ? 30 : 22, rot: 0, ...(SHAPE_START[type] || {}) };
  if (type === 'badge') x.num = String(S.texts.filter((q) => q.kind === 'shape' && q.shape === 'badge').length + 1);
  S.texts.push(x); S.sel = { type: 't', id: x.id }; changed(true);
}
function renderShapeProps(p, x) {
  const upd = () => { renderTL(); renderOv(true); saveLocal(); };
  const refresh = () => { renderProps(); upd(); };
  const tog = (label, key, extra) => { const w = E('label', 'switch'); const c = E('input'); c.type = 'checkbox'; c.checked = !!x[key]; c.onchange = () => { push(); x[key] = c.checked; refresh(); }; w.append(c, E('span', '', label)); return w; };
  p.append(E('div', 'sel-title', SHAPE_NAMES[x.shape] || '도형'));
  if (x.shape === 'badge') {
    p.append(sec('번호'));
    const nw = E('div', 'prop'); const ni = E('input'); ni.type = 'text'; ni.maxLength = 3; ni.value = x.num || ''; ni.style.width = '100%'; ni.onkeydown = (e) => e.stopPropagation(); ni.oninput = () => { pushOnce('num' + x.id); x.num = ni.value; upd(); }; nw.append(ni); p.append(nw);
    const cw = E('div', 'colorline'); cw.append(colorPicker('번호 색', () => x.numColor || '#ffffff', (v, once) => { if (once) pushOnce('nc'); else push(); x.numColor = v; upd(); })); p.append(cw);
  }
  p.append(sec('크기·위치'));
  const ratio = () => x.h / Math.max(0.1, x.w);
  p.append(slider('너비', 1, 300, 0.5, x.w, (v) => v + '%', (v) => { const r = ratio(); x.w = v; if (x.lock) x.h = Math.round(v * r * 10) / 10; upd(); }, 40));
  p.append(slider('높이', 1, 300, 0.5, x.h, (v) => v + '%', (v) => { const r = x.h / Math.max(0.1, x.w); x.h = v; if (x.lock) x.w = Math.round(v / Math.max(0.01, r) * 10) / 10; upd(); }, 22));
  p.append(tog('가로·세로 비율 유지', 'lock'));
  p.append(slider('회전', -180, 180, 1, x.rot || 0, (v) => v + '°', (v) => { x.rot = v; upd(); }, 0));
  p.append(slider('가로 위치', 0, 100, 0.5, x.x, (v) => v + '%', (v) => { x.x = v; upd(); }, 50));
  p.append(slider('세로 위치', 0, 100, 0.5, x.y, (v) => v + '%', (v) => { x.y = v; upd(); }, 50));
  p.append(slider('전체 불투명도', 0, 100, 1, x.opacity == null ? 100 : x.opacity, (v) => v + '%', (v) => { x.opacity = v; upd(); }, 100));
  p.append(sec('움직이기 (포인터를 옮길 때)')); p.append((() => { const w = E('label', 'switch'); const c = E('input'); c.type = 'checkbox'; c.checked = !!x.mv; c.onchange = () => { push(); x.mv = c.checked; if (x.mv && x.x2 == null) { x.x2 = clamp(x.x + 20, 0, 100); x.y2 = clamp(x.y + 15, 0, 100); } renderProps(); upd(); }; w.append(c, E('span', '', '도착 자리로 이동')); return w; })());
  if (x.mv) {
    p.append(slider('도착 가로', 0, 100, 0.5, x.x2, (v) => v + '%', (v) => { x.x2 = v; upd(); }, 50));
    p.append(slider('도착 세로', 0, 100, 0.5, x.y2, (v) => v + '%', (v) => { x.y2 = v; upd(); }, 50));
    p.append(slider('이동 시간', 0.2, 4, 0.1, x.mvDur || 1, (v) => v + '초', (v) => { x.mvDur = v; upd(); }, 1));
  }
  p.append(sec('채우기')); p.append(tog('색 채우기', 'fill'));
  if (x.fill) {
    const w = E('div', 'colorline'); w.append(colorPicker('채우기 색', () => x.fillColor, (v, once) => { if (once) pushOnce('fc'); else push(); x.fillColor = v; upd(); })); p.append(w);
    p.append(slider('채우기 불투명도', 0, 100, 1, x.fillOpacity == null ? 100 : x.fillOpacity, (v) => v + '%', (v) => { x.fillOpacity = v; upd(); }, 100));
  }
  p.append(sec('윤곽선')); p.append(tog('윤곽선 넣기', 'stroke'));
  if (x.stroke) {
    const w = E('div', 'colorline'); w.append(colorPicker('윤곽선 색', () => x.strokeColor, (v, once) => { if (once) pushOnce('sc'); else push(); x.strokeColor = v; upd(); })); p.append(w);
    p.append(chips([['solid', '━━ 실선'], ['dashed', '┅┅ 점선'], ['dotted', '⋯⋯ 점']], x.strokeStyle || 'solid', (v) => { push(); x.strokeStyle = v; refresh(); }));
    p.append(slider('두께', 1, 60, 1, x.strokeW, (v) => v, (v) => { x.strokeW = v; upd(); }, 6));
    p.append(slider('윤곽선 불투명도', 0, 100, 1, x.strokeOpacity == null ? 100 : x.strokeOpacity, (v) => v + '%', (v) => { x.strokeOpacity = v; upd(); }, 100));
  }
  if (x.shape === 'checkbox') { p.append(sec('체크 색')); const cw = E('div', 'colorline'); cw.append(colorPicker('체크 색', () => x.checkColor || '#22C55E', (v, once) => { if (once) pushOnce('cc'); else push(); x.checkColor = v; upd(); })); p.append(cw); }
  if (x.shape === 'rect' || x.shape === 'checkbox') { p.append(sec('모서리')); p.append(slider('둥글게', 0, 50, 1, x.radius || 0, (v) => v + '%', (v) => { x.radius = v; upd(); }, 0)); }
  p.append(sec('그림자')); p.append(tog('그림자 넣기', 'shadow'));
  if (x.shadow) {
    const w = E('div', 'colorline'); w.append(colorPicker('그림자 색', () => x.shadowColor, (v, once) => { if (once) pushOnce('shc'); else push(); x.shadowColor = v; upd(); })); p.append(w);
    p.append(slider('그림자 진하기', 0, 100, 1, x.shadowOpacity == null ? 60 : x.shadowOpacity, (v) => v + '%', (v) => { x.shadowOpacity = v; upd(); }, 60));
    p.append(slider('흐림', 0, 60, 1, x.shadowBlur, (v) => v, (v) => { x.shadowBlur = v; upd(); }, 12));
    p.append(slider('가로 거리', -60, 60, 1, x.shadowX, (v) => v, (v) => { x.shadowX = v; upd(); }, 6));
    p.append(slider('세로 거리', -60, 60, 1, x.shadowY, (v) => v, (v) => { x.shadowY = v; upd(); }, 8));
  }
  p.append(sec('나오는 시간'));
  const r2 = E('div', 'row2');
  r2.append(timeBox('시작', x.start, (t) => { push(); x.start = clamp(t, 0, x.end - 0.1); changed(true); }), timeBox('끝', x.end, (t) => { push(); x.end = Math.max(x.start + 0.1, t); changed(true); }));
  p.append(r2);
}

/* ============ 미리보기에서 직접 조절 (끌어서 이동 · 모서리로 크기) ============ */
(function previewHandles() {
  const hl = E('div'); hl.id = 'hndl';
  const box = E('div', 'hb'), vl = E('div', 'gl'), hlz = E('div', 'gl');
  vl.style.cssText = 'top:0;bottom:0;width:2px;left:50%;margin-left:-1px'; hlz.style.cssText = 'left:0;right:0;height:2px;top:50%;margin-top:-1px';
  hl.append(box, vl, hlz);
  const hs = ['nw', 'ne', 'se', 'sw'].map((c) => { const h = E('div', 'hh ' + c); h.dataset.c = c; hl.append(h); return h; });
  stage.append(hl);
  function target() {
    const sel = S.sel; if (!sel) return null;
    if (sel.type === 'v' && cur && cur.id === sel.id && vGeo) return { kind: 'v', l: vGeo.cx - vGeo.w / 2, t: vGeo.cy - vGeo.h / 2, w: vGeo.w, h: vGeo.h };
    if (sel.type === 't') {
      const el = ov.querySelector(`[data-id="${sel.id}"]`); if (!el) return null; const a = el.getBoundingClientRect(), b = stage.getBoundingClientRect();
      return { kind: 't', l: a.left - b.left, t: a.top - b.top, w: a.width, h: a.height };
    }
    return null;
  }
  let busy = false;
  (function loop() {
    const r = target(), W = stage.clientWidth, H = stage.clientHeight;
    if (!r || !W) { box.style.display = 'none'; hs.forEach((h) => { h.style.display = 'none'; }); }
    else {
      box.style.display = r.kind === 'v' ? 'block' : 'none'; box.style.left = r.l + 'px'; box.style.top = r.t + 'px'; box.style.width = r.w + 'px'; box.style.height = r.h + 'px';
      const px = { nw: [r.l, r.t], ne: [r.l + r.w, r.t], se: [r.l + r.w, r.t + r.h], sw: [r.l, r.t + r.h] };
      hs.forEach((h) => { const p = px[h.dataset.c]; h.style.display = 'block'; h.style.left = clamp(p[0], 10, W - 10) + 'px'; h.style.top = clamp(p[1], 10, H - 10) + 'px'; });
    }
    if (!busy) { vl.style.display = 'none'; hlz.style.display = 'none'; }
    requestAnimationFrame(loop);
  })();
  // 모서리 끌기 = 크기 조절
  let rs = null;
  hl.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.hh'); if (!h) return; const r = target(); if (!r) return;
    const b = stage.getBoundingClientRect(), cx = b.left + r.l + r.w / 2, cy = b.top + r.t + r.h / 2;
    const d0 = Math.max(8, Math.hypot(e.clientX - cx, e.clientY - cy));
    if (r.kind === 'v') rs = { kind: 'v', c: cur, v0: cur.scale, cx, cy, d0 };
    else { const x = S.texts.find((t) => t.id === S.sel.id); if (!x) return; rs = { kind: (x.kind === 'shape' || x.kind === 'fx' || x.kind === 'pip') ? 'p' : x.kind === 'sticker' ? 's' : 't', x, v0: x.kind === 'sticker' ? (x.scale || 30) : x.size, w0: x.w, h0: x.h, cx, cy, d0 }; }
    rs.pushed = false; h.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation();
  });
  hl.addEventListener('pointermove', (e) => {
    if (!rs) return; if (!rs.pushed) { push(); rs.pushed = true; }
    const k = Math.hypot(e.clientX - rs.cx, e.clientY - rs.cy) / rs.d0;
    if (rs.kind === 'v') { rs.c.scale = clamp(Math.round(rs.v0 * k), 10, 400); updateStage(); }
    else if (rs.kind === 'p') { rs.x.w = clamp(Math.round(rs.w0 * k * 10) / 10, 1, 300); rs.x.h = clamp(Math.round(rs.h0 * k * 10) / 10, 1, 300); renderOv(true); }
    else if (rs.kind === 's') { rs.x.scale = clamp(Math.round(rs.v0 * k), 2, 150); renderOv(true); }
    else { rs.x.size = clamp(Math.round(rs.v0 * k), 10, 400); renderOv(true); }
  });
  const rsEnd = () => { if (!rs) return; const d = rs; rs = null; if (d.pushed) changed(true); };
  hl.addEventListener('pointerup', rsEnd); hl.addEventListener('pointercancel', rsEnd);
  // 영상 화면 끌기 = 위치 이동 (가운데에 가까우면 자석처럼 붙음)
  let mv = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !cur || !vGeo || e.target.closest('.ovt,.hh')) return;
    if (!(S.sel && S.sel.type === 'v' && S.sel.id === cur.id)) select('v', cur.id);
    mv = { c: cur, x0: e.clientX, y0: e.clientY, px: cur.x, py: cur.y, pushed: false }; stage.setPointerCapture(e.pointerId); e.preventDefault();
  });
  stage.addEventListener('pointermove', (e) => {
    if (!mv) return; const dx = e.clientX - mv.x0, dy = e.clientY - mv.y0;
    if (!mv.pushed) { if (Math.hypot(dx, dy) < 3) return; push(); mv.pushed = true; }
    let nx = mv.px + dx / stage.clientWidth * 100, ny = mv.py + dy / stage.clientHeight * 100;
    const g0 = vGeo, W = stage.clientWidth, H = stage.clientHeight; let gx = null, gy = null;
    if (g0 && !e.altKey) {
      const cx0 = W / 2 + nx / 100 * W, cy0 = g0.cy + (ny - mv.c.y) / 100 * g0.sh;
      gx = snap1(cx0, g0.w, W, 6); gy = snap1(cy0, g0.h, H, 6);
      if (gx) nx += gx.d / W * 100; if (gy) ny += gy.d / g0.sh * 100;
    }
    mv.c.x = Math.round(clamp(nx, -200, 200) * 10) / 10; mv.c.y = Math.round(clamp(ny, -200, 200) * 10) / 10;
    updateStage(); showGuides(gx && [gx.line], gy && [gy.line]);
  });
  const mvEnd = () => { showGuides(); if (!mv) return; const d = mv; mv = null; busy = false; if (d.pushed) changed(true); };
  stage.addEventListener('pointerup', mvEnd); stage.addEventListener('pointercancel', mvEnd);
})();
/* ============ 🎬 모션그래픽 (motion.js 가 그리고, 여기서 타임라인에 올려요) ============ */
MG.fontList = () => S.fonts;
// 모션그래픽을 그릴 크기: 영상 모양(짧은 변 1080) 기준. 쇼츠 색 띠가 있으면 겹친 영상은 가운데 칸 크기로 만들어요(띠·제목을 가리지 않게)
function mgBox(asClip) {
  const r = canvasRatio(), ev = (v) => Math.max(64, Math.round(v / 2) * 2);
  const W0 = ev(r >= 1 ? 1080 * r : 1080), H0 = ev(r >= 1 ? 1080 : 1080 / r), tp = tplOn();
  const sub = S.texts.find((q) => q.kind === 'sub'), subY = sub ? clamp(+sub.y || 70, 30, 98) / 100 : (r >= 1 ? 0.88 : 0.7);
  if (!tp || (!+tp.top && !+tp.bottom)) return { W: W0, H: H0, pad: { T: 0.08, B: Math.min(0.78, subY - 0.06) }, pip: { x: 50, y: 50, w: 100, h: Math.round(H0 / W0 * 1000) / 10 } };
  const top = clamp(+tp.top || 0, 0, 45) / 100, bot = clamp(+tp.bottom || 0, 0, 45) / 100;
  if (asClip) return { W: W0, H: H0, pad: { T: top + 0.05, B: Math.min(1 - bot - 0.04, subY - 0.05) }, pip: null };
  const H = ev(H0 * (1 - top - bot)), subIn = (subY - top) / Math.max(0.05, 1 - top - bot);
  return { W: W0, H, pad: { T: 0.08, B: clamp(Math.min(0.8, subIn - 0.08), 0.45, 0.85) }, pip: { x: 50, y: Math.round((top + (1 - top - bot) / 2) * 1000) / 10, w: 100, h: Math.round(H / W0 * 1000) / 10 } };
}
let mgBusy = 0;
function mgProgress() {   // 오른쪽 아래 작은 진행 표시
  let el = $('#mg-prog'); if (!el) { el = E('div', 'up'); el.id = 'mg-prog'; el.innerHTML = '<div></div><div class="bar"><i></i></div>'; $('#uploads').append(el); }
  return { set: (txt, p) => { el.firstChild.textContent = txt; $('i', el).style.width = Math.round(p * 100) + '%'; }, done: () => el.remove() };
}
async function mgMake(spec, len, opts) {   // 설계도 → 영상 파일(미디어). 실패하면 null
  opts = opts || {}; const box = mgBox(opts.asClip), g = MG.normalize(spec); let html = null;
  if (g.html) { const jb = opts.job || S.mgJob; if (!jb) { toast('모션그래픽 HTML은 AI 작업 폴더에서 연 결과에서만 만들 수 있어요', null, 6000); return null; }
    const r = await fetch('/api/mg/html?job=' + encodeURIComponent(jb) + '&f=' + encodeURIComponent(g.html)).then((x) => x.json()).catch(() => ({ error: '서버에 연결할 수 없어요' }));
    if (r.error) { toast(r.error, null, 7000); return null; } html = r.html; }
  mgBusy++; const pg = mgProgress(), nm = opts.title || MG.label(g);
  try { const m = await MG.render(g, { W: box.W, H: box.H, pad: box.pad, dur: len, fps: 30, job: opts.job || S.mgJob, html, onProgress: (p) => pg.set('🎬 ' + nm + ' 만드는 중', p) });
    if (m) S.media[m.id] = m; return m ? { m, box } : null;
  } catch (e) { toast('모션그래픽을 만들지 못했어요: ' + e.message, null, 8000); return null; }
  finally { mgBusy--; pg.done(); }
}
// .dsp 를 열기 전에: 설계도(mg)만 있고 영상이 아직 없는 항목을 영상으로 만들어 이어요
function mgLift(d) {   // AI가 mg 묶음 없이 항목에 바로 적었을 때도 알아들어요 ({"kind":"mg","type":"steps",...})
  const KEYS = ['type', 'tpl', 'style', 'title', 'items', 'at', 'text', 'value', 'label', 'from', 'left', 'right', 'win', 'clear', 'html'];
  const lift = (x) => { if (!x || typeof x !== 'object' || (x.mg && typeof x.mg === 'object')) return; if (typeof x.mg === 'string') { x.mg = /\.html?$/i.test(x.mg) ? { html: x.mg } : { type: x.mg }; return; } const o = {}; KEYS.forEach((k) => { if (x[k] !== undefined && !(k === 'text' && x.kind !== 'mg' && !x.type)) o[k] = x[k]; }); x.mg = o; };
  (d.texts || []).forEach((t) => { if (t && (t.kind === 'mg' || t.kind === 'motion')) { t.kind = 'mg'; lift(t); } });
  (d.clips || []).forEach((c) => { if (c && (c.kind === 'mg' || c.type === 'mg' || typeof c.mg === 'string')) { if (c.type === 'mg') delete c.type; lift(c); } });
}
function mgNeeds(d) {
  mgLift(d);
  const has = (x) => x && x.mg && typeof x.mg === 'object';
  return (d.clips || []).some((c) => has(c) && !S.media[c.mediaId]) || (d.texts || []).some((t) => has(t) && (t.kind === 'mg' || !S.media[t.mediaId]));
}
async function mgPrepare(d) {
  const clips = (d.clips || []).filter((c) => c && c.mg && typeof c.mg === 'object' && !S.media[c.mediaId]);
  const texts = (d.texts || []).filter((t) => t && t.mg && typeof t.mg === 'object' && (t.kind === 'mg' || !S.media[t.mediaId]));
  const all = clips.length + texts.length; if (!all) return; let k = 0, fail = 0;
  if (d.canvas && !S.clips.length) S.canvas = d.canvas;   // 크기 계산이 새 영상 모양을 따르게
  if (d.tpl !== undefined) S.tpl = d.tpl && typeof d.tpl === 'object' ? d.tpl : S.tpl;
  for (const c of clips) {
    k++; const len = clamp(+c.dur || (+c.out - +c.in) || 4, 0.5, 120), r = await mgMake(c.mg, len, { asClip: true, job: d.__job, title: `모션그래픽 ${k}/${all}` });
    if (!r) { fail++; c.__drop = true; continue; } c.mediaId = r.m.id; c.in = 0; c.out = Math.round(r.m.duration * 100) / 100; c.fit = 'contain'; c.scale = c.scale || 100; c.mute = true; c.vol = 0;
  }
  for (const t of texts) {
    k++; const st = Math.max(0, +t.start || 0), en = +t.end > st ? +t.end : st + 4, r = await mgMake(t.mg, en - st, { job: d.__job, title: `모션그래픽 ${k}/${all}` });
    if (!r) { fail++; t.__drop = true; continue; }
    Object.assign(t, { kind: 'pip', mediaId: r.m.id, in: 0, start: st, end: Math.round((st + r.m.duration) * 100) / 100, text: '', vol: 0, opacity: t.opacity == null ? 100 : t.opacity }, t.x == null || t.w == null ? r.box.pip : {});
  }
  d.clips = (d.clips || []).filter((c) => !c.__drop); d.texts = (d.texts || []).filter((t) => !t.__drop);
  if (fail) toast(`모션그래픽 ${fail}개를 만들지 못해 빼고 열었어요`, null, 8000);
}
// 길이를 바꾸면 그 길이에 맞춰 다시 만들어요 (애니메이션이 중간에 잘리지 않게)
async function mgRefit(x) {
  const m = S.media[x.mediaId], len = Math.round((x.end - x.start) * 100) / 100; if (!x.mg || len < 0.3) return;
  if (m && Math.abs(m.duration - len) < 0.06 && !(+x.in > 0.01)) return;
  const r = await mgMake(x.mg, len); if (!r) return; push(); x.mediaId = r.m.id; x.in = 0; x.end = Math.round((x.start + r.m.duration) * 100) / 100; changed(true); toast('길이에 맞춰 모션그래픽을 다시 만들었어요');
}
// 직접 만들기·고치기 창
function mgDialog(spec0, onDone) {
  const g = MG.normalize(spec0 || { type: 'steps' }); let type = g.type, style = g.style, clear = g.clear;
  const d = E('div', 'dlg mg-dlg', '<h2>🎬 모션그래픽</h2>'); const body = E('div'); d.append(body);
  const val = { title: g.title, items: g.items.join('\n'), text: g.text, value: g.value, label: g.label, lv: [g.left.label, g.left.value, g.left.text], rv: [g.right.label, g.right.value, g.right.text], dur: spec0 && spec0.__len ? spec0.__len : 5 };
  const cv = E('canvas', 'mg-pv'); const box = mgBox(); const pw = 360; cv.width = pw; cv.height = Math.round(pw * box.H / box.W); if (cv.height > 400) { cv.height = 400; cv.width = Math.round(400 * box.W / box.H); }
  let raf = 0, t0 = performance.now();
  const spec = () => { const s = { type, style, clear, title: val.title.trim() };
    if (type === 'steps' || type === 'flow' || type === 'list') s.items = val.items.split('\n').map((q) => q.trim()).filter(Boolean);
    if (type === 'quote') { s.text = val.text.trim(); s.label = val.label.trim(); }
    if (type === 'number') { s.value = val.value.trim(); s.label = val.label.trim(); }
    if (type === 'compare') { s.left = { label: val.lv[0], value: val.lv[1], text: val.lv[2] }; s.right = { label: val.rv[0], value: val.rv[1], text: val.rv[2] }; }
    return s; };
  const loop = () => { const len = clamp(+val.dur || 5, 1, 60), t = ((performance.now() - t0) / 1000) % (len + 0.6); const sc = cv.width / box.W, c = cv.getContext('2d'); c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cv.width, cv.height); cv.style.background = clear ? 'repeating-conic-gradient(#666 0 25%, #888 0 50%) 0 0/20px 20px' : 'none'; c.scale(sc, sc);
    MG.frame(c, box.W, box.H, MG.normalize(spec()), Math.min(t, len), len, box.pad); c.restore(); raf = modal.classList.contains('on') && document.body.contains(cv) ? requestAnimationFrame(loop) : 0; };
  const field = (lab, v, set, area, tip) => { const w = E('div', 'f'); if (tip) w.title = tip; w.append(E('label', '', lab)); const i = E(area ? 'textarea' : 'input'); if (!area) i.type = 'text'; else i.rows = 4; i.value = v; i.onkeydown = (e) => e.stopPropagation(); i.oninput = () => set(i.value); w.append(i); return w; };
  const draw = () => {
    body.innerHTML = '';
    const top = E('div', 'mg-top'); const left = E('div', 'mg-l'), right = E('div', 'mg-r'); top.append(left, right); body.append(top);
    left.append(cv);
    const tc = chips(Object.entries(MG.TYPES).map(([k, v]) => [k, v.ico + ' ' + v.n]), type, (k) => { type = k; draw(); }); tc.classList.add('wrapchips'); [...tc.children].forEach((b, i) => { b.title = Object.values(MG.TYPES)[i].tip; });
    right.append(E('div', 'dim', '모양'), tc);
    const sc = chips(Object.entries(MG.STYLES).map(([k, v]) => [k, v.n]), style, (k) => { style = k; draw(); }); sc.classList.add('wrapchips'); [...sc.children].forEach((b, i) => { b.title = Object.values(MG.STYLES)[i].tip; });
    right.append(E('div', 'dim', '스타일'), sc);
    const bc = chips([[0, '배경 있음'], [1, '투명 (영상 위에)']], clear ? 1 : 0, (v) => { clear = !!v; draw(); }); bc.children[1].title = '바탕 없이 영상 위에 겹쳐 보여요'; right.append(bc);
    const fz = E('div', 'mg-fields'); body.append(fz);
    fz.append(field('제목', val.title, (v) => { val.title = v; }, false, type === 'quote' ? '없어도 돼요' : '강조할 말은 [ ] 로 감싸요'));
    if (type === 'steps' || type === 'flow' || type === 'list') fz.append(field('내용', val.items, (v) => { val.items = v; }, true, '한 줄에 하나씩 적어요. 강조할 말은 [ ] 로 감싸요'));
    if (type === 'quote') fz.append(field('문장', val.text, (v) => { val.text = v; }, true, '강조할 말은 [ ] 로 감싸요. 예) 물은 [하루 2리터]'), field('위쪽 작은 글', val.label, (v) => { val.label = v; }, false, '예) 핵심 · 없어도 돼요'));
    if (type === 'number') fz.append(field('숫자', val.value, (v) => { val.value = v; }, false, '예) 73%, 1,200원 · 숫자는 0부터 올라가며 세어져요'), field('설명', val.label, (v) => { val.label = v; }));
    if (type === 'compare') { const r2 = E('div', 'row2'); const a = E('div'), b = E('div');
      ['이름', '숫자', '설명'].forEach((lab, i) => { a.append(field('왼쪽 ' + lab, val.lv[i] || '', (v) => { val.lv[i] = v; }, i === 2, i ? '없어도 돼요' : '')); b.append(field('오른쪽 ' + lab, val.rv[i] || '', (v) => { val.rv[i] = v; }, i === 2, i ? '없어도 돼요' : '')); }); r2.append(a, b); fz.append(r2); }
    fz.append(field('길이(초)', String(val.dur), (v) => { val.dur = v; }));
    const acts = E('div', 'acts'); const no = E('button', '', '닫기'), ok = E('button', 'primary', spec0 && spec0.__edit ? '🔄 다시 만들기' : '＋ 넣기'); no.onclick = closeModal;
    ok.onclick = async () => { ok.disabled = true; const s = spec(), len = clamp(+val.dur || 5, 0.5, 120); closeModal(); onDone(s, len); };
    acts.append(no, ok); body.append(acts);
  };
  draw(); openModal(d); if (!raf) raf = requestAnimationFrame(loop);
}
async function mgAdd(spec, len) {   // 지금 재생 위치에 겹친 영상으로 올려요
  const at = S.t, r = await mgMake(spec, len); if (!r) return;
  push(); const x = Object.assign({ id: nid(), kind: 'pip', mediaId: r.m.id, in: 0, start: Math.round(at * 100) / 100, end: Math.round((at + r.m.duration) * 100) / 100, text: '', vol: 0, opacity: 100, mg: spec }, r.box.pip);
  S.texts.push(x); S.sel = { type: 't', id: x.id }; changed(true); seek(x.start + 0.01, true); toast('모션그래픽을 넣었어요');
}
function mgPropsSec(p, x, isClip) {   // 선택한 모션그래픽 고치기
  if (!x.mg) return; p.append(sec('모션그래픽'));
  const br = E('div', 'btnrow'); const eb = E('button', 'primary', '✏ 글자·모양 고치기');
  eb.onclick = () => mgDialog(Object.assign({}, x.mg, { __edit: true, __len: Math.round((isClip ? x.out - x.in : x.end - x.start) * 10) / 10 }), async (s, len) => {
    const r = await mgMake(s, len, { asClip: isClip }); if (!r) return; push(); x.mg = s; x.mediaId = r.m.id;
    if (isClip) { x.in = 0; x.out = Math.round(r.m.duration * 100) / 100; } else { x.in = 0; x.end = Math.round((x.start + r.m.duration) * 100) / 100; }
    changed(true); toast('모션그래픽을 다시 만들었어요'); });
  br.append(eb); p.append(br);
}
function swapMedia(x) {   // 겹친 영상을 다른 영상·사진으로 바꾸기 (자리·시간은 그대로)
  const list = Object.values(S.media).filter((m) => m.hasVideo && !m.hide && m.id !== x.mediaId);
  if (!list.length) return toast('바꿀 영상이나 사진이 없어요. 미디어 탭에서 먼저 가져와 주세요');
  const d = E('div', 'dlg', '<h2>🔁 다른 것으로 바꾸기</h2>'); const g = E('div', 'mg-swap'); d.append(g);
  list.forEach((m) => { const b = E('button', 'mg-sw', `<span style="${m.thumb ? `background-image:url(/api/thumb/${m.id})` : ''}"></span><small>${esc(m.name)}</small>`); b.title = m.name;
    b.onclick = () => { push(); const len = x.end - x.start; x.mediaId = m.id; x.in = 0; if (!m.isImage && !m.mg) x.end = Math.round((x.start + Math.min(len, m.duration)) * 100) / 100; if (m.mg) x.end = Math.round((x.start + m.duration) * 100) / 100;
      const asp = m.width && m.height ? m.height / m.width : x.h / Math.max(0.1, x.w); x.h = Math.round(x.w * asp * 10) / 10; delete x.mg; closeModal(); changed(true); toast('바꿨어요'); };
    g.append(b); });
  const acts = E('div', 'acts'); const no = E('button', '', '닫기'); no.onclick = closeModal; acts.append(no); d.append(acts); openModal(d);
}
addVer(document.querySelector('.brand'));
})();
