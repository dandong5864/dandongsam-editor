# -*- coding: utf-8 -*-
"""받아 적은 단어(words.json)에서 반복해서 한 말(다시 말하기·더듬기)을 찾아 잘라야 할 구간을 알려 줘요.
사용: python repeats.py words.json [--pieces pieces.json]
  --pieces 를 주면 이미 만든 소리 조각 안에 아직 남아 있는 반복만 보여 줘요 (다 잘랐는지 확인용).
규칙: 비슷한 말이 다시 나오면 앞의 것(끊기거나 틀린 테이크)을 자르고 마지막 완전한 것을 남겨요.
"""
import sys, os, json, argparse, re
from difflib import SequenceMatcher
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common  # noqa: F401

def norm(s): return re.sub(r'[^\w]', '', s)

def chunks(words, gap):
    """말 사이 쉼(gap)이나 문장 부호에서 나눈 말 덩어리"""
    out, cur = [], []
    for w in words:
        if cur and (w['s'] - cur[-1]['e'] > gap): out.append(cur); cur = []
        cur.append(w)
        if re.search(r'[.!?…]$', w['w'].strip()): out.append(cur); cur = []
    if cur: out.append(cur)
    return [{'s': c[0]['s'], 'e': c[-1]['e'], 't': ' '.join(x['w'].strip() for x in c), 'n': norm(''.join(x['w'] for x in c))} for c in out]

def similar(a, b):
    if len(a) < 3 or len(b) < 3: return 0
    k = len(os.path.commonprefix([a, b]))
    if b.startswith(a) or (k >= 4 and k >= 0.6 * len(a)): return 1.0      # 하다 만 말 → 처음부터 다시
    return SequenceMatcher(None, a, b).ratio()

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('words'); ap.add_argument('--pieces'); ap.add_argument('--gap', type=float, default=0.35)
    ap.add_argument('--within', type=float, default=20, help='이 초 안에서 다시 나온 말만 반복으로 봐요')
    a = ap.parse_args()
    W = json.load(open(a.words, encoding='utf-8-sig'))
    words = [{'w': w['w'], 's': float(w['s']), 'e': float(w['e'])} for sg in W['segments'] for w in sg.get('words', []) if w['w'].strip()]
    if a.pieces:   # 남긴 조각 안의 단어만
        P = json.load(open(a.pieces, encoding='utf-8-sig'))
        words = [w for w in words if any(p['in'] - 1e-3 <= w['s'] < p['out'] - 1e-3 for p in P)]
    found = []
    # 1) 바로 이어서 같은 단어 (예: "그래서 그래서")
    for i in range(1, len(words)):
        x, y = norm(words[i - 1]['w']), norm(words[i]['w'])
        if x and x == y and len(x) >= 1 and words[i]['s'] - words[i - 1]['e'] < 1.0:
            found.append((words[i - 1]['s'], words[i - 1]['e'], f'같은 단어 두 번: "{words[i - 1]["w"].strip()} {words[i]["w"].strip()}"', words[i]['s']))
    # 2) 말 덩어리를 다시 말함 (앞 테이크를 자르고 뒤를 남겨요)
    C = chunks(words, a.gap)
    for i, c in enumerate(C):
        for j in range(i + 1, min(i + 5, len(C))):
            d = C[j]
            if d['s'] - c['e'] > a.within: break
            r = similar(c['n'], d['n'])
            if r >= 0.6:
                found.append((c['s'], c['e'], f'다시 말함({r:.0%} 비슷): "{c["t"]}" → {d["s"]:.2f}초 "{d["t"]}"', d['s'])); break
    found.sort()
    if not found: print('반복된 말을 찾지 못했어요.' + (' (남긴 조각 기준)' if a.pieces else '')); return
    print(('남긴 조각 안에 아직 반복이 남아 있어요:' if a.pieces else '반복 후보 (앞의 것을 자르고 뒤의 것을 남기세요):'))
    for s, e, why, keep in found:
        print(f'  자르기 {s:7.2f} ~ {e:7.2f}  {why}')
    print(f'모두 {len(found)}곳. 의도한 반복(강조·후렴)이면 남겨도 돼요.')
    if a.pieces: sys.exit(2)
main()
