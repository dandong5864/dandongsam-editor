# -*- coding: utf-8 -*-
"""만든 .dsp 를 편집기에서 열기 전에 검사해요. 사용: python validate_dsp.py <파일.dsp> [--folder 영상폴더] [--settings 편집설정.json]
오류(✗)가 있으면 종료코드 1."""
import sys, os, json, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import info, nfc

FONTS = {'Cafe24 Ssurround', 'Cafe24 Dangdanghae', 'Cafe24 Danjunghae', 'Cafe24 Dongdong', 'Cafe24 Ohsquare', 'Cafe24 Syongsyong',
         'Cafe24 Supermagic OTF Bold', 'Kyobo Handwriting 2019', 'Ownglyph PDH Regular', 'omyu pretty', 'AndongKaturi',
         'Ownglyph yuntaeng Regular', 'insungit Cutelively jisu', 'KCC-Chassam', 'Single Day',
         'NanumMyeongjo', 'NanumMyeongjo Bold', 'NanumMyeongjo ExtraBold'}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('dsp'); ap.add_argument('--folder'); ap.add_argument('--settings'); a = ap.parse_args()
    err, warn = [], []
    raw = open(a.dsp, 'rb').read()
    if raw.startswith(b'\xef\xbb\xbf'): warn.append('파일 맨 앞에 BOM 이 있어요 (UTF-8 BOM 없이 저장하세요)')
    try: j = json.loads(raw.decode('utf-8-sig'))
    except Exception as e: sys.exit(f'✗ JSON 형식이 아니에요: {e}')
    d = j.get('data') or j
    folder = a.folder or os.path.dirname(os.path.abspath(a.dsp))
    if not a.folder and os.path.basename(folder) == '결과': folder = os.path.dirname(folder)
    settings = None
    sp = a.settings or os.path.join(folder, '편집설정.json')
    if os.path.exists(sp): settings = json.load(open(sp, encoding='utf-8'))
    media, clips, audio, texts = d.get('media') or {}, d.get('clips') or [], d.get('audio') or [], d.get('texts') or []
    ids = [x.get('id') for x in clips + audio + texts]
    dup = {i for i in ids if ids.count(i) > 1}
    if dup: err.append(f'id 중복: {sorted(map(str, dup))}')
    present = {nfc(f) for f in os.listdir(folder)} if os.path.isdir(folder) else set()
    dur, vert = {}, {}
    for k, m in media.items():
        nm = m.get('name') if isinstance(m, dict) else m
        if not nm: err.append(f'media {k}: 이름이 없어요'); continue
        p = os.path.join(folder, nm)
        if not os.path.exists(p):
            near = [f for f in present if f.lower() == nfc(nm).lower()]
            err.append(f'media {k}: 폴더에 "{nm}" 파일이 없어요' + (f' (대소문자만 다른 파일: {near[0]})' if near else ' (이름·확장자·공백·괄호까지 똑같아야 해요)')); continue
        try: inf = info(p); dur[k] = inf['duration']; vert[k] = bool(inf.get('ratio') and inf['ratio'] < 1)
        except Exception as e: err.append(f'media {k}: 열 수 없어요 ({e})')
    for x in clips + audio:
        k = x.get('mediaId')
        if k not in media: err.append(f"{x.get('id')}: mediaId '{k}' 가 media 에 없어요"); continue
        i, o = float(x.get('in', 0)), float(x.get('out', 0))
        if not i < o: err.append(f"{x.get('id')}: in < out 이어야 해요 ({i}, {o})")
        if k in dur and o > dur[k] + 0.05: err.append(f"{x.get('id')}: out {o} 이 원본 길이 {dur[k]} 보다 길어요")
    for x in texts:
        if not float(x.get('start', 0)) < float(x.get('end', 0)): err.append(f"{x.get('id')}: start < end 이어야 해요")
        if x.get('font') not in FONTS: warn.append(f"{x.get('id')}: 글꼴 '{x.get('font')}' 은 목록에 없어요")
    if d.get('canvas') not in ('16:9', '9:16', 'original', '1:1', '4:3'): err.append(f"canvas 값이 이상해요: {d.get('canvas')}")
    vt = sum((float(c['out']) - float(c['in'])) / (float(c.get('speed', 1)) or 1) for c in clips if 'out' in c and 'in' in c)
    ae = max([float(x.get('start', 0)) + float(x['out']) - float(x['in']) for x in audio if 'out' in x and 'in' in x] or [0])
    se = max([float(t['end']) for t in texts if t.get('kind') == 'sub'] or [0])
    print(f'영상 조각 합계 {vt:.2f}초 · 더빙 끝 {ae:.2f}초 · 마지막 자막 끝 {se:.2f}초 · 영상 {len(clips)}컷 · 더빙 {len(audio)}조각 · 자막 {sum(1 for t in texts if t.get("kind") == "sub")}줄')
    if audio and abs(vt - ae) > 0.3: warn.append(f'영상 합계({vt:.2f})와 더빙 끝({ae:.2f})이 달라요')
    if se > max(vt, ae) + 0.3: warn.append('자막이 영상보다 길어요')
    if audio and any(not c.get('mute') and c.get('vol', 100) > 0 for c in clips): warn.append('더빙이 있는데 영상 조각의 소리가 켜져 있어요 (mute: true, vol: 0 권장)')
    if d.get('canvas') == '16:9' and (settings or {}).get('portrait', 'rot90') != 'keep':
        miss = [c['id'] for c in clips if vert.get(c.get('mediaId')) and int(c.get('rot') or 0) % 360 not in (90, 270)]
        if miss: warn.append(f"세로로 찍은 영상 {len(miss)}컷이 가로 캔버스에서 안 돌려졌어요 (rot 90 또는 270 필요, 예: {miss[0]})")
    if settings:
        if settings.get('canvas') and d.get('canvas') != settings['canvas']: warn.append(f"canvas 가 편집설정({settings['canvas']})과 달라요")
        if settings.get('tpl') != d.get('tpl'): warn.append('tpl 이 편집설정.json 과 달라요 (fitMid 포함 그대로 복사)')
        ss = settings.get('subtitle') or {}
        bad = [t['id'] for t in texts if t.get('kind') == 'sub' and any(t.get(k) != v for k, v in ss.items() if k != 'kind')]
        if bad: warn.append(f'자막 {len(bad)}줄이 편집설정의 자막 스타일과 달라요 (예: {bad[0]})')
        if settings.get('title') and not any(t.get('kind') == 'text' for t in texts): warn.append('편집설정에 제목이 있는데 제목 글자(kind: text)가 없어요')
    stray = [f for f in present if f.lower().endswith(('.mp4', '.mov', '.wav', '.mp3', '.m4a', '.mkv')) and f not in {nfc((m.get('name') if isinstance(m, dict) else m) or '') for m in media.values()}]
    if stray: print('참고: 프로젝트에서 안 쓰는 파일이 폴더에 있어요 →', ', '.join(sorted(stray)[:6]))
    for w in warn: print('△', w)
    for e in err: print('✗', e)
    print('결과:', '문제 없음 ✓' if not err and not warn else f'오류 {len(err)} · 주의 {len(warn)}')
    sys.exit(1 if err else 0)
main()
