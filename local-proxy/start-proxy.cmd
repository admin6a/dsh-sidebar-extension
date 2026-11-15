@echo off
rem DSH 本地剥头代理启动器（保持窗口运行即可）
cd /d "%~dp0"
node dsh-proxy.cjs
pause
