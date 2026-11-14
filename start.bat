@echo off
cd /d "%~dp0"
echo Factory Noise Meter  ->  http://localhost:8770
start "" http://localhost:8770
python -m http.server 8770 --bind 127.0.0.1
