# -*- coding: utf-8 -*-
"""받아 적은 단어(words.json)를 완성 타임라인 기준 자막(texts)으로 바꿔요. 더빙 조각의 start/in 을 반영해요.
사용: python make_texts.py --words words.json --pieces pieces.json --settings 편집설정.json --out texts.json [--title "첫줄\\n둘째줄"] [--max-chars 14]
pieces.json = 소리 조각 목록: [{"start":0,"in":0,"out":4.2}, ...]  (in/out 은 받아 적은 원본 파일의 시각, start 는 완성 영상 시각)
  - 더빙이 있으면: 더빙 audio 항목들 그대로
  - 더빙 없이 영상 소리로 자막을 만들면: 그 영상의 clips 항목에 start(완성 영상에서 시작 시각)를 붙여서. "speed" 가 있으면 반영해요
편집설정.json 의 subSplit 이 "fast"/"slow" 면 한 줄 글자 수를 8/14 로 맞추고 "one": true 를 넣어요 (--max-chars 를 주면 그 값이 우선)"""
import sys, os, json, argparse, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common  # noqa: F401

END = re.compile(r'[.!?…。？！]$')   # 문장 부호에서만 끊고, 나머지는 쉼(gap)과 글자 수로 나눠요

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--words', required=True); ap.add_argument('--pieces', required=True)
    ap.add_argument('--settings'); ap.add_argument('--out', default='texts.json'); ap.add_argument('--title')
    ap.add_argument('--max-chars', type=int); ap.add_argument('--gap', type=float, default=0.55); ap.add_argument('--hold', type=float, default=0.12)
    a = ap.parse_args()
    W = json.load(open(a.words, encoding='utf-8-sig')); P = sorted(json.load(open(a.pieces, encoding='utf-8-sig')), key=lambda p: p['start'])
    S = json.load(open(a.settings, encoding='utf-8-sig')) if a.settings and os.path.exists(a.settings) else {}
    sub = dict(S.get('subtitle') or {'kind': 'sub', 'font': 'Cafe24 Ssurround', 'size': 86, 'color': '#ffffff', 'outline': 7, 'outlineColor': '#000000', 'x': 50, 'y': 81})
    sub['kind'] = 'sub'
    split = S.get('subSplit')
    if a.max_chars is None: a.max_chars = {'fast': 8, 'slow': 14}.get(split, 14)
    if split in ('fast', 'slow'): sub['one'] = True   # 한 줄 고정
    words = []
    for sg in W['segments']:
        for w in sg['words']:
            # 받아 적기는 쉰 뒤 첫 단어의 시작을 쉬는 동안으로 일찍 잡을 때가 있어요 → 글자 수에 비해 너무 긴 단어는 시작을 끝 쪽으로 당겨요
            n = len(re.sub(r'[^\w]', '', w['w'])); mx = 0.3 + 0.2 * max(1, n)
            if w['e'] - w['s'] > mx: w = dict(w, s=w['e'] - mx)
            for p in P:
                if p['in'] - 1e-3 <= w['s'] < p['out'] - 1e-3:
                    sp = float(p.get('speed') or 1) or 1; pe = p['start'] + (p['out'] - p['in']) / sp
                    words.append({'t': w['w'].strip(), 's': p['start'] + (w['s'] - p['in']) / sp, 'e': p['start'] + (min(w['e'], p['out']) - p['in']) / sp, 'pe': pe}); break
    words = [w for w in words if w['t']]
    lines, cur = [], []
    def flush():
        nonlocal cur
        if cur: lines.append(cur); cur = []
    for i, w in enumerate(words):
        if cur:
            text = ' '.join(x['t'] for x in cur)
            if w['s'] - cur[-1]['e'] > a.gap or len(text) + 1 + len(w['t']) > a.max_chars or w['pe'] != cur[-1]['pe']: flush()   # 잘린 자리에서는 줄도 나눠요
        cur.append(w)
        if END.search(w['t']) and len(' '.join(x['t'] for x in cur)) >= 4: flush()
    flush()
    texts = []
    for i, ln in enumerate(lines):
        st = round(ln[0]['s'], 2); nxt = lines[i + 1][0]['s'] if i + 1 < len(lines) else None
        en = min(ln[-1]['e'] + a.hold, ln[-1]['pe'])
        if nxt is not None: en = min(en, nxt)
        en = round(max(en, st + 0.3), 2)
        texts.append({'id': f's{i + 1}', 'text': ' '.join(x['t'] for x in ln), 'start': st, 'end': en, **sub})
    total = max([p['start'] + (p['out'] - p['in']) / (float(p.get('speed') or 1) or 1) for p in P] or [0])
    if a.title:
        t = dict(S.get('title') or {'kind': 'text', 'font': 'Cafe24 Ssurround', 'size': 90, 'color': '#ffffff', 'colors': [], 'outline': 8, 'outlineColor': '#000000', 'x': 50, 'y': 16}); t.pop('lines', None); t['kind'] = 'text'
        texts.insert(0, {'id': 't1', 'text': a.title.replace('\\n', '\n'), 'start': 0, 'end': round(total, 2), **t})
    json.dump(texts, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f"자막 {len(lines)}줄 → {a.out} (끝 {total:.2f}초). 문장이 어색하게 끊긴 곳은 직접 고쳐 주세요.")
main()
