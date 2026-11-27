# -*- coding: utf-8 -*-
"""대본을 AI 목소리(엣지 목소리, 무료)로 읽어 내레이션 파일 하나와 단어별 시각을 만들어요. 인터넷이 필요해요.
사용: python narrate.py 대본.txt --settings 편집설정.json --out "<작업 폴더>\\내레이션.mp3" --words "%TEMP%\\narr.words.json"
  대본.txt = 한 줄에 한 문장 (빈 줄은 건너뛰어요). 문장 끝에 마침표가 없으면 붙여서 읽어요.
  편집설정.json 의 voice = {"name": "ko-KR-SunHiNeural", "rate": "+10%"} 를 따라요. --voice / --rate 를 주면 그 값이 우선.
  목소리: ko-KR-SunHiNeural(여자) ko-KR-InJoonNeural(남자) ko-KR-HyunsuMultilingualNeural(남자2)
결과: 내레이션.mp3 (소리 파일 하나) + words.json (transcribe.py 와 같은 모양이라 make_texts.py 에 그대로 넣을 수 있어요)
같은 대본·목소리·빠르기로 이미 만들었으면 건너뛰어요 (--force 로 다시).
설치: python -m pip install -U edge-tts"""
import sys, os, json, argparse, asyncio, hashlib, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common  # noqa: F401  (UTF-8 출력 설정)

TICK = 10_000_000          # 엣지 시각 단위(100ns)
BPS = 48_000               # audio-24khz-48kbitrate-mono-mp3 (고정 비트레이트)
VOICES = {'female': 'ko-KR-SunHiNeural', 'male': 'ko-KR-InJoonNeural', 'male2': 'ko-KR-HyunsuMultilingualNeural'}
END = re.compile(r'[.!?…。？！~]$')

def read_lines(path):
    t = open(path, encoding='utf-8-sig').read()
    out = []
    for ln in t.splitlines():
        ln = ln.strip()
        if not ln: continue
        out.append(ln if END.search(ln) else ln + '.')
    return out

def align(lines, bounds):
    """엣지가 알려 준 단어(문장 부호 없음)를 대본 줄에 맞춰, 문장 부호까지 붙은 원래 글자로 돌려줘요."""
    segs = [{'text': ln, 'words': []} for ln in lines]
    li, cur = 0, 0
    for b in bounds:
        w = b['text'].strip()
        if not w: continue
        last = segs[li]['words'][-1] if segs[li]['words'] else None
        k = lines[li].find(w, cur)
        if k < 0 and last and w in last['w']:            # 한 덩어리를 나눠 읽은 경우(예: "3개" → "3", "개"): 앞 단어에 합쳐요
            last['e'] = round(b['e'], 3); continue
        if k < 0 and li + 1 < len(lines) and not re.search(r'\w', lines[li][cur:]):
            nk = lines[li + 1].find(w)                     # 지금 줄을 다 읽었으면 다음 줄로
            if nk >= 0: li, cur, k = li + 1, 0, nk
        if k >= 0:
            e = k + len(w)
            while e < len(lines[li]) and not lines[li][e].isspace(): e += 1   # 붙어 있는 조사·문장 부호까지
            if last and k < cur: k = cur
            word, cur = lines[li][k:e], e
        else:
            word = w
        segs[li]['words'].append({'w': word, 's': round(b['s'], 3), 'e': round(b['e'], 3)})
    return segs

async def speak(text, voice, rate, out_path):
    try: import edge_tts
    except ImportError: sys.exit("[필요] edge-tts 가 없어요. 'python -m pip install -U edge-tts' 를 실행한 뒤 다시 해 주세요.")
    kw = {'rate': rate, 'boundary': 'WordBoundary'}
    px = os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy')
    if px: kw['proxy'] = px
    bounds, size = [], 0
    tmp = out_path + '.part'
    with open(tmp, 'wb') as fo:
        async for ch in edge_tts.Communicate(text, voice, **kw).stream():
            if ch['type'] == 'audio': fo.write(ch['data']); size += len(ch['data'])
            elif ch['type'] == 'WordBoundary':
                s = ch['offset'] / TICK; bounds.append({'text': ch['text'], 's': s, 'e': s + ch['duration'] / TICK})
    if not size: os.remove(tmp); raise RuntimeError('소리를 받지 못했어요')
    os.replace(tmp, out_path)
    return bounds, size * 8 / BPS

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('script'); ap.add_argument('--settings'); ap.add_argument('--out', required=True)
    ap.add_argument('--words', required=True); ap.add_argument('--voice'); ap.add_argument('--rate'); ap.add_argument('--force', action='store_true')
    a = ap.parse_args()
    S = json.load(open(a.settings, encoding='utf-8-sig')) if a.settings and os.path.exists(a.settings) else {}
    V = S.get('voice') or {}
    voice = a.voice or V.get('name') or VOICES['female']; voice = VOICES.get(voice, voice)
    rate = a.rate or V.get('rate') or '+0%'
    if not re.fullmatch(r'[+-]\d{1,3}%', rate): sys.exit(f'[안내] 빠르기는 "+10%" 처럼 적어 주세요 (지금: {rate})')
    lines = read_lines(a.script)
    if not lines: sys.exit('[안내] 대본이 비어 있어요.')
    key = hashlib.sha256(json.dumps([lines, voice, rate], ensure_ascii=False).encode('utf-8')).hexdigest()[:16]
    if not a.force and os.path.exists(a.out):
        try:
            if json.load(open(a.words, encoding='utf-8')).get('key') == key: print(f'이미 만들었어요 → {a.out} (다시 하려면 --force)'); return
        except Exception: pass
    os.makedirs(os.path.dirname(os.path.abspath(a.out)) or '.', exist_ok=True)
    try: bounds, dur = asyncio.run(speak('\n'.join(lines), voice, rate, a.out))
    except SystemExit: raise
    except Exception as e:
        sys.exit(f"[실패] AI 목소리를 만들지 못했어요 ({e}). 인터넷 연결을 확인하고, 'python -m pip install -U edge-tts' 로 최신으로 바꾼 뒤 다시 해 주세요.")
    segs = align(lines, bounds)
    for sg in segs:
        sg['start'] = sg['words'][0]['s'] if sg['words'] else 0; sg['end'] = sg['words'][-1]['e'] if sg['words'] else 0
    out = {'file': os.path.basename(a.out), 'duration': round(dur, 3), 'voice': voice, 'rate': rate, 'key': key, 'segments': segs}
    os.makedirs(os.path.dirname(os.path.abspath(a.words)) or '.', exist_ok=True)
    with open(a.words, 'w', encoding='utf-8') as fo: json.dump(out, fo, ensure_ascii=False, indent=1)
    for sg in segs: print(f"{sg['start']:7.2f}-{sg['end']:7.2f}  {sg['text']}")
    print(f'저장: {a.out} ({dur:.1f}초, {voice}, 빠르기 {rate})\n단어 시각: {a.words}')
main()
