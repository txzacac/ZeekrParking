@echo off
setlocal
cd /d "%~dp0"
echo Installing Node dependencies...
call npm install
if errorlevel 1 goto :error
echo.
echo Installing Playwright Chromium...
call npx playwright install chromium
if errorlevel 1 goto :error
echo.
echo Done. Next steps:
echo 1. Copy .env.example to .env
echo 2. Edit .env
echo 3. Run: npm run skedda:login
pause
exit /b 0

:error
echo.
echo Install failed. Please check that Node.js is installed and try again.
pause
exit /b 1
