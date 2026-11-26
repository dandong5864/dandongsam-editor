/* 자막 자동 나누기: ⚡ 빠른 자막 / 🐢 느린 자막 (둘 다 무조건 한 줄)
   - 빠른 자막: 조사·어미 뒤에서 바로 끊어요. 한 컷 1~2어절, 공백 포함 8자 이내, 0.5~1초.
   - 느린 자막: 연결어미·종결어미(절) 기준으로 끊고, 너무 길면 조사 뒤에서 나눠요. 8~13자(최대 14자), 2초 이상.
   words: [{ text, start, end }] (어절 하나씩, 실제 말한 시간). 시간이 없으면 start/end 를 빼도 돼요.
   결과: [{ text, start, end }] */
(function (root) {
  'use strict';
  const RULE = {
    fast: { max: 8, gap: 0.45 },
    slow: { min: 8, good: 13, max: 14, gap: 0.8, sec: 2 },
  };
  const jong = (ch) => { const c = ch.charCodeAt(0) - 0xac00; return c >= 0 && c < 11172 ? c % 28 : -1; };
  const END2 = ['니다', '어요', '아요', '해요', '세요', '예요', '에요', '지요', '네요', '군요', '까요', '래요', '데요', '거든', '잖아'];
  const CL2 = ['지만', '는데', '은데', '니까', '도록', '려고', '다가', '면서', '어서', '아서', '해서', '려면', '으면', '더니', '거나', '든지', '자마자', '는지', '은지'];
  const CL1 = '면고며데록듯려';
  const JS1 = '은는이가을를에도로와과만께랑터럼게테서지야나';
  // 어절 하나의 끝 모양: end(문장 끝) / clause(연결어미·쉼표) / josa(조사) / mod(꾸미는 말: ~한, ~할) / open(조사 없는 말·한 글자)
  function kind(w) {
    const t = String(w).trim();
    if (/[.?!…。！？]["'”’)]*$/.test(t)) return 'end';
    if (/[,，、]["'”’)]*$/.test(t)) return 'clause';
    const h = t.replace(/[^가-힣]/g, '');
    if (h.length < 2) return 'open';
    const s = h.slice(-1), s2 = h.slice(-2);
    if (END2.includes(s2) || '다요죠까'.includes(s)) return 'end';
    if (CL2.includes(s2)) return 'clause';
    if (s === '서') return s2 === '에서' ? 'josa' : 'clause';
    if (CL1.includes(s)) return 'clause';
    if (s === '의') return 'mod';
    if (JS1.includes(s)) return 'josa';
    const j = jong(s); if (j === 4 || j === 8) return 'mod';
    return 'open';
  }
  const L = (a) => a.map((w) => w.text).join(' ').length;
  const hasT = (w) => w && isFinite(w.start) && isFinite(w.end);
  const pack = (ws) => ({ text: ws.map((w) => w.text).join(' '), start: ws[0].start, end: ws[ws.length - 1].end, n: ws.length });
  // 쉬는 구간이 길거나 문장이 끝나면 무조건 끊어요
  function sentences(words, gap) {
    const out = []; let cur = [];
    words.forEach((w, i) => { cur.push(w); const nx = words[i + 1]; if (!nx || kind(w.text) === 'end' || (hasT(w) && hasT(nx) && nx.start - w.end > gap)) { out.push(cur); cur = []; } });
    return out;
  }
  function fast(words) {
    const R = RULE.fast, out = [];
    sentences(words, R.gap).forEach((sn) => {
      let cur = [];
      sn.forEach((w, i) => {
        if (cur.length && kind(cur[cur.length - 1].text) === 'open' && L(cur.concat(w)) > R.max) { out.push(pack(cur)); cur = []; }
        cur.push(w);
        if (kind(w.text) !== 'open' || i === sn.length - 1) { out.push(pack(cur)); cur = []; }
      });
      if (cur.length) out.push(pack(cur));
    });
    return out;
  }
  function slow(words) {
    const R = RULE.slow, out = [];
    sentences(words, R.gap).forEach((sn) => {
      const n = sn.length, k = sn.map((w) => kind(w.text));
      // 나누기 비용: 가장 알맞은 길이(8~13자)·뜻이 이어지는 곳(연결어미·조사 뒤)에서 끊을수록 낮아요
      const cost = (a, b) => {   // sn[a..b-1] 한 컷
        const len = L(sn.slice(a, b)); let c = 0.5;
        if (len > R.max) c += 100 + len; else if (len > R.good) c += 1; else if (len < R.min) c += (R.min - len) * 0.8;
        for (let i = a; i < b - 1; i++) if (k[i] === 'clause') c += 2;
        if (b < n && (k[b - 1] === 'mod' || k[b - 1] === 'open')) c += 50;   // 꾸미는 말·조사 없는 말 뒤에서는 끊지 않아요
        if (hasT(sn[a]) && hasT(sn[b - 1])) { const d = sn[b - 1].end - sn[a].start; if (d < R.sec) c += (R.sec - d) * 0.6; }
        return c;
      };
      const best = [0], from = [0];
      for (let b = 1; b <= n; b++) { best[b] = Infinity; for (let a = 0; a < b; a++) { const v = best[a] + cost(a, b); if (v < best[b]) { best[b] = v; from[b] = a; } } }
      const cuts = []; for (let b = n; b > 0; b = from[b]) cuts.unshift([from[b], b]);
      cuts.forEach(([a, b]) => out.push(pack(sn.slice(a, b))));
    });
    return out;
  }
  // 화면에 보이는 시간: 다음 컷이 나올 때까지 이어서 보여 줘요 (빠른 자막은 최대 1초, 느린 자막은 최소 2초 쪽으로)
  function timing(segs, mode) {
    segs.forEach((q, i) => {
      const nx = segs[i + 1]; if (!hasT(q)) return;
      const want = mode === 'slow' ? Math.max(q.end + 0.3, q.start + RULE.slow.sec) : Math.max(q.end + 0.15, Math.min(q.start + 0.5, q.end + 0.5));
      q.end = +(nx && hasT(nx) ? Math.min(want, nx.start) : want).toFixed(2);
      if (nx && hasT(nx) && nx.start - q.end < (mode === 'slow' ? 1 : 0.3)) q.end = nx.start;   // 짧은 빈틈은 메워요
    });
    return segs;
  }
  function subSplit(words, mode) {
    const ws = (words || []).map((w) => ({ text: String(w.text || '').trim(), start: w.start, end: w.end })).filter((w) => w.text);
    if (!ws.length) return [];
    return timing(mode === 'slow' ? slow(ws) : fast(ws), mode);
  }
  // 글만 있을 때(시간 없이) 나눠 보기
  subSplit.text = (s, mode) => subSplit(String(s).split(/\s+/).map((t) => ({ text: t })), mode).map((q) => q.text);
  // 이미 있는 자막 줄을 어절로 풀어서, 글자 수 비율로 시간을 나눠 줘요
  subSplit.fromSubs = (subs) => {
    const ws = [];
    subs.forEach((x) => { const parts = String(x.text || '').replace(/\n/g, ' ').split(/\s+/).filter(Boolean), tot = parts.reduce((a, p) => a + p.length + 1, 0) || 1; let t0 = +x.start;
      parts.forEach((p) => { const t1 = t0 + (x.end - x.start) * (p.length + 1) / tot; ws.push({ text: p, start: +t0.toFixed(3), end: +t1.toFixed(3) }); t0 = t1; }); });
    return ws;
  };
  subSplit.kind = kind; subSplit.RULE = RULE;
  if (typeof module !== 'undefined' && module.exports) module.exports = subSplit; else root.subSplit = subSplit;
})(typeof window !== 'undefined' ? window : this);
