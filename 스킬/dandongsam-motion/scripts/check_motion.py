# -*- coding: utf-8 -*-
"""단동샘 모션그래픽 검사: .dsp 안의 모션그래픽 설계도(mg)가 규칙에 맞는지 봐요.
사용: python check_motion.py "<결과/이름.dsp>" [--settings "<편집설정.json>"]
종료코드: 0 문제 없음, 1 오류 있음"""
import sys, os, json, argparse, unicodedata
for _s in (sys.stdout, sys.stderr):
    try: _s.reconfigure(encoding='utf-8')
    except Exception: pass

TYPES = {'steps', 'number', 'compare', 'flow', 'quote', 'list'}
STYLES = {'howto', 'lineicon', 'newsshorts', 'pptpen', 'cardnews', 'broadcast'}
PER_MIN = {'low': (1, 2), 'mid': (2, 3), 'high': (4, 5)}


MG_KEYS = ('type', 'tpl', 'style', 'title', 'items', 'at', 'text', 'value', 'label', 'from', 'left', 'right', 'win', 'clear', 'html')
def mg_lift(x, is_clip=False):   # 편집기처럼 mg 묶음 없이 바로 적은 것({"kind":"mg","type":"steps",...})도 알아들어요
    if not isinstance(x, dict) or isinstance(x.get('mg'), dict): return
    if isinstance(x.get('mg'), str): x['mg'] = {'html': x['mg']} if x['mg'].lower().endswith(('.html', '.htm')) else {'type': x['mg']}; return
    if x.get('kind') in ('mg', 'motion') or (is_clip and x.get('type') == 'mg'):
        if not is_clip: x['kind'] = 'mg'
        x['mg'] = {k: x[k] for k in MG_KEYS if k in x and not (is_clip and k == 'type' and x[k] == 'mg')}


