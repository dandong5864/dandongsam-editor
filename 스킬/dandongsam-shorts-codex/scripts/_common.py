# -*- coding: utf-8 -*-
import sys, os, shutil, json, subprocess, unicodedata
for _s in (sys.stdout, sys.stderr):
    try: _s.reconfigure(encoding='utf-8')
    except Exception: pass

MEDIA_EXT = ('.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.wmv', '.mts', '.m2ts', '.ts', '.3gp',
             '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma')

def nfc(s): return unicodedata.normalize('NFC', s)

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS_FILE = '도구위치.json'   # 단동샘 편집기가 스킬을 복사할 때 자기 안의 ffmpeg/ffprobe 위치를 적어 둬요

def _inside(p, d):
    try: return os.path.commonpath([os.path.normcase(os.path.realpath(p)), os.path.normcase(os.path.realpath(d))]) == os.path.normcase(os.path.realpath(d))
    except Exception: return False

def _editor_tool(tool):
    """편집기에 들어 있는 ffmpeg/ffprobe 위치 (스킬 폴더 → 지금 폴더의 단동샘스킬 순서로 찾아요).
    남이 준 작업 폴더에 가짜 도구위치.json 을 심어 둘 수 있어서, 이름이 ffmpeg/ffprobe 이고 작업 폴더 밖에 있는 파일만 믿어요."""
    for d in (SKILL_DIR, os.path.join(os.getcwd(), '단동샘스킬')):
        try:
            with open(os.path.join(d, TOOLS_FILE), encoding='utf-8-sig') as f: p = (json.load(f) or {}).get(tool)
        except Exception: continue
        if not p or not isinstance(p, str) or not os.path.isabs(p) or not os.path.isfile(p): continue
        if os.path.basename(p).lower() not in (tool, tool + '.exe'): continue
        if _inside(p, os.path.dirname(os.path.abspath(d))) or _inside(p, os.getcwd()): continue   # 작업 폴더 안의 프로그램은 안 써요
        if os.name != 'nt' and p.lower().endswith('.exe'): continue   # 윈도우용 파일은 다른 운영체제에서 못 써요
        if os.name != 'nt' and not os.access(p, os.X_OK): continue
        return p
    return None

def need(tool):
    p = os.environ.get('DDS_' + tool.upper()) or _editor_tool(tool) or shutil.which(tool)
    if not p:
        sys.exit(f"[필요] {tool} 을(를) 찾지 못했어요. 단동샘 편집기에서 이 작업 폴더를 한 번 열면 편집기 안의 {tool} 위치가 '단동샘스킬/{TOOLS_FILE}' 에 적혀 저절로 쓰여요. "
                 "그래도 안 되면 윈도우: 터미널에서 'winget install Gyan.FFmpeg' 로 설치한 뒤 터미널을 새로 열어 주세요.")
    return p

def ffprobe_json(path):
    out = subprocess.run([need('ffprobe'), '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
                         capture_output=True, text=True, encoding='utf-8', errors='replace')
    if out.returncode != 0: raise RuntimeError(out.stderr.strip() or 'ffprobe 실패')
    return json.loads(out.stdout)

def info(path):
    """표시 기준(회전·픽셀 비율 반영) 크기와 길이를 돌려줘요."""
    j = ffprobe_json(path)
    v = next((s for s in j.get('streams', []) if s.get('codec_type') == 'video' and not (s.get('disposition') or {}).get('attached_pic')), None)
    a = next((s for s in j.get('streams', []) if s.get('codec_type') == 'audio'), None)
    dur = float((j.get('format') or {}).get('duration') or (v or a or {}).get('duration') or 0)
    r = {'file': os.path.basename(path), 'duration': round(dur, 3), 'video': bool(v), 'audio': bool(a)}
    if v:
        w, h = int(v['width']), int(v['height']); rot = 0.0
        for sd in v.get('side_data_list', []) or []:
            if 'rotation' in sd: rot = float(sd['rotation'])
        if not rot and (v.get('tags') or {}).get('rotate'): rot = float(v['tags']['rotate'])
        sar = 1.0; sm = str(v.get('sample_aspect_ratio') or '')
        if ':' in sm:
            try:
                a1, b1 = sm.split(':'); a1, b1 = float(a1), float(b1)
                if a1 > 0 and b1 > 0: sar = a1 / b1
            except ValueError: pass
        dw, dh = w * sar, float(h)
        if abs(rot) % 180 == 90: dw, dh = dh, dw
        fr = (v.get('r_frame_rate') or '0/1').split('/'); fps = float(fr[0]) / float(fr[1]) if float(fr[1] or 0) else 0
        r.update(stored=f'{w}x{h}', sar=round(sar, 3), rotation=rot, display=f'{round(dw)}x{round(dh)}',
                 ratio=round(dw / dh, 3), fps=round(fps, 2))
    return r

def list_media(folder):
    out = []
    for dp, dn, fn in os.walk(folder):
        if os.path.relpath(dp, folder).count(os.sep) >= 2: dn[:] = []
        for f in sorted(fn):
            if f.lower().endswith(MEDIA_EXT): out.append(os.path.join(dp, f))
    return out
