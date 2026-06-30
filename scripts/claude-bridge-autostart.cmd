@echo off
rem Автозапуск хостового моста к подписочному Claude CLI (для генерации "в рамках тарифа" из Docker).
rem Вызывается скрытно из ярлыка в папке "Автозагрузка" (см. claude-bridge-autostart.vbs).
rem Лог: %TEMP%\claude-bridge.log
setlocal
rem Полный путь к claude.exe — чтобы не зависеть от PATH в контексте автозапуска.
if exist "%USERPROFILE%\.local\bin\claude.exe" set "CLAUDE_CLI_BIN=%USERPROFILE%\.local\bin\claude.exe"
cd /d "%~dp0.."
echo [%date% %time%] start claude-bridge >> "%TEMP%\claude-bridge.log"
node "%~dp0claude-bridge.js" >> "%TEMP%\claude-bridge.log" 2>&1
echo [%date% %time%] claude-bridge exited >> "%TEMP%\claude-bridge.log"
endlocal
