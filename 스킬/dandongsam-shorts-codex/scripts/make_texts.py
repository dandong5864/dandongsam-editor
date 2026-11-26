# -*- coding: utf-8 -*-
"""받아 적은 단어(words.json)를 완성 타임라인 기준 자막(texts)으로 바꿔요. 더빙 조각의 start/in 을 반영해요.
사용: python make_texts.py --words words.json --pieces pieces.json --settings 편집설정.json --out texts.json [--title "첫줄\\n둘째줄"] [--max-chars 14]
pieces.json = 더빙 audio 항목들의 목록: [{"start":0,"in":0,"out":4.2}, ...]  (in/out 은 더빙 원본 시각)"""
import sys, os, json, argparse, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common  # noqa: F401

END = re.compile(r'[.!?…。？！]$')   # 문장 부호에서만 끊고, 나머지는 쉼(gap)과 글자 수로 나눠요

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--words', required=True); ap.add_argument('--pieces', required=True)
    ap.add_argument('--settings'); ap.add_argument('--out', default='texts.json'); ap.add_argument('--title')
    ap.add_argument('--max-chars', type=int, default=14); ap.add_argument('--gap', type=float, default=0.55); ap.add_argument('--hold', type=float, default=0.12)
    a = ap.parse_args()
    W = json.load(open(a.words, encoding='utf-8')); P = sorted(json.load(open(a.pieces, encoding='utf-8')), key=lambda p: p['start'])
    S = json.load(open(a.settings, encoding='utf-8')) if a.settings and os.path.exists(a.settings) else {}
    sub = dict(S.get('subtitle') or {'kind': 'sub', 'font': 'Cafe24 Ssurround', 'size': 86, 'color': '#ffffff', 'outline': 7, 'outlineColor': '#000000', 'x': 50, 'y': 81})
    sub['kind'] = 'sub'
    words = []
    for sg in W['segments']:
        for w in sg['words']:
            for p in P:
                if p['in'] - 1e-3 <= w['s'] < p['out'] - 1e-3:
                    words.append({'t': w['w'].strip(), 's': p['start'] + (w['s'] - p['in']), 'e': p['start'] + min(w['e'], p['out']) - p['in'], 'pe': p['start'] + p['out'] - p['in']}); break
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
    total = max([p['start'] + p['out'] - p['in'] for p in P] or [0])
    if a.title:
        t = dict(S.get('title') or {'kind': 'text', 'font': 'Cafe24 Ssurround', 'size': 90, 'color': '#ffffff', 'colors': [], 'outline': 8, 'outlineColor': '#000000', 'x': 50, 'y': 16}); t.pop('lines', None); t['kind'] = 'text'
        texts.insert(0, {'id': 't1', 'text': a.title.replace('\\n', '\n'), 'start': 0, 'end': round(total, 2), **t})
    json.dump(texts, open(a.out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f"자막 {len(lines)}줄 → {a.out} (끝 {total:.2f}초). 문장이 어색하게 끊긴 곳은 직접 고쳐 주세요.")
main()
