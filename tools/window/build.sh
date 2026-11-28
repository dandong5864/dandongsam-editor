#!/bin/bash
# 단동샘 편집기 실행 프로그램(단동샘 편집기.exe)을 리눅스에서 만들어요. 무료 도구(mingw-w64)만 써요.
#   apt-get install g++-mingw-w64-x86-64
#   bash tools/window/build.sh  → tools/window/out/ 에 exe 와 WebView2Loader.dll
# 두 파일을 설치 폴더(단동샘편집기/)에 같이 넣어야 해요.
set -e
cd "$(dirname "$0")"; mkdir -p out dl
[ -f dl/WebView2.h ] || curl -sfL https://raw.githubusercontent.com/arturo-lang/arturo/master/src/extras/webview/deps/include/WebView2.h -o dl/WebView2.h
if [ ! -f dl/WebView2Loader.dll ]; then
  curl -sfL https://static.crates.io/crates/webview2-com-sys/webview2-com-sys-0.38.0.crate -o dl/c.crate
  tar xzf dl/c.crate -C dl webview2-com-sys-0.38.0/x64/WebView2Loader.dll && mv dl/webview2-com-sys-0.38.0/x64/WebView2Loader.dll dl/
fi
x86_64-w64-mingw32-windres app.rc -O coff -o dl/app.res
x86_64-w64-mingw32-g++ -O2 -std=c++17 -municode -mwindows -I. -Idl launcher.cpp dl/app.res -o "out/단동샘 편집기.exe" \
  -static -static-libgcc -static-libstdc++ -lole32 -lshell32 -luser32 -lgdi32 -s
cp dl/WebView2Loader.dll out/
ls -la out
