#!/bin/bash
# usage: build_win.sh full|share
MODE=${1:-full}
SRC=/home/claude/VideoToolkit; NAME="단동샘편집기"; OUT=/tmp/pkg/$MODE; rm -rf "$OUT"; mkdir -p "$OUT/$NAME/runtime" "$OUT/$NAME/내보내기" "$OUT/$NAME/캡처" "$OUT/$NAME/효과음"
D="$OUT/$NAME"
cp /tmp/winbuild/package/bin/node.exe "$D/runtime/node.exe"
cp "$SRC/server.js" "$SRC/package.json" "$SRC/icon.ico" "$D/"
cp -r "$SRC/public" "$D/public"
# node_modules (windows)
mkdir -p "$D/node_modules/ffmpeg-static" "$D/node_modules/ffprobe-static/bin/win32/x64"
cp "$SRC/node_modules/ffmpeg-static/index.js" "$SRC/node_modules/ffmpeg-static/package.json" "$D/node_modules/ffmpeg-static/"
cp /tmp/winbuild/ffmpeg-win "$D/node_modules/ffmpeg-static/ffmpeg.exe"
cp "$SRC/node_modules/ffprobe-static/index.js" "$SRC/node_modules/ffprobe-static/package.json" "$D/node_modules/ffprobe-static/"
cp "$SRC/node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe" "$D/node_modules/ffprobe-static/bin/win32/x64/"
cp "$SRC/node_modules/ffmpeg-static/LICENSE" "$D/node_modules/ffmpeg-static/" 2>/dev/null
# 음성 → 자막 (whisper.node, 윈도우용 네이티브)
mkdir -p "$D/node_modules/@fugood/whisper.node" "$D/node_modules/@fugood/node-whisper-win32-x64"
cp -r "$SRC/node_modules/@fugood/whisper.node/lib" "$SRC/node_modules/@fugood/whisper.node/package.json" "$SRC/node_modules/@fugood/whisper.node/LICENSE" "$D/node_modules/@fugood/whisper.node/"
cp /tmp/wpk/package/index.node /tmp/wpk/package/package.json "$D/node_modules/@fugood/node-whisper-win32-x64/"
cp "$SRC/사용법 링크.txt" "$D/"
cp /tmp/launcher/launcher.exe "$D/단동샘 편집기.exe"
mkdir -p "$D/스티커"; cp "$SRC/기본스티커/"*.png "$D/스티커/";
mkdir -p "$D/효과음/기본 효과음"; cp /tmp/synth/out/*.mp3 "$D/효과음/기본 효과음/"
if [ "$MODE" = full ]; then
  cp -r "$SRC/samples" "$D/samples"; cp "$SRC/효과음/"* "$D/효과음/"
else
  echo "이 폴더에 mp3/wav 효과음 파일을 넣으면 편집기 왼쪽 [오디오] 탭 목록에 나와요. (기본 효과음 폴더는 직접 만든 소리라 자유롭게 써도 돼요)" > "$D/효과음/여기에_효과음_넣기.txt"
fi
cat > "$D/단동샘 편집기 (문제 해결용).bat" <<'BAT'
@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 단동샘 편집기 (문제 해결용)
echo 단동샘 편집기를 시작합니다. 이 창을 닫으면 프로그램이 종료돼요.
"%~dp0runtime\node.exe" server.js
echo.
echo 프로그램이 종료되었습니다. 위에 오류 글이 있으면 사진을 찍어 알려 주세요.
pause
BAT
python3 - "$D" <<'PYV'
import sys
vbs = """Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
Set lnk = sh.CreateShortcut(sh.SpecialFolders("Desktop") & "\단동샘 편집기.lnk")
lnk.TargetPath = folder & "\단동샘 편집기.exe"
lnk.WorkingDirectory = folder
lnk.IconLocation = folder & "\단동샘 편집기.exe"
lnk.Save
MsgBox "바탕화면에 [단동샘 편집기] 아이콘을 만들었어요." & vbCrLf & "이제 아이콘을 더블클릭하면 실행돼요.", 64, "단동샘 편집기"
""".replace("\n", "\r\n")
open(sys.argv[1] + "/바탕화면에_아이콘_만들기.vbs", "wb").write(b"\xff\xfe" + vbs.encode("utf-16-le"))
PYV
python3 /home/claude/mkzip.py "$OUT/$NAME" "/home/claude/${NAME}_윈도우_$MODE.zip" && ls -la "/home/claude/${NAME}_윈도우_$MODE.zip"
