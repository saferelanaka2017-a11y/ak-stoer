@echo off
chcp 65001 >nul
echo Installing packages...
call npm install
if errorlevel 1 goto err
echo Building Setup.exe ...
call npm run dist
if errorlevel 1 goto err
echo.
echo Done. Find the installer inside the "release" folder.
pause
exit /b 0
:err
echo Build failed. Send the error text above.
pause
