# -*- coding: utf-8 -*-
"""한국어 음성을 단어별 시각과 함께 받아 적어요 (Whisper large-v3-turbo, 내 컴퓨터에서 실행).
사용: python transcribe.py <영상/오디오> --out words.json
      python transcribe.py <파일1> <파일2> ... --out-dir "%TEMP%\\words"   (여러 파일: 모델을 한 번만 불러와요 → <파일이름>.words.json)
옵션: --model large-v3-turbo  --no-vad(말 없는 구간 거르기 끄기)  --force(이미 받아 적은 파일도 다시)
같은 파일을 이미 받아 적었으면(크기·수정 시각이 같으면) 건너뛰어요.
단동샘 편집기에서 [🎤 받아 적기]를 눌러 두었으면(작업 폴더/받아적기/) 그것을 그대로 써요 (--force 로 새로 받아 적기).
처음 한 번은 모델(약 1.6GB)을 내려받아요. 설치: python -m pip install faster-whisper==1.2.1"""
import sys, os, json, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common  # noqa: F401  (UTF-8 출력 설정)

def stamp(p):
    st = os.stat(p); return {'size': st.st_size, 'mtime': int(st.st_mtime)}

def done_before(src, out):
    try:
        j = json.load(open(out, encoding='utf-8'))
        return j.get('src') == stamp(src)
    except Exception: return False

EDITOR_DIR = '받아적기'   # 단동샘 편집기의 [🎤 받아 적기] 버튼이 작업 폴더에 만들어 두는 곳

def from_editor(src, out):
    """편집기가 이미 받아 적어 둔 파일(작업 폴더/받아적기/<파일이름>.words.json)이 있으면 그대로 옮겨 써요. 파이썬 음성 인식 설치가 필요 없어요."""
    p = os.path.join(os.path.dirname(os.path.abspath(src)), EDITOR_DIR, os.path.basename(src) + '.words.json')
    try:
        with open(p, encoding='utf-8-sig') as f: j = json.load(f)
    except Exception: return False
    if j.get('src') != stamp(src): return False   # 받아 적은 뒤 영상이 바뀌었으면 쓰지 않아요
    if not j.get('segments') and not j.get('noAudio'): return False   # 소리는 있는데 비어 있으면 다시 받아 적어 봐요
    if os.path.abspath(p) != os.path.abspath(out):
        d = os.path.dirname(os.path.abspath(out)); os.makedirs(d, exist_ok=True)
        with open(out, 'w', encoding='utf-8') as fo: json.dump(j, fo, ensure_ascii=False, indent=1)
    print(f'편집기가 받아 적어 둔 것을 써요 → {out} ' + ('(소리가 없는 파일이에요)' if j.get('noAudio') else f'(구간 {len(j["segments"])}개)'))
    return True

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('files', nargs='+'); ap.add_argument('--out'); ap.add_argument('--out-dir')
    ap.add_argument('--model', default='large-v3-turbo'); ap.add_argument('--lang', default='ko')
    ap.add_argument('--vad', action='store_true', help='(예전 옵션, 이제 기본으로 켜져 있어요)'); ap.add_argument('--no-vad', action='store_true')
    ap.add_argument('--force', action='store_true')
    a = ap.parse_args()
    if len(a.files) > 1 and not a.out_dir: sys.exit('[안내] 파일이 여러 개면 --out-dir 로 저장할 폴더를 정해 주세요.')
    jobs = []
    for f in a.files:
        out = a.out if (len(a.files) == 1 and a.out) else os.path.join(a.out_dir or '.', os.path.basename(f) + '.words.json')
        if not a.force and done_before(f, out): print(f'이미 받아 적었어요 → {out} (다시 하려면 --force)'); continue
        if not a.force and from_editor(f, out): continue
        jobs.append((f, out))
    if not jobs: return
    try: from faster_whisper import WhisperModel
    except ImportError: sys.exit("[필요] faster-whisper 가 없어요. 'python -m pip install faster-whisper==1.2.1' 를 실행한 뒤 다시 해 주세요.")
    try: model = WhisperModel(a.model, device='auto', compute_type='int8')
    except Exception as e: sys.exit(f"[실패] 모델을 불러오지 못했어요 ({e}). 인터넷 연결을 확인하거나 --model small 로 해 보세요.")
    for f, outp in jobs:
        # 말 없는 구간은 걸러요(기본): 조용한 곳에서 없는 말을 지어내는 것을 막아요. 시각은 원본 기준 그대로예요.
        segs, info = model.transcribe(f, language=a.lang, word_timestamps=True, vad_filter=not a.no_vad, condition_on_previous_text=False)
        out = {'file': os.path.basename(f), 'src': stamp(f), 'duration': round(info.duration, 3), 'segments': []}
        print(f'== {os.path.basename(f)}', flush=True)
        for s in segs:
            out['segments'].append({'start': round(s.start, 3), 'end': round(s.end, 3), 'text': s.text.strip(),
                                    'words': [{'w': w.word, 's': round(w.start, 3), 'e': round(w.end, 3)} for w in (s.words or [])]})
            print(f"{s.start:7.2f}-{s.end:7.2f}  {s.text.strip()}", flush=True)
        d = os.path.dirname(os.path.abspath(outp)); os.makedirs(d, exist_ok=True)
        with open(outp, 'w', encoding='utf-8') as fo: json.dump(out, fo, ensure_ascii=False, indent=1)
        print(f"저장: {outp}  (구간 {len(out['segments'])}개)\n")
main()
