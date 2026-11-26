@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\단동샘 편집기.lnk'); $s.TargetPath='%~dp0시작하기.bat'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%~dp0icon.ico'; $s.WindowStyle=7; $s.Save()"
echo.
echo  바탕화면에 [단동샘 편집기] 아이콘을 만들었습니다. 이제 아이콘을 더블클릭하면 실행돼요.
pause
