@echo off
chcp 65001 > nul
cd /d "%~dp0.."
title kitano-decibel Windows テスト

REM Windows 実機での自動テスト。結果は tests\windows-test-result.txt に保存される。
REM   [1] 保存サーバー Python 版の API テスト
REM   [2] 保存サーバー PowerShell 5.1 版（Windows 標準）の API テスト  ← Python が無い PC 用の予備サーバー
REM   [3] JS の単体テスト（Node.js がある場合のみ）
REM 本番の data フォルダには触れない（テストは一時フォルダで行う）。

set "OUT=%~dp0windows-test-result.txt"
> "%OUT%" echo ===== Windows テスト %date% %time% =====
ver >> "%OUT%"
echo テスト中です。終わるまでこのウィンドウを閉じないでください...

>> "%OUT%" echo.
>> "%OUT%" echo ----- [1] Python 版サーバー -----
python --version >> "%OUT%" 2>&1
python -m unittest discover -s tests -p "test_*.py" -v >> "%OUT%" 2>&1
>> "%OUT%" echo exit=%errorlevel%

>> "%OUT%" echo.
>> "%OUT%" echo ----- [2] PowerShell 5.1 版サーバー -----
set "KITANO_SERVER=powershell"
set "KITANO_PWSH=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
"%KITANO_PWSH%" -NoProfile -Command "'PowerShell ' + $PSVersionTable.PSVersion.ToString()" >> "%OUT%" 2>&1
python -m unittest discover -s tests -p "test_*.py" -v >> "%OUT%" 2>&1
>> "%OUT%" echo exit=%errorlevel%
set "KITANO_SERVER="
set "KITANO_PWSH="

>> "%OUT%" echo.
>> "%OUT%" echo ----- [3] JS テスト -----
where node > nul 2> nul
if errorlevel 1 goto nonode
node --test >> "%OUT%" 2>&1
>> "%OUT%" echo exit=%errorlevel%
goto done
:nonode
>> "%OUT%" echo Node.js が無いためスキップ

:done
>> "%OUT%" echo.
>> "%OUT%" echo ===== 完了 =====
echo 完了しました。結果: tests\windows-test-result.txt
timeout /t 5 > nul
