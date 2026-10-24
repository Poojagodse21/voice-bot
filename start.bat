@echo off
REM Opens the three things this project needs, each in its own window.
REM Close the windows to stop everything.

echo Starting LiveKit server (Docker)...
start "LiveKit server" cmd /k docker run --rm -p 7880:7880 -p 7881:7881 -p 7882:7882/udp livekit/livekit-server --dev --bind 0.0.0.0

echo Starting the Python voice agent...
start "Voice agent" cmd /k "cd /d %~dp0agent && .venv\Scripts\activate && python agent.py dev"

echo Starting the web app...
start "Web app" cmd /k "cd /d %~dp0web && npm run dev"

echo.
echo All three started. Open http://localhost:3000 in Chrome.
