@echo off
chcp 65001 > nul
cd /d "%~dp0"
title 声の大きさ競争 サーバー

REM ---- 起動用スクリプト ----
REM 1. 環境チェック（Python 3.8 以上があるか）
REM 2. Python があれば server.py、無ければ Windows 標準の PowerShell で server.ps1 を起動
REM    どちらも同じ data フォルダに記録をファイル保存する。保存先・ポート・ブラウザのチェックはサーバー側で行う
REM このウィンドウを閉じるとサーバーが止まるので、本番中は閉じないこと。

echo ===== 起動前チェック =====
set "PYCMD="
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>nul
if not errorlevel 1 set "PYCMD=python"
if defined PYCMD goto run_python
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>nul
if not errorlevel 1 set "PYCMD=py -3"
if defined PYCMD goto run_python

echo [情報] Python 3.8 以上が見つかりません。Windows 標準の PowerShell で起動します。
goto run_powershell

:run_python
echo [OK] Python が見つかりました: %PYCMD%
%PYCMD% "%~dp0server.py"
if not errorlevel 1 goto end
echo.
echo [注意] Python 版が起動できませんでした。PowerShell 版で起動し直します。
goto run_powershell

:run_powershell
where powershell >nul 2>nul
if errorlevel 1 goto no_runtime
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
goto end

:no_runtime
echo [NG] Python も PowerShell も見つかりません。
echo      Python 3 をインストールしてから、もう一度実行してください。
echo      https://www.python.org/downloads/  （インストール時に Add python.exe to PATH にチェック）

:end
echo.
echo サーバーが終了しました。もう一度 start.bat を実行すれば記録はそのまま戻ります。
pause
