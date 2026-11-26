# -*- coding: utf-8 -*-
"""폴더(또는 파일)의 영상·오디오를 표시 기준으로 요약해요. 사용: python probe.py <폴더 또는 파일>... [--json]"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import info, list_media

def main():
    args = [a for a in sys.argv[1:] if a != '--json']; as_json = '--json' in sys.argv
    if not args: sys.exit(__doc__)
    files = []
    for a in args: files += list_media(a) if os.path.isdir(a) else [a]
    rows = []
    for f in files:
        try: r = info(f); r['path'] = f; rows.append(r)
        except Exception as e: rows.append({'file': os.path.basename(f), 'path': f, 'error': str(e)})
    if as_json: print(json.dumps(rows, ensure_ascii=False, indent=1)); return
    for r in rows:
        if 'error' in r: print(f"✗ {r['file']}: {r['error']}"); continue
        if r['video']:
            extra = []
            if r['sar'] != 1: extra.append(f"픽셀비율 {r['sar']}")
            if r['rotation']: extra.append(f"회전 {r['rotation']:g}°")
            print(f"🎬 {r['file']}  {r['duration']}초  보이는 크기 {r['display']} (화면비 {r['ratio']}) {r['fps']}fps  저장크기 {r['stored']}  {' · '.join(extra)}  {'소리있음' if r['audio'] else '소리없음'}")
        else: print(f"🎧 {r['file']}  {r['duration']}초")
main()
