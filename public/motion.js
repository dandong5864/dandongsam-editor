/* ============ 🎬 모션그래픽: 편집기 화면에서 그림을 그려 영상 파일로 만들어요 (무료, 따로 설치할 것 없음) ============
   - 기본 모양 6가지(순서·숫자·비교·작동 원리·핵심 문장·체크리스트) × 스타일 6가지는 이 파일이 직접 그려요.
   - AI가 작업 폴더에 만든 HTML(window.draw(t), window.DUR)도 그릴 수 있어요. 그 HTML은 인터넷·편집기에 손대지 못하게 잠긴 틀 안에서만 돌아요.
   - 그린 그림은 서버(ffmpeg)가 mp4(투명이면 webm 도 함께)로 만들어 '추가 미디어' 줄에 올려요. */
(function () {
  'use strict';
  const TF = 'Black Han Sans', BF = 'Do Hyeon';
  // 스타일 (그코키트 기본 스타일 목록에서 강의·쇼츠에 잘 맞는 6개를 골라 편집기에 넣었어요)
  const STYLES = {
    howto: { n: '단계별 따라하기', tip: '따뜻한 밝은 바탕 · 번호 카드 · 진행 막대 (요리·청소·사용법)', bg: '#F6F1EA', fg: '#3E2C23', sub: '#8A7466', acc: '#C97B4A', acc2: '#7FB069', panel: '#FFFFFF', line: '#E6DCCF', card: 'fill', head: 'none', r: 26, tempo: 1, dark: false },
    lineicon: { n: '라인 아이콘', tip: '검정 바탕 · 흰 선 · 지금 말하는 것만 연두 (AI·개념·업무 흐름)', bg: '#0B0B0B', fg: '#F5F5F2', sub: '#8A8A86', acc: '#B6F23C', acc2: '#F5F5F2', panel: '#141414', line: '#3A3A38', card: 'line', head: 'none', r: 18, tempo: 1.25, dark: true },
    newsshorts: { n: '뉴스 카드', tip: '검정 바탕 · 노랑 제목 띠 · 큰 숫자 (이슈·바뀐 제도·가격)', bg: '#0E0F12', fg: '#FFFFFF', sub: '#A0A4AD', acc: '#FFD400', acc2: '#3A7BFF', warn: '#FF3B30', panel: '#1B1D23', line: '#2C2F38', card: 'fill', head: 'bar', r: 6, tempo: 0.85, dark: true },
    pptpen: { n: '인강 PPT 첨삭', tip: '흰 슬라이드 · 남색 머리띠 · 빨간 펜 동그라미 (강의·업무 교육)', bg: '#FFFFFF', fg: '#2B2F36', sub: '#6B7280', acc: '#E03131', acc2: '#1971C2', hl: '#FFD43B', head0: '#1F3A68', panel: '#F3F5F9', line: '#DDE2EA', card: 'flat', head: 'band', r: 10, tempo: 1, dark: false },
    cardnews: { n: '카드뉴스', tip: '연보라 바탕 · 둥근 파스텔 카드 (생활 꿀팁·체크리스트)', bg: '#F4EFFF', fg: '#1F1B2E', sub: '#6F6787', acc: '#7B61FF', acc2: '#FF8F7A', panel: '#FFFFFF', line: '#E2DAF7', pastel: ['#FFE3DC', '#DDF3EC', '#E9E3FF', '#FFF2C7'], card: 'fill', head: 'none', r: 40, tempo: 1, dark: false },
    broadcast: { n: '방송 뉴스 그래픽', tip: '남색 데이터 판 · 차분한 그래프 (정책·통계·사건 경과)', bg: '#0B1F3A', fg: '#FFFFFF', sub: '#9FB3CF', acc: '#00A3FF', acc2: '#FFC72C', warn: '#E63946', panel: '#16335C', line: '#24497A', card: 'panel', head: 'lower', r: 4, tempo: 1.1, dark: true },
  };
  const TYPES = {
    steps: { n: '순서', ico: '①', tip: '1 → 2 → 3 차례대로 할 일' },
    number: { n: '숫자', ico: '🔢', tip: '가격·% 같은 숫자 하나를 크게' },
    compare: { n: '비교', ico: '⚖', tip: '두 가지를 나란히 (전·후, 장단점)' },
    flow: { n: '작동 원리', ico: '🔁', tip: '어떻게 돌아가는지 흐름' },
    quote: { n: '핵심 문장', ico: '💬', tip: '꼭 기억할 한 문장 (강조할 말은 [ ] 로 감싸기)' },
    list: { n: '체크리스트', ico: '☑', tip: '챙길 것들을 하나씩 체크' },
  };
  // 대본 성격에 맞춰 스타일을 고를 때(스타일 'auto') 쓰는 기본 짝
  const AUTO_STYLE = { steps: 'howto', number: 'newsshorts', compare: 'broadcast', flow: 'lineicon', quote: 'lineicon', list: 'cardnews' };

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const eo = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
  const back = (t) => { t = clamp(t, 0, 1); const c = 1.5; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
  const ph = (t, a, d) => clamp((t - a) / Math.max(0.001, d), 0, 1);
  const str = (v) => (v === undefined || v === null ? '' : String(v)).replace(/\s+/g, ' ').trim();
  const hexA = (h, a) => { h = String(h || '#000').replace('#', ''); if (h.length === 3) h = h.split('').map((c) => c + c).join(''); const n = parseInt(h, 16) || 0; return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp(a, 0, 1)})`; };

  // ---- 설계도 정리: AI가 쓴 값이 조금 달라도 알아서 맞춰요 ----
  function normalize(mg) {
    const g = Object.assign({}, mg || {});
    const ty = String(g.type || g.tpl || '').toLowerCase();
    const alias = { step: 'steps', order: 'steps', '순서': 'steps', num: 'number', count: 'number', '숫자': 'number', vs: 'compare', '비교': 'compare', process: 'flow', how: 'flow', '원리': 'flow', '작동원리': 'flow', text: 'quote', key: 'quote', '핵심문장': 'quote', '핵심': 'quote', check: 'list', checklist: 'list', '체크리스트': 'list' };
    g.type = TYPES[ty] ? ty : alias[ty] || (g.left || g.right ? 'compare' : g.value !== undefined ? 'number' : Array.isArray(g.items) && g.items.length ? 'steps' : 'quote');
    let st = String(g.style || '').toLowerCase(); if (!STYLES[st]) st = AUTO_STYLE[g.type]; g.style = st;
    g.title = str(g.title);
    g.items = (Array.isArray(g.items) ? g.items : []).map((it) => (it && typeof it === 'object' ? str(it.text || it.label || it.name) : str(it))).filter(Boolean).slice(0, 6);
    g.at = Array.isArray(g.at) ? g.at.map(Number).filter(Number.isFinite) : null;
    g.text = str(g.text || (g.type === 'quote' ? g.title : '')); if (g.type === 'quote' && g.text === g.title) g.title = '';
    g.value = str(g.value); g.label = str(g.label); g.from = g.from === undefined ? null : str(g.from);
    const side = (v) => (v && typeof v === 'object' ? { label: str(v.label || v.title || v.name), text: str(v.text || v.desc), value: str(v.value) } : { label: str(v), text: '', value: '' });
    g.left = side(g.left); g.right = side(g.right); g.win = g.win === 'left' || g.win === 'right' ? g.win : null;
    g.clear = !!g.clear;
    if (g.html) g.html = String(g.html);
    return g;
  }
  // 설계도와 크기로 이름표를 만들어요 (같은 이름표면 다시 그리지 않고 만든 영상을 그대로 써요)
  function key(mg, W, H, dur, fps) {
    const s = JSON.stringify([mg, W, H, Math.round(dur * 100) / 100, fps, 1]);
    let a = 0x811c9dc5, b = 0x12345; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 16777619) >>> 0; b = Math.imul(b ^ c, 2246822519) >>> 0; }
    return 'm' + a.toString(36) + b.toString(36);
  }
  function label(mg) {
    const g = normalize(mg); const t = g.html ? 'HTML' : TYPES[g.type].n;
    const w = g.title || g.text || g.value || g.items[0] || ''; return '모션 ' + t + (w ? ' ' + w.replace(/[[\]]/g, '').slice(0, 14) : '');
  }

  // ---- 글자 ----
  const F = (px, fam) => `${Math.round(px)}px "${fam}", "Malgun Gothic", sans-serif`;
  function wrap(c, text, maxW, maxLines) {   // 어절(띄어쓰기) 단위로 줄을 나눠요. 한 어절이 너무 길면 글자 단위로 나눠요
    const words = String(text).split(' ').filter(Boolean), lines = []; let cur = '';
    const push = (w) => { if (c.measureText(w).width <= maxW) return w; let part = ''; for (const ch of w) { if (c.measureText(part + ch).width > maxW && part) { lines.push(part); part = ch; } else part += ch; } return part; };
    for (const w of words) { const t = cur ? cur + ' ' + w : w; if (c.measureText(t.replace(/[[\]]/g, '')).width <= maxW) cur = t; else { if (cur) lines.push(cur); cur = push(w); } }
    if (cur) lines.push(cur);
    return lines.length > maxLines ? null : lines;
  }
  function fit(c, text, maxW, maxLines, size, min, fam) {   // 들어갈 때까지 글자를 줄여요 (너무 작아지면 줄 수를 늘려요)
    for (let s = size; s >= min; s *= 0.93) { c.font = F(s, fam); const l = wrap(c, text, maxW, maxLines); if (l) return { size: s, lines: l }; }
    c.font = F(min, fam); return { size: min, lines: wrap(c, text, maxW, 99) || [text] };
  }
  function rich(c, line, x, y, base, accent, align) {   // [강조] 로 감싼 말만 강조색으로
    const segs = []; let on = false, buf = ''; for (const ch of line) { if (ch === '[' || ch === ']') { if (buf) segs.push([buf, on]); buf = ''; on = ch === '['; } else buf += ch; } if (buf) segs.push([buf, on]);
    const tw = segs.reduce((a, [s]) => a + c.measureText(s).width, 0); let px = align === 'left' ? x : align === 'right' ? x - tw : x - tw / 2;
    const ta = c.textAlign; c.textAlign = 'left'; segs.forEach(([s, hi]) => { c.fillStyle = hi ? accent : base; c.fillText(s, px, y); px += c.measureText(s).width; }); c.textAlign = ta; return tw;
  }
  const plain = (s) => String(s).replace(/[[\]]/g, '');
  function rr(c, x, y, w, h, r) { r = Math.max(0, Math.min(r, w / 2, h / 2)); c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function penCircle(c, cx, cy, rx, ry, p, col, lw) {   // 빨간 펜으로 손으로 그린 듯한 동그라미
    if (p <= 0) return; c.save(); c.strokeStyle = col; c.lineWidth = lw; c.lineCap = 'round'; c.beginPath();
    const N = 48, end = Math.floor(N * 1.08 * p); for (let i = 0; i <= end; i++) { const a = -2.2 + i / N * Math.PI * 2, j = 1 + 0.04 * Math.sin(i * 1.7); const x = cx + Math.cos(a) * rx * j, y = cy + Math.sin(a) * ry * j * (1 + i / N * 0.06); i ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.stroke(); c.restore();
  }
  function checkMark(c, x, y, s, p, col, lw) { if (p <= 0) return; const pts = [[x - s * 0.5, y], [x - s * 0.12, y + s * 0.38], [x + s * 0.55, y - s * 0.42]]; const L1 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]), L2 = Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]), d = (L1 + L2) * p;
    c.save(); c.strokeStyle = col; c.lineWidth = lw; c.lineCap = 'round'; c.lineJoin = 'round'; c.beginPath(); c.moveTo(...pts[0]); if (d <= L1) c.lineTo(pts[0][0] + (pts[1][0] - pts[0][0]) * d / L1, pts[0][1] + (pts[1][1] - pts[0][1]) * d / L1); else { c.lineTo(...pts[1]); const q = (d - L1) / L2; c.lineTo(pts[1][0] + (pts[2][0] - pts[1][0]) * q, pts[1][1] + (pts[2][1] - pts[1][1]) * q); } c.stroke(); c.restore(); }

  // ---- 한 장면 그리기 ----
  // 화면 짜임: 가장자리 여백 6~8%, 아래 22%는 자막 자리라 비워 둬요. 세로(쇼츠)는 오른쪽 12%(버튼 자리)도 피해요.
  function frame(c, W, H, mg, t, dur, pad) {
    const g = mg, S = STYLES[g.style], u = Math.min(W, H) / 1080, port = H / W > 1.4, tempo = S.tempo;
    const L = W * (port ? 0.08 : 0.07), R = W * (port ? 0.88 : 0.93), T = H * clamp(pad && pad.T != null ? pad.T : 0.08, 0, 0.6), B = H * clamp(pad && pad.B != null ? pad.B : 0.78, 0.35, 1), CW = R - L, CX = (L + R) / 2;
    const outA = 1 - ph(t, dur - 0.35, 0.35);
    c.save(); c.clearRect(0, 0, W, H);
    if (!g.clear) { c.fillStyle = S.bg; c.fillRect(0, 0, W, H); bgDeco(c, W, H, S, u, t); }
    c.globalAlpha = g.clear ? eo(ph(t, 0, 0.3)) * outA : 1;
    if (g.clear) { c.fillStyle = hexA(S.bg, 0.9); rr(c, L - 24 * u, T - 24 * u, CW + 48 * u, B - T + 48 * u, S.r * u + 12 * u); c.fill(); }
    // 머리 제목
    let top = T;
    if (g.title) top = head(c, g.title, S, { L, R, T, W, u, t, tempo, port });
    const box = { L, R, T: top, B, CW, CX, u, port, W, H, k: port ? 1.32 : 1.12 };
    const n = Math.max(1, g.items.length);
    // 항목이 나오는 시각: AI가 at(초) 를 주면 그 시각에, 없으면 앞쪽에 고르게 펼쳐요
    const t0 = g.title ? 0.45 * tempo : 0.2, span = clamp(Math.min(dur * 0.6, n * 1.3 * tempo), 0.5, Math.max(0.6, dur - t0 - 1.2));
    const at = (i) => (g.at && Number.isFinite(g.at[i]) ? clamp(g.at[i], 0, dur - 0.3) : t0 + (n > 1 ? span * i / (n - 1) : 0.1));
    ({ steps, number, compare, flow, quote, list })[g.type](c, g, S, box, t, dur, at, tempo);
    c.restore();
    if (!g.clear) { const fi = 1 - eo(ph(t, 0, 0.45)), fo = ph(t, dur - 0.4, 0.4); const a = Math.max(fi, fo); if (a > 0) { c.save(); c.globalAlpha = a; c.fillStyle = S.bg; c.fillRect(0, 0, W, H); c.restore(); } }
    else if (outA < 1) { /* 투명 모드는 위에서 같이 흐려졌어요 */ }
  }
  function bgDeco(c, W, H, S, u, t) {
    c.save();
    if (S.card === 'line') { c.strokeStyle = hexA(S.fg, 0.05); c.lineWidth = 1; const g = 60 * u; for (let x = (t * 6 * u) % g; x < W; x += g) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); } for (let y = 0; y < H; y += g) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); } }
    else if (S.head === 'lower') { const gr = c.createRadialGradient(W * 0.7, H * 0.2, 10, W * 0.7, H * 0.2, Math.max(W, H) * 0.8); gr.addColorStop(0, hexA(S.acc, 0.16)); gr.addColorStop(1, hexA(S.acc, 0)); c.fillStyle = gr; c.fillRect(0, 0, W, H); }
    else if (S === STYLES.howto) { c.fillStyle = hexA(S.fg, 0.05); const g = 44 * u; for (let y = g / 2; y < H; y += g) for (let x = g / 2; x < W; x += g) { c.beginPath(); c.arc(x, y, 2.2 * u, 0, 7); c.fill(); } }
    else if (S === STYLES.cardnews) { c.fillStyle = hexA(S.acc, 0.08); c.beginPath(); c.arc(W * 0.92, H * 0.1, 260 * u, 0, 7); c.fill(); c.fillStyle = hexA(S.acc2, 0.08); c.beginPath(); c.arc(W * 0.05, H * 0.82, 200 * u, 0, 7); c.fill(); }
    else if (S === STYLES.newsshorts) { c.fillStyle = hexA('#ffffff', 0.025); for (let y = 0; y < H; y += 6 * u) c.fillRect(0, y, W, 2 * u); }
    c.restore();
  }
  function head(c, title, S, o) {
    const { L, R, T, W, u, t, tempo, port } = o, p = eo(ph(t, 0.05, 0.5 * tempo)), CW = R - L;
    c.save(); c.textBaseline = 'middle';
    if (S.head === 'bar') {   // 노랑 제목 띠가 왼쪽에서 들어와요
      const f = fit(c, plain(title), CW - 60 * u, 2, (port ? 96 : 86) * u, 48 * u, TF), lh = f.size * 1.18, h = f.lines.length * lh + 40 * u;
      c.fillStyle = S.acc; c.fillRect(L - 12 * u - (1 - p) * W, T, CW + 24 * u, h); c.fillStyle = '#111111'; c.textAlign = 'left'; c.font = F(f.size, TF);
      c.globalAlpha *= ph(t, 0.25, 0.25); f.lines.forEach((l, i) => c.fillText(l, L + 18 * u, T + 20 * u + lh * (i + 0.5))); c.restore(); return T + h + 46 * u;
    }
    if (S.head === 'band') {   // 남색 머리띠 (슬라이드 제목)
      const f = fit(c, plain(title), CW, 2, (port ? 92 : 80) * u, 46 * u, TF), lh = f.size * 1.18, h = f.lines.length * lh + 56 * u;
      c.fillStyle = S.head0; c.globalAlpha *= p; c.fillRect(0, 0, W, T + h - 20 * u); c.fillStyle = '#FFFFFF'; c.textAlign = 'left'; c.font = F(f.size, TF);
      f.lines.forEach((l, i) => c.fillText(l, L + (1 - p) * 40 * u, T - 6 * u + lh * (i + 0.5) + 8 * u)); c.fillStyle = S.hl; c.fillRect(L, T + h - 20 * u, 120 * u * p, 8 * u); c.restore(); return T + h + 40 * u;
    }
    if (S.head === 'lower') {   // 방송 그래픽: 작은 네모 표시 + 제목 + 가는 선
      const f = fit(c, plain(title), CW - 40 * u, 2, (port ? 90 : 78) * u, 46 * u, TF), lh = f.size * 1.18;
      c.globalAlpha *= p; c.fillStyle = S.acc; c.fillRect(L, T + 8 * u, 16 * u, f.lines.length * lh - 16 * u); c.fillStyle = S.fg; c.textAlign = 'left'; c.font = F(f.size, TF);
      f.lines.forEach((l, i) => c.fillText(l, L + 40 * u + (1 - p) * 30 * u, T + lh * (i + 0.5))); const y = T + f.lines.length * lh + 18 * u; c.fillStyle = hexA(S.fg, 0.25); c.fillRect(L, y, CW * p, 2 * u); c.restore(); return y + 48 * u;
    }
    // 기본: 가운데 큰 제목 + 강조색 짧은 밑줄
    const f = fit(c, plain(title), CW, 2, (port ? 100 : 92) * u, 48 * u, TF), lh = f.size * 1.2;
    c.globalAlpha *= p; c.fillStyle = S.fg; c.textAlign = 'center'; c.font = F(f.size, TF);
    f.lines.forEach((l, i) => c.fillText(l, (L + R) / 2, T + (1 - p) * 26 * u + lh * (i + 0.5)));
    const y = T + f.lines.length * lh + 14 * u; c.fillStyle = S.acc; rr(c, (L + R) / 2 - 50 * u * p, y, 100 * u * p, 9 * u, 4 * u); c.fill(); c.restore(); return y + 56 * u;
  }
  // 카드 하나 (스타일마다 모양이 달라요)
  function card(c, S, x, y, w, h, on, u, i) {
    c.save();
    if (S.card === 'fill') { c.shadowColor = S.dark ? 'rgba(0,0,0,0.5)' : 'rgba(60,40,20,0.14)'; c.shadowBlur = 24 * u; c.shadowOffsetY = 8 * u; c.fillStyle = S.pastel ? S.pastel[i % S.pastel.length] : S.panel; if (S.pastel && !on) c.fillStyle = S.panel; rr(c, x, y, w, h, S.r * u); c.fill(); c.shadowColor = 'transparent'; if (on) { c.strokeStyle = S.acc; c.lineWidth = 5 * u; rr(c, x, y, w, h, S.r * u); c.stroke(); } }
    else if (S.card === 'line') { c.strokeStyle = on ? S.acc : S.line; c.lineWidth = (on ? 3.5 : 2) * u; rr(c, x, y, w, h, S.r * u); c.stroke(); if (on) { c.fillStyle = hexA(S.acc, 0.06); c.fill(); } }
    else if (S.card === 'panel') { c.fillStyle = S.panel; c.fillRect(x, y, w, h); c.fillStyle = on ? S.acc2 : S.acc; c.fillRect(x, y, 10 * u, h); c.strokeStyle = S.line; c.lineWidth = 2 * u; c.strokeRect(x, y, w, h); }
    else { c.fillStyle = on ? hexA(S.hl, 0.35) : S.panel; rr(c, x, y, w, h, S.r * u); c.fill(); }
    c.restore();
  }
  function badge(c, S, x, y, r, txt, on, u) {
    c.save(); c.textAlign = 'center'; c.textBaseline = 'middle';
    if (S.card === 'line') { c.strokeStyle = on ? S.acc : S.sub; c.lineWidth = 3 * u; c.beginPath(); c.arc(x, y, r, 0, 7); c.stroke(); c.fillStyle = on ? S.acc : S.sub; }
    else if (S.card === 'panel') { c.fillStyle = on ? S.acc2 : S.acc; c.fillRect(x - r, y - r, r * 2, r * 2); c.fillStyle = on ? '#111111' : '#FFFFFF'; }
    else if (S === STYLES.newsshorts) { c.fillStyle = on ? S.acc : '#2E313A'; c.fillRect(x - r, y - r, r * 2, r * 2); c.fillStyle = on ? '#111111' : '#FFFFFF'; }
    else { c.fillStyle = on ? S.acc : (S.card === 'flat' ? S.acc2 : hexA(S.acc, 0.7)); c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); c.fillStyle = '#FFFFFF'; }
    c.font = F(r * 1.1, TF); c.fillText(txt, x, y + r * 0.06); c.restore();
  }
  const curIdx = (n, at, t) => { let k = -1; for (let i = 0; i < n; i++) if (t >= at(i)) k = i; return k; };

  function steps(c, g, S, b, t, dur, at, tempo) {
    const n = g.items.length || 1, items = g.items.length ? g.items : ['(내용)'], u = b.u, k = curIdx(n, at, t);
    const horiz = !b.port && n <= 4 && b.CW > 1300 * u;
    c.save(); c.textBaseline = 'middle';
    if (horiz) {
      const gap = 36 * u, w = (b.CW - gap * (n - 1)) / n, h = Math.min(b.B - b.T, 520 * u), y0 = b.T + (b.B - b.T - h) / 2;
      items.forEach((s, i) => { const p = eo(ph(t, at(i), 0.45 * tempo)); if (p <= 0) return; const x = b.L + i * (w + gap), y = y0 + (1 - p) * 60 * u; c.save(); c.globalAlpha *= p;
        card(c, S, x, y, w, h, i === k, u, i); badge(c, S, x + w / 2, y + 96 * u, 50 * u, String(i + 1), i === k, u);
        const f = fit(c, s, w - 56 * u, 4, 64 * u, 36 * u, BF); c.font = F(f.size, BF); c.textAlign = 'center'; const lh = f.size * 1.25, ty = y + 200 * u + (h - 240 * u - f.lines.length * lh) / 2;
        f.lines.forEach((l, j) => rich(c, l, x + w / 2, ty + lh * (j + 0.5), S.fg, S.acc, 'center'));
        if (S.card === 'flat' && i === k) penCircle(c, x + w / 2, y + 96 * u, 70 * u, 66 * u, ph(t, at(i) + 0.2, 0.5), S.acc, 6 * u);
        c.restore();
        if (i < n - 1 && p > 0.9) { c.save(); c.fillStyle = S.dark ? S.sub : hexA(S.fg, 0.35); const ax = x + w + gap / 2, ay = y0 + h / 2; c.beginPath(); c.moveTo(ax - 10 * u, ay - 16 * u); c.lineTo(ax + 12 * u, ay); c.lineTo(ax - 10 * u, ay + 16 * u); c.fill(); c.restore(); }
      });
    } else {
      const gap = (b.port ? 34 : 22) * u, h = Math.min((b.port ? 250 : 170) * u, (b.B - b.T - gap * (n - 1)) / n), tot = n * h + (n - 1) * gap, y0 = b.T + Math.max(0, (b.B - b.T - tot) / 2);
      items.forEach((s, i) => { const p = eo(ph(t, at(i), 0.42 * tempo)); if (p <= 0) return; const y = y0 + i * (h + gap), x = b.L + (1 - p) * 70 * u; c.save(); c.globalAlpha *= p;
        card(c, S, x, y, b.CW, h, i === k, u, i); const r = Math.min(46 * u * b.k, h * 0.3); badge(c, S, x + 40 * u + r, y + h / 2, r, String(i + 1), i === k, u);
        const tx = x + 80 * u + r * 2, f = fit(c, s, b.R - tx - 30 * u, 2, Math.min(62 * u * b.k, h * 0.36), 34 * u, BF); c.font = F(f.size, BF); c.textAlign = 'left'; const lh = f.size * 1.2;
        f.lines.forEach((l, j) => rich(c, l, tx, y + h / 2 + lh * (j - (f.lines.length - 1) / 2), i === k || k < 0 || S.card !== 'line' ? S.fg : S.sub, S.acc, 'left'));
        if (S.card === 'flat' && i === k) penCircle(c, x + 40 * u + r, y + h / 2, r * 1.45, r * 1.35, ph(t, at(i) + 0.2, 0.5), S.acc, 6 * u);
        c.restore(); });
      if (S === STYLES.howto && n > 1) { const p = clamp((k + 1) / n, 0, 1), y = Math.min(b.B + 20 * u, y0 + tot + 34 * u); c.save(); c.fillStyle = S.line; rr(c, b.L, y, b.CW, 14 * u, 7 * u); c.fill(); c.fillStyle = S.acc2; rr(c, b.L, y, b.CW * eo(p), 14 * u, 7 * u); c.fill(); c.restore(); }
    }
    c.restore();
  }
  function parseNum(v) {   // "73%", "1,200원", "3.5배" → 앞말·숫자·뒷말 (한국식 큰 수 "1만 2천"은 세지 않고 그대로 보여 줘요)
    const m = /^(.*?)(-?\d{1,3}(?:,\d{3})+|-?\d+(?:\.\d+)?)(.*)$/.exec(v); if (!m || /\d/.test(m[3])) return null;
    const num = parseFloat(m[2].replace(/,/g, '')), dec = (m[2].split('.')[1] || '').length; return { pre: m[1], num, dec, comma: m[2].includes(','), post: m[3] };
  }
  const fmtN = (x, q) => { const s = x.toFixed(q.dec); return q.comma ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : s; };
  function number(c, g, S, b, t, dur, at, tempo) {
    const u = b.u, v = g.value || '0', q = parseNum(v), a0 = g.title ? 0.5 * tempo : 0.2, cp = eo(ph(t, a0, 1.3 * tempo)), pop = back(ph(t, a0, 0.5));
    let shown = v; if (q) { const f0 = g.from !== null && parseNum(g.from) ? parseNum(g.from).num : 0; shown = q.pre + fmtN(f0 + (q.num - f0) * cp, q) + q.post; }
    const pct = q && /%/.test(q.post) ? clamp(q.num / 100, 0, 1) : null, cy = b.T + (b.B - b.T) * (g.label ? 0.42 : 0.5);
    c.save(); c.textAlign = 'center'; c.textBaseline = 'middle';
    if (pct !== null) {   // %면 둥근 게이지(뉴스·방송은 막대)
      if (S.head === 'bar' || S.head === 'lower') { const w = b.CW * 0.86, x = b.CX - w / 2, y = cy + 170 * u; c.fillStyle = S.dark ? '#2A2D35' : S.line; c.fillRect(x, y, w, 30 * u); c.fillStyle = S.acc; c.fillRect(x, y, w * pct * cp, 30 * u); }
      else { const r = Math.min(b.CW, b.B - b.T) * 0.36; c.lineWidth = 34 * u; c.lineCap = 'round'; c.strokeStyle = S.dark ? hexA(S.fg, 0.12) : S.line; c.beginPath(); c.arc(b.CX, cy, r, 0, 7); c.stroke(); c.strokeStyle = S.acc; c.beginPath(); c.arc(b.CX, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct * cp); c.stroke(); }
    }
    const maxW = pct !== null && !(S.head === 'bar' || S.head === 'lower') ? Math.min(b.CW, b.B - b.T) * 0.56 : b.CW;
    const f = fit(c, shown.replace(/\d/g, '8'), maxW, 1, (b.port ? 230 : 220) * u, 70 * u, TF);
    c.save(); c.translate(b.CX, cy); c.scale(0.6 + 0.4 * pop, 0.6 + 0.4 * pop); c.globalAlpha *= clamp(pop * 1.5, 0, 1); c.font = F(f.size, TF); c.fillStyle = S.acc;
    if (S.card === 'line') { c.shadowColor = hexA(S.acc, 0.6); c.shadowBlur = 30 * u; } c.fillText(shown, 0, 0); c.restore();
    if (g.label) { const p = eo(ph(t, a0 + 0.6 * tempo, 0.5)), fl = fit(c, g.label, b.CW, 2, 66 * u * b.k, 36 * u, BF), lh = fl.size * 1.2, ly = (pct !== null && (S.head === 'bar' || S.head === 'lower')) ? cy + 250 * u : cy + Math.max(f.size * 0.7, pct !== null ? Math.min(b.CW, b.B - b.T) * 0.36 + 60 * u : 0) + 50 * u;
      c.globalAlpha *= p; c.font = F(fl.size, BF); fl.lines.forEach((l, i) => rich(c, l, b.CX, Math.min(b.B, ly) + lh * i + (1 - p) * 20 * u, S.fg, S.acc, 'center'));
      if (S.card === 'flat') { c.globalAlpha = 1; penCircle(c, b.CX, cy, f.size * 1.3, f.size * 0.66, ph(t, a0 + 1.3, 0.6), S.acc, 7 * u); } }
    c.restore();
  }
  function compare(c, g, S, b, t, dur, at, tempo) {
    const u = b.u, gap = 90 * u, w = (b.CW - gap) / 2, h0 = b.B - b.T, h = Math.min(h0, (b.port ? 900 : 640) * u), sides = [g.left, g.right], a0 = g.title ? 0.45 * tempo : 0.2;
    const qa = parseNum(g.left.value || ''), qb = parseNum(g.right.value || ''), mx = qa && qb ? Math.max(Math.abs(qa.num), Math.abs(qb.num)) || 1 : 0;
    b = Object.assign({}, b, { T: b.T + (h0 - h) / 2, B: b.T + (h0 - h) / 2 + h });
    c.save(); c.textBaseline = 'middle'; c.textAlign = 'center';
    sides.forEach((sd, i) => { const st = at(i) > 0 && g.at ? at(i) : a0 + i * 0.55 * tempo, p = eo(ph(t, st, 0.5 * tempo)); if (p <= 0) return; const x = b.L + i * (w + gap) + (i ? 1 : -1) * (1 - p) * 60 * u, on = g.win === (i ? 'right' : 'left');
      c.save(); c.globalAlpha *= p; card(c, S, x, b.T, w, h, on, u, i * 2);
      const hc = i ? S.acc2 : S.acc, fl = fit(c, sd.label || (i ? '오른쪽' : '왼쪽'), w - 70 * u, 2, 60 * u * b.k, 34 * u, TF), lh = fl.size * 1.15;
      c.fillStyle = S.card === 'panel' ? hc : S.card === 'line' ? 'transparent' : hexA(hc, S.dark ? 0.9 : 1); rr(c, x + 24 * u, b.T + 24 * u, w - 48 * u, fl.lines.length * lh + 34 * u, Math.max(4, S.r * 0.6) * u); c.fill();
      c.font = F(fl.size, TF); c.fillStyle = S.card === 'line' ? hc : (S.card === 'panel' && i ? '#111111' : S.dark && i === 0 && S === STYLES.newsshorts ? '#111111' : '#FFFFFF'); fl.lines.forEach((l, j) => c.fillText(l, x + w / 2, b.T + 41 * u + lh * (j + 0.5)));
      let y = b.T + fl.lines.length * lh + 100 * u;
      if (sd.value) { const fv = fit(c, sd.value, w - 60 * u, 1, 120 * u, 50 * u, TF); c.font = F(fv.size, TF); c.fillStyle = on || !g.win ? hc : S.sub; c.fillText(sd.value, x + w / 2, y + fv.size * 0.5); y += fv.size + 30 * u;
        const q = i ? qb : qa; if (q && mx) { const bw = (w - 80 * u) * Math.abs(q.num) / mx * eo(ph(t, st + 0.3, 0.9)); c.fillStyle = S.dark ? hexA(S.fg, 0.12) : S.line; c.fillRect(x + 40 * u, y, w - 80 * u, 22 * u); c.fillStyle = hc; c.fillRect(x + 40 * u, y, bw, 22 * u); y += 60 * u; } }
      if (sd.text) { const ft = fit(c, sd.text, w - 60 * u, 4, 54 * u * b.k, 32 * u, BF), lt = ft.size * 1.25; c.font = F(ft.size, BF); ft.lines.forEach((l, j) => rich(c, l, x + w / 2, Math.min(y, b.B - (ft.lines.length - j) * lt) + lt * (j + 0.5), S.fg, hc, 'center')); }
      c.restore(); });
    const pv = back(ph(t, a0 + 0.3, 0.5)); if (pv > 0) { const r = 58 * u * pv; c.fillStyle = S.dark ? S.fg : S.fg; c.beginPath(); c.arc(b.CX, b.T + h / 2, r, 0, 7); c.fill(); c.fillStyle = S.bg; c.font = F(48 * u * pv, TF); c.fillText('VS', b.CX, b.T + h / 2 + 2 * u); }
    c.restore();
  }
  function flow(c, g, S, b, t, dur, at, tempo) {
    const u = b.u, items = g.items.length ? g.items : ['(내용)'], n = items.length, k = curIdx(n, at, t), vert = b.port || n > 4;
    const pos = []; let nw, nh;
    if (vert) { const gap = 70 * u; nh = Math.min((b.port ? 220 : 150) * u, (b.B - b.T - gap * (n - 1)) / n); nw = Math.min(b.CW, b.port ? b.CW : 760 * u); const tot = n * nh + (n - 1) * gap, y0 = b.T + Math.max(0, (b.B - b.T - tot) / 2); for (let i = 0; i < n; i++) pos.push([b.CX, y0 + i * (nh + gap) + nh / 2]); }
    else { const gap = 80 * u; nw = (b.CW - gap * (n - 1)) / n; nh = Math.min(260 * u, b.B - b.T); const cy = b.T + (b.B - b.T) / 2; for (let i = 0; i < n; i++) pos.push([b.L + i * (nw + gap) + nw / 2, cy]); }
    c.save(); c.textAlign = 'center'; c.textBaseline = 'middle';
    for (let i = 0; i < n - 1; i++) {   // 잇는 선 + 그 위를 지나가는 빛 신호
      const [x1, y1] = pos[i], [x2, y2] = pos[i + 1], sx = vert ? x1 : x1 + nw / 2, sy = vert ? y1 + nh / 2 : y1, ex = vert ? x2 : x2 - nw / 2, ey = vert ? y2 - nh / 2 : y2;
      const p = eo(ph(t, at(i) + 0.3, Math.max(0.3, (at(i + 1) - at(i)) * 0.6))); if (p <= 0) continue;
      c.strokeStyle = S.dark ? hexA(S.fg, 0.35) : hexA(S.fg, 0.3); c.lineWidth = 4 * u; c.setLineDash(S.card === 'line' ? [10 * u, 10 * u] : []); c.beginPath(); c.moveTo(sx, sy); c.lineTo(sx + (ex - sx) * p, sy + (ey - sy) * p); c.stroke(); c.setLineDash([]);
      if (p >= 1) { const ang = Math.atan2(ey - sy, ex - sx); c.fillStyle = c.strokeStyle; c.beginPath(); c.moveTo(ex, ey); c.lineTo(ex - Math.cos(ang - 0.5) * 22 * u, ey - Math.sin(ang - 0.5) * 22 * u); c.lineTo(ex - Math.cos(ang + 0.5) * 22 * u, ey - Math.sin(ang + 0.5) * 22 * u); c.fill(); }
      const sp = ((t - at(i)) * 0.7 / tempo) % 1; if (t > at(i + 1) && k >= i + 1) { c.fillStyle = S.acc; c.shadowColor = S.acc; c.shadowBlur = 20 * u; c.beginPath(); c.arc(sx + (ex - sx) * sp, sy + (ey - sy) * sp, 10 * u, 0, 7); c.fill(); c.shadowBlur = 0; }
    }
    items.forEach((s, i) => { const p = back(ph(t, at(i), 0.5 * tempo)); if (p <= 0) return; const [x, y] = pos[i]; c.save(); c.translate(x, y); c.scale(0.7 + 0.3 * p, 0.7 + 0.3 * p); c.globalAlpha *= clamp(p, 0, 1);
      card(c, S, -nw / 2, -nh / 2, nw, nh, i === k, u, i); const f = fit(c, s, nw - 50 * u, vert ? 2 : 3, (vert ? 60 : 58) * u * b.k, 32 * u, BF), lh = f.size * 1.2; c.font = F(f.size, BF);
      f.lines.forEach((l, j) => rich(c, l, 0, lh * (j - (f.lines.length - 1) / 2), i === k || S.card !== 'line' ? S.fg : S.sub, S.acc, 'center'));
      if (S.card === 'flat' && i === k && !vert) penCircle(c, 0, 0, nw * 0.54, nh * 0.7, ph(t, at(i) + 0.3, 0.5), S.acc, 6 * u);
      c.restore(); });
    c.restore();
  }
  function quote(c, g, S, b, t, dur, at, tempo) {
    const u = b.u, txt = g.text || g.items.join(' ') || '(핵심 문장)', a0 = (g.title ? 0.45 : 0.15) * tempo;
    c.save(); c.textBaseline = 'middle';
    let y0 = b.T;
    if (g.label) { const p = eo(ph(t, a0, 0.4)); c.globalAlpha = p; c.font = F(44 * u, TF); const w = c.measureText(g.label).width + 50 * u; c.fillStyle = S.acc; rr(c, b.CX - w / 2, y0, w, 74 * u, 37 * u); c.fill(); c.fillStyle = S.dark || S === STYLES.newsshorts ? '#111111' : '#FFFFFF'; c.textAlign = 'center'; c.fillText(g.label, b.CX, y0 + 39 * u); c.globalAlpha = 1; y0 += 120 * u; }
    const f = fit(c, txt, b.CW, b.port ? 5 : 3, (b.port ? 112 : 104) * u, 44 * u, TF), lh = f.size * 1.3, tot = f.lines.length * lh, ty = y0 + Math.max(0, (b.B - y0 - tot) / 2);
    c.font = F(f.size, TF); c.textAlign = 'left';
    // 어절이 하나씩 차례로 올라와요. [강조] 말은 강조색 + 형광펜(인강)·빛(라인 아이콘)
    let wi = 0; const step = 0.12 * tempo;
    f.lines.forEach((line, li) => {
      const words = line.split(' '); let inHi = false; const parts = words.map((w) => { const hi = inHi || w.startsWith('['); if (w.includes('[')) inHi = true; const hiNow = hi; if (w.includes(']')) inHi = false; return [w.replace(/[[\]]/g, ''), hiNow]; });
      const sp = c.measureText(' ').width, tw = parts.reduce((a, [w]) => a + c.measureText(w).width, 0) + sp * (parts.length - 1); let x = b.CX - tw / 2; const y = ty + lh * (li + 0.5);
      parts.forEach(([w, hi]) => { const p = eo(ph(t, a0 + 0.2 + wi * step, 0.35)); wi++; const ww = c.measureText(w).width;
        if (p > 0) { c.save(); c.globalAlpha *= p;
          if (hi && S.hl) { c.fillStyle = hexA(S.hl, 0.75); c.fillRect(x - 6 * u, y + f.size * 0.08, (ww + 12 * u) * eo(ph(t, a0 + 0.5 + wi * step, 0.4)), f.size * 0.42); }
          if (hi && S.card === 'line') { c.shadowColor = hexA(S.acc, 0.7); c.shadowBlur = 26 * u; }
          c.fillStyle = hi ? (S.hl ? S.fg : S.acc) : S.fg; c.fillText(w, x, y + (1 - p) * 30 * u); c.restore(); }
        x += ww + sp; });
    });
    c.restore();
  }
  function list(c, g, S, b, t, dur, at, tempo) {
    const u = b.u, items = g.items.length ? g.items : ['(내용)'], n = items.length, gap = (b.port ? 30 : 20) * u, h = Math.min((b.port ? 220 : 150) * u, (b.B - b.T - gap * (n - 1)) / n), tot = n * h + (n - 1) * gap, y0 = b.T + Math.max(0, (b.B - b.T - tot) / 2), w = Math.min(b.CW, 1100 * u), x0 = b.CX - w / 2;
    c.save(); c.textBaseline = 'middle'; c.textAlign = 'left';
    items.forEach((s, i) => { const p = eo(ph(t, at(i), 0.4 * tempo)); if (p <= 0) return; const y = y0 + i * (h + gap); c.save(); c.globalAlpha *= p;
      card(c, S, x0 + (1 - p) * 50 * u, y, w, h, false, u, i); const bs = Math.min(64 * u * b.k, h * 0.46), bx = x0 + 36 * u, by = y + (h - bs) / 2;
      c.strokeStyle = S.dark ? S.sub : hexA(S.fg, 0.45); c.lineWidth = 4 * u; rr(c, bx, by, bs, bs, 10 * u); c.stroke();
      checkMark(c, bx + bs / 2, by + bs / 2, bs * 0.8, ph(t, at(i) + 0.3, 0.35), S.card === 'flat' ? S.acc : S.acc2 === '#F5F5F2' ? S.acc : (S === STYLES.newsshorts ? S.acc : S.acc2), 9 * u);
      const tx = bx + bs + 34 * u, f = fit(c, s, x0 + w - tx - 30 * u, 2, Math.min(60 * u * b.k, h * 0.36), 34 * u, BF), lh = f.size * 1.2; c.font = F(f.size, BF);
      f.lines.forEach((l, j) => rich(c, l, tx, y + h / 2 + lh * (j - (f.lines.length - 1) / 2), S.fg, S.acc, 'left')); c.restore(); });
    c.restore();
  }

  // ---- AI가 만든 HTML 을 잠긴 틀 안에서 그리기 ----
  // 틀은 인터넷·편집기 서버에 아무 요청도 못 해요(CSP default-src 'none'). 글꼴은 편집기가 파일을 직접 건네줘요.
  const FONT_ALIAS = [   // 구글 글꼴 이름을 쓰면 편집기 안의 비슷한 무료 글꼴로 바꿔 보여 줘요
    [/noto sans kr|gothic a1|ibm plex sans kr|nanum gothic|pretendard|spoqa|apple sd|malgun|sans/i, BF],
    [/black han|bagel|do hyeon|jua|gmarket|title/i, TF],
    [/serif|myeongjo|song myung|gowun batang|batang/i, 'NanumMyeongjo Bold'],
    [/pen script|gaegu|gamja|poor story|single day|brush|hand|dodum/i, 'Kyobo Handwriting 2019'],
  ];
  const fontBufs = {}, fontList = () => { try { return (window.MG && MG.fontList && MG.fontList()) || []; } catch (e) { return []; } };
  async function fontBuf(fam) { const f = fontList().find((q) => q.family === fam); if (!f) return null; if (!fontBufs[fam]) fontBufs[fam] = fetch(f.url).then((r) => r.arrayBuffer()).catch(() => null); return fontBufs[fam]; }
  function harness(W, H) {
    return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:">` +
      `<style>html,body{margin:0;background:transparent;overflow:hidden}</style><script>window.__RENDER__=true;window.W=${W};window.H=${H};` +
      `(function(){var P=parent;addEventListener('message',async function(e){var d=e.data||{};try{` +
      `if(d.cmd==='fonts'){for(var i=0;i<d.list.length;i++){var f=d.list[i];try{var ff=new FontFace(f.name,f.buf);await ff.load();document.fonts.add(ff);}catch(x){}}P.postMessage({mg:1,ok:'fonts'},'*');return;}` +
      `if(d.cmd==='info'){await (document.fonts&&document.fonts.ready);var c=document.getElementById('c')||document.querySelector('canvas');P.postMessage({mg:1,ok:'info',dur:+window.DUR||0,has:!!(c&&typeof window.draw==='function'),cw:c?c.width:0,ch:c?c.height:0},'*');return;}` +
      `if(d.cmd==='frame'){var c=document.getElementById('c')||document.querySelector('canvas');var r=window.draw(d.t);if(r&&r.then)await r;var o=document.createElement('canvas');o.width=${W};o.height=${H};var x=o.getContext('2d');if(!d.alpha){x.fillStyle='#000';x.fillRect(0,0,o.width,o.height);}` +
      `var s=Math.min(o.width/c.width,o.height/c.height),w=c.width*s,h=c.height*s;x.drawImage(c,(o.width-w)/2,(o.height-h)/2,w,h);` +
      `o.toBlob(async function(b){var buf=await b.arrayBuffer();P.postMessage({mg:1,ok:'frame',buf:buf},'*',[buf]);},d.alpha?'image/png':'image/jpeg',0.92);return;}` +
      `}catch(err){P.postMessage({mg:1,err:String(err&&err.message||err)},'*');}});window.addEventListener('error',function(e){P.postMessage({mg:1,err:String(e.message)},'*');});})();<\/script>`;
  }
  async function htmlRenderer(html, W, H, alpha) {
    const fr = document.createElement('iframe'); fr.setAttribute('sandbox', 'allow-scripts'); fr.style.cssText = `position:fixed;left:-99999px;top:0;width:${Math.min(W, 1920)}px;height:${Math.min(H, 1920)}px;border:0;opacity:0;pointer-events:none`;
    // HTML 안의 바깥 글꼴·스크립트 주소는 어차피 막히지만, 기다리지 않게 미리 지워요
    const clean = String(html).replace(/<link\b[^>]*>/gi, '').replace(/<script\b[^>]*\bsrc\s*=[^>]*>\s*<\/script>/gi, '').replace(/@import[^;]+;/gi, '');
    const box = await post('/api/mg/box', { doc: harness(W, H) + clean }); if (box.error) throw new Error(box.error);
    const other = location.hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';   // 편집기와 다른 주소 → 따로 떼어 돌아가요
    fr.src = `${location.protocol}//${other}:${location.port}/mg-box/${box.id}`; document.body.append(fr);
    let pending = null; const onMsg = (e) => { if (e.source !== fr.contentWindow || !e.data || !e.data.mg) return; const p = pending; pending = null; if (p) (e.data.err ? p.no(new Error(e.data.err)) : p.ok(e.data)); };
    window.addEventListener('message', onMsg);
    const kill = () => { pending = null; fr.remove(); window.removeEventListener('message', onMsg); };
    try {
    const ask = (msg, tr, ms) => new Promise((ok, no) => { pending = { ok, no }; fr.contentWindow.postMessage(msg, '*', tr || []); setTimeout(() => { if (pending) { pending = null; no(new Error('모션그래픽 HTML이 응답하지 않아요')); } }, ms || 15000); });
    await new Promise((ok) => { fr.onload = ok; setTimeout(ok, 4000); });
    const fams = new Set([TF, BF]); const want = []; const seen = new Set();
    (clean.match(/['"]([^'"]{2,40})['"]/g) || []).forEach((m) => { const nm = m.slice(1, -1); if (seen.has(nm)) return; seen.add(nm); const own = fontList().find((q) => q.family === nm); if (own) { fams.add(nm); return; } const al = FONT_ALIAS.find(([re]) => re.test(nm)); if (al && /[A-Za-z]/.test(nm) && /font|sans|serif|script|hand|gothic|myeongjo|han|hyeon|jua|gaegu|dodum|batang|plex|noto|pretendard|bagel|gmarket|song|gamja|poor|single|brush/i.test(nm)) want.push([nm, al[1]]); });
    const list = []; for (const f of fams) { const b = await fontBuf(f); if (b) list.push({ name: f, buf: b.slice(0) }); }
    for (const [nm, to] of want) { const b = await fontBuf(to); if (b) list.push({ name: nm, buf: b.slice(0) }); }
    await ask({ cmd: 'fonts', list }, list.map((x) => x.buf), 20000);
    const info = await ask({ cmd: 'info' });
    if (!info.has) throw new Error('모션그래픽 HTML에 canvas 와 window.draw(t) 가 없어요');
    return { dur: info.dur, frame: async (t) => { try { return (await ask({ cmd: 'frame', t, alpha }, [], 10000)).buf; } catch (e) { kill(); throw e; } }, close: kill };
    } catch (e) { kill(); throw e; }   // 응답이 없으면(무한 반복 등) 그 칸을 꺼요 → 이 모션그래픽만 건너뛰어요
  }

  // ---- 영상 파일로 만들기 ----
  const post = (u, b) => fetch(u, { method: 'POST', body: JSON.stringify(b || {}) }).then((r) => r.json()).catch(() => ({ error: '서버에 연결할 수 없어요' }));
  async function fontsReady() { try { await Promise.all([document.fonts.load(F(60, TF), '가나다123'), document.fonts.load(F(60, BF), '가나다123')]); } catch (e) {} }
  // opts: { W, H, dur, fps, job(작업 폴더), html(AI가 만든 HTML 글), onProgress(0~1) }
  async function render(mgIn, opts) {
    const g = normalize(mgIn), fps = clamp(Math.round(opts.fps || 30), 10, 60), W = Math.round(opts.W / 2) * 2, H = Math.round(opts.H / 2) * 2;
    let dur = clamp(+opts.dur || 4, 0.5, 120);
    const pad = opts.pad || null, hash = key(Object.assign({ pad }, g), W, H, dur, fps), name = label(g);
    const hit = await post('/api/mg/find', { hash, job: opts.job, name }); if (hit.media) return hit.media;
    let rd; await fontsReady();
    if (g.html) { if (!opts.html) throw new Error('모션그래픽 HTML을 읽지 못했어요: ' + g.html); rd = await htmlRenderer(opts.html, W, H, g.clear); }
    else { const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const c = cv.getContext('2d');
      rd = { frame: (t) => { frame(c, W, H, g, t, dur, pad); return new Promise((ok) => cv.toBlob((b) => b.arrayBuffer().then(ok), g.clear ? 'image/png' : 'image/jpeg', 0.92)); }, close: () => {} }; }
    const st = await post('/api/mg/start', { hash, w: W, h: H, fps, alpha: g.clear, job: opts.job, name });
    if (st.error) { rd.close(); throw new Error(st.error); }
    const N = Math.max(1, Math.round(dur * fps)); let batch = [], size = 0;
    const flush = async () => { if (!batch.length) return; const r = await fetch('/api/mg/frame?id=' + st.id, { method: 'POST', body: new Blob(batch) }).then((x) => x.json()).catch(() => ({ error: '서버에 연결할 수 없어요' })); batch = []; size = 0; if (r.error) throw new Error(r.error); };
    try {
      for (let i = 0; i < N; i++) { const b = await rd.frame(i / fps); batch.push(b); size += b.byteLength; if (batch.length >= 12 || size > 8e6) await flush(); if (opts.onProgress) opts.onProgress((i + 1) / N); }
      await flush();
    } catch (e) { rd.close(); post('/api/mg/cancel', { id: st.id }); throw e; }
    rd.close();
    const fin = await post('/api/mg/finish', { id: st.id }); if (fin.error) throw new Error(fin.error);
    return fin.media;
  }
  // 편집기 미리보기용: 한 장면을 작은 캔버스에 그려요
  function preview(cv, mgIn, t, dur, pad) { const g = normalize(mgIn), c = cv.getContext('2d'); if (g.html) { c.fillStyle = '#222'; c.fillRect(0, 0, cv.width, cv.height); c.fillStyle = '#fff'; c.font = F(cv.height * 0.08, BF); c.textAlign = 'center'; c.fillText('HTML 모션그래픽', cv.width / 2, cv.height / 2); return; } frame(c, cv.width, cv.height, g, t, dur, pad); }
  window.MG = { STYLES, TYPES, AUTO_STYLE, normalize, key, label, render, preview, frame };
})();
