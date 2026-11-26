@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 단동샘 편집기
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js 가 설치되어 있지 않습니다. 자동으로 설치합니다...
  where winget >nul 2>nul
  if errorlevel 1 (
    echo  자동 설치를 쓸 수 없는 PC입니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요.
    pause
    exit /b
  )
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  echo.
  echo  설치가 끝났습니다. 이 창을 닫고 [시작하기.bat] 을 한 번 더 실행해 주세요.
  pause
  exit /b
)
if not exist node_modules (
  echo.
  echo  처음 한 번만 필요한 구성요소를 내려받습니다. 1~2분 걸려요...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  설치에 실패했습니다. 인터넷 연결을 확인하고 다시 실행해 주세요.
    pause
    exit /b
  )
)
node server.js
echo.
echo  프로그램이 종료되었습니다.
pause
