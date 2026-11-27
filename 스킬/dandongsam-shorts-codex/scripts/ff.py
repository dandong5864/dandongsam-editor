# -*- coding: utf-8 -*-
"""ffmpeg / ffprobe 를 따로 설치하지 않고 단동샘 편집기 안의 것으로 실행해요.
사용: python ff.py ffmpeg -y -i "<입력>" ... "<출력>"
      python ff.py ffprobe -v error -show_format "<파일>"
편집기 안의 것을 못 찾으면 컴퓨터에 설치된 ffmpeg/ffprobe 를 써요."""
import sys, os, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import need

def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ('ffmpeg', 'ffprobe'): sys.exit(__doc__)
    sys.exit(subprocess.run([need(sys.argv[1])] + sys.argv[2:]).returncode)
main()
