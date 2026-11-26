# -*- coding: utf-8 -*-
"""한국어 음성을 단어별 시각과 함께 받아 적어요 (Whisper large-v3-turbo, 내 컴퓨터에서 실행).
사용: python transcribe.py <영상/오디오> --out words.json [--model large-v3-turbo] [--vad]
처음 한 번은 모델(약 1.6GB)을 내려받아요. 설치: python -m pip install faster-whisper"""
import sys, os, json, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common  # noqa: F401  (UTF-8 출력 설정)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('file'); ap.add_argument('--out', default='words.json')
    ap.add_argument('--model', default='large-v3-turbo'); ap.add_argument('--vad', action='store_true'); ap.add_argument('--lang', default='ko')
    a = ap.parse_args()
    try: from faster_whisper import WhisperModel
    except ImportError: sys.exit("[필요] faster-whisper 가 없어요. 'python -m pip install faster-whisper' 를 실행한 뒤 다시 해 주세요.")
    try: model = WhisperModel(a.model, device='auto', compute_type='int8')
    except Exception as e: sys.exit(f"[실패] 모델을 불러오지 못했어요 ({e}). 인터넷 연결을 확인하거나 --model small 로 해 보세요.")
    segs, info = model.transcribe(a.file, language=a.lang, word_timestamps=True, vad_filter=a.vad, condition_on_previous_text=False)
    out = {'file': os.path.basename(a.file), 'duration': round(info.duration, 3), 'segments': []}
    for s in segs:
        out['segments'].append({'start': round(s.start, 3), 'end': round(s.end, 3), 'text': s.text.strip(),
                                'words': [{'w': w.word, 's': round(w.start, 3), 'e': round(w.end, 3)} for w in (s.words or [])]})
        print(f"{s.start:7.2f}-{s.end:7.2f}  {s.text.strip()}", flush=True)
    with open(a.out, 'w', encoding='utf-8') as f: json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"\n저장: {a.out}  (구간 {len(out['segments'])}개)")
main()
