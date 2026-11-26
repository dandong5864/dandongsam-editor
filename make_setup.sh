#!/bin/bash
# usage: make_setup.sh  → /home/claude/단동샘편집기_설치.exe (설치 프로그램 + 압축 파일을 한 파일로)
set -e
ZIP=/home/claude/단동샘편집기_윈도우_share.zip; OUT=/home/claude/단동샘편집기_설치.exe
cp /tmp/installer/setup_stub.exe "$OUT"; cat "$ZIP" >> "$OUT"
python3 -c "import struct,os,sys; n=os.path.getsize(sys.argv[1]); open(sys.argv[2],'ab').write(struct.pack('<Q',n)+b'DDSPAYLD')" "$ZIP" "$OUT"
ls -la "$OUT"