def plain(s): return str(s or '').replace('[', '').replace(']', '').strip()


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('dsp'); ap.add_argument('--settings'); a = ap.parse_args()
    err, warn = [], []
    try: j = json.loads(open(a.dsp, 'rb').read().decode('utf-8-sig'))
    except Exception as e: sys.exit(f'✗ JSON 형식이 아니에요: {e}')
    d = j.get('data') or j
    folder = os.path.dirname(os.path.abspath(a.dsp)); job = os.path.dirname(folder) if os.path.basename(folder) == '결과' else folder
    sp = a.settings or os.path.join(job, '편집설정.json'); motion = None
    if os.path.exists(sp):
        try: motion = (json.load(open(sp, encoding='utf-8-sig')) or {}).get('motion')
        except Exception: warn.append('편집설정.json 을 읽지 못했어요')
    clips, texts = d.get('clips') or [], d.get('texts') or []
    for c in clips: mg_lift(c, True)
    for x in texts: mg_lift(x)
    items = []   # (시작, 끝, 어디, id, mg)
    t = 0.0
    for c in clips:
        if isinstance(c.get('mg'), dict):
            du = float(c.get('dur') or 0)
            if du <= 0: err.append(f"{c.get('id')}: 모션그래픽 조각에 dur(초)가 없어요")
            items.append((t, t + du, 'clips', c.get('id'), c['mg'])); t += du
        else:
            try: t += (float(c.get('out', 0)) - float(c.get('in', 0))) / (float(c.get('speed', 1)) or 1)
            except Exception: pass
    total = t
    for x in texts:
        if x.get('kind') == 'mg' or isinstance(x.get('mg'), dict):
            if not isinstance(x.get('mg'), dict): err.append(f"{x.get('id')}: kind mg 에 mg 설계도가 없어요"); continue
            items.append((float(x.get('start', 0)), float(x.get('end', 0)), 'texts', x.get('id'), x['mg']))
    items.sort(key=lambda q: q[0])
    if not items:
        if motion: err.append(f"편집설정의 motion({motion.get('mode')})이 있는데 모션그래픽이 하나도 없어요")
        print('모션그래픽 0개'); return finish(err, warn)
    prev_type, seen = None, {}
    for (s, e, where, i, g) in items:
        ty = g.get('type'); ln = e - s
        if g.get('html'):
            p1, p2 = os.path.join(folder, g['html']), os.path.join(job, g['html'])
            if not (os.path.exists(p1) or os.path.exists(p2)): err.append(f"{i}: HTML 파일이 없어요: {g['html']}")
            else:
                h = open(p1 if os.path.exists(p1) else p2, encoding='utf-8', errors='replace').read()
                if 'draw' not in h or 'canvas' not in h: err.append(f"{i}: HTML 에 canvas 와 window.draw(t) 가 있어야 해요")
                if 'http://' in h or 'https://' in h: warn.append(f"{i}: HTML 이 인터넷 주소를 써요 (편집기에서는 막혀요)")
            ty = 'html'
        elif ty not in TYPES: err.append(f"{i}: type 은 {sorted(TYPES)} 중 하나여야 해요 (지금: {ty})")
        st = g.get('style')
        if st and st not in STYLES and not g.get('html'): warn.append(f"{i}: style '{st}' 은 기본 스타일이 아니라 비슷한 것으로 바뀌어요")
        if motion and motion.get('style') not in (None, 'auto') and st and st != motion.get('style'): warn.append(f"{i}: 편집설정 스타일은 {motion.get('style')} 인데 {st} 를 썼어요")
        if not (2.5 <= ln <= 10.5) and where == 'texts': warn.append(f"{i}: 길이 {ln:.1f}초 (3~8초가 좋아요)")
        if ln <= 0: err.append(f"{i}: 끝이 시작보다 빨라요")
        its = g.get('items') or []
        if ty in ('steps', 'flow') and not (2 <= len(its) <= 5): err.append(f"{i}: {ty} 는 항목이 2~5개여야 해요 (지금 {len(its)})")
        if ty == 'list' and not (2 <= len(its) <= 6): err.append(f"{i}: list 는 항목이 2~6개여야 해요 (지금 {len(its)})")
        if ty == 'number' and not str(g.get('value') or '').strip(): err.append(f"{i}: number 에 value 가 없어요")
        if ty == 'compare' and not (g.get('left') and g.get('right')): err.append(f"{i}: compare 에 left·right 가 있어야 해요")
        if ty == 'quote' and not plain(g.get('text')): err.append(f"{i}: quote 에 text 가 없어요")
        if len(plain(g.get('title'))) > 20: warn.append(f"{i}: 제목이 길어요 ({len(plain(g.get('title')))}자, 14자 안팎이 좋아요)")
        for q in its:
            if len(plain(q)) > 22: warn.append(f"{i}: 항목이 길어요: {plain(q)[:22]}…")
        at = g.get('at')
        if at and (not isinstance(at, list) or any((not isinstance(v, (int, float))) or v < 0 or v > ln for v in at)): warn.append(f"{i}: at 시각은 0~{ln:.1f}초 사이 숫자여야 해요")
        if ty == prev_type and ty != 'html' and where == 'texts': warn.append(f"{i}: 바로 앞과 같은 모양({ty})이에요 (연달아 쓰지 마세요)")
        prev_type = ty
        key = unicodedata.normalize('NFC', json.dumps({k: g.get(k) for k in ('type', 'title', 'items', 'text', 'value', 'left', 'right')}, ensure_ascii=False, sort_keys=True))
        if key in seen: err.append(f"{i}: {seen[key]} 와 같은 내용을 또 보여 줘요")
        seen[key] = i
    ov = [(a[3], b[3]) for a, b in zip(items, items[1:]) if a[2] == b[2] == 'texts' and b[0] < a[1] - 0.05]
    if ov: err.append(f'모션그래픽끼리 시간이 겹쳐요: {ov}')
    n_txt = sum(1 for q in items if q[2] == 'texts')
    if motion and motion.get('mode') == 'only' and any(not isinstance(c.get('mg'), dict) for c in clips): warn.append('mode only 인데 모션그래픽이 아닌 영상 조각이 있어요')
    if motion and motion.get('mode') in ('mix',) and total > 0 and n_txt:
        lo, hi = PER_MIN.get(motion.get('amount') or 'mid', (2, 3)); pm = n_txt / max(total / 60, 0.25)
        if pm > hi + 1: warn.append(f'1분에 {pm:.1f}개예요 (비중 {motion.get("amount") or "mid"} 은 {lo}~{hi}개)')
        if pm < lo - 1 and total > 40: warn.append(f'1분에 {pm:.1f}개예요 (비중 {motion.get("amount") or "mid"} 은 {lo}~{hi}개)')
    print(f'모션그래픽 {len(items)}개 (영상 줄 {len(items) - n_txt} · 덮기 {n_txt}) · 영상 {total:.1f}초')
    for (s, e, where, i, g) in items: print(f'  {s:6.1f}~{e:6.1f}초  {where:5}  {i}  {g.get("type") or "html"}  {plain(g.get("title") or g.get("text") or g.get("value"))[:24]}')
    return finish(err, warn)


def finish(err, warn):
    for w in warn: print('! ' + w)
    for e in err: print('✗ ' + e)
    if not err: print('✓ 모션그래픽 규칙에 맞아요')
    sys.exit(1 if err else 0)


if __name__ == '__main__': main()
