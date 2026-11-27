# -*- coding: utf-8 -*-
"""영상의 여러 시각을 한 장의 그림(타일)으로 모아 임시 폴더에 저장해요. 이미지 확인 횟수와 토큰을 줄여요.
사용: python stills.py <영상> 3.2 10 25.5 ... [--width 320] [--cols 3] [--out 경로.jpg]
      python stills.py <영상> --every 5        (5초마다, 최대 9장)
시각을 안 주면 처음·중간·끝 3장. 각 칸 왼쪽 위에 몇 초인지 적어 줘요. 작업 폴더에는 아무것도 만들지 않아요."""
import sys, os, argparse, subprocess, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import need, info

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('file'); ap.add_argument('times', nargs='*', type=float)
    ap.add_argument('--every', type=float); ap.add_argument('--width', type=int, default=320); ap.add_argument('--cols', type=int, default=3)
    ap.add_argument('--max', type=int, default=9); ap.add_argument('--out')
    a = ap.parse_args()
    dur = info(a.file)['duration'] or 0
    ts = a.times
    if a.every: ts = [round(i * a.every, 2) for i in range(int(dur // a.every) + 1)]
    if not ts: ts = [0.5, dur / 2, max(0, dur - 0.5)]
    ts = [min(max(0, t), max(0, dur - 0.05)) for t in ts][:a.max]
    ff = need('ffmpeg'); tmp = tempfile.mkdtemp(prefix='dds_stills_'); parts = []
    for i, t in enumerate(ts):
        p = os.path.join(tmp, f'{i:02d}.jpg')
        vf = f"scale={a.width}:-2,drawtext=text='{t:.1f}s':x=6:y=6:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6"
        r = subprocess.run([ff, '-v', 'error', '-y', '-ss', f'{t:.3f}', '-i', a.file, '-frames:v', '1', '-vf', vf, p], capture_output=True)
        if r.returncode != 0:   # 글자 넣기가 안 되는 ffmpeg 이면 글자 없이
            subprocess.run([ff, '-v', 'error', '-y', '-ss', f'{t:.3f}', '-i', a.file, '-frames:v', '1', '-vf', f'scale={a.width}:-2', p], capture_output=True)
        if os.path.exists(p): parts.append(p)
    if not parts: sys.exit('✗ 그림을 뽑지 못했어요')
    cols = min(a.cols, len(parts)); rows = (len(parts) + cols - 1) // cols
    out = a.out or os.path.join(tempfile.gettempdir(), 'dds_stills_' + os.path.splitext(os.path.basename(a.file))[0][:20] + '.jpg')
    lst = os.path.join(tmp, 'list.txt')
    with open(lst, 'w', encoding='utf-8') as f:
        for p in parts: f.write("file '" + p.replace(chr(92), '/').replace("'", "'\\''") + "'\n")
    subprocess.run([ff, '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lst, '-vf', f'tile={cols}x{rows}', '-frames:v', '1', out], check=True)
    for p in parts + [lst]:
        try: os.remove(p)
        except OSError: pass
    try: os.rmdir(tmp)
    except OSError: pass
    print(f'{len(parts)}장 → {out}  (시각: {", ".join(f"{t:.1f}" for t in ts)})')
main()
