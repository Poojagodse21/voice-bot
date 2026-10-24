# Real-Time AI Voice Bot

Click **Start** and talk to an AI voice agent out loud. By default it is a **general assistant that answers any question on any topic**. You can also type your own prompt ("You are an English tutor…") to give it a different role. Built on a **self-hosted LiveKit server** and **Gemini Live** (real-time speech-to-speech).

**Project folder:** `C:\Users\Shubham\voice-bot\voice-bot\voice-bot\` — this is the copy that actually runs (it holds `.venv`, `node_modules` and the `.env` files). Older copies from a second zip are parked in `C:\Users\Shubham\voice-bot\old-copies\` and are not used.

## Architecture

```
 Browser (Next.js page)                      Oracle Cloud VM (self-hosted)
 ┌───────────────────────┐   1. POST /api/token   ┌──────────────────────┐
 │ Prompt box + Start    │ ─────────────────────► │ Next.js token API     │
 │                       │ ◄── token (prompt in   │ (signs a LiveKit JWT) │
 │                       │      metadata) ──────  └──────────────────────┘
 │                       │
 │  mic audio ▲ ▼ voice  │   2. WebRTC audio      ┌──────────────────────┐
 │                       │ ◄────────────────────► │ LiveKit server        │
 │ transcript (chat)     │                        │ (Docker, ports 7880,  │
 └───────────────────────┘                        │  7881, 7882/udp)      │
                                                  └─────────┬────────────┘
                                                            │ 3. dispatches a job
                                                  ┌─────────▼────────────┐
                                                  │ Python agent          │
                                                  │ (LiveKit Agents)      │◄──► Gemini Live API
                                                  │ reads prompt → joins  │     (speech in,
                                                  │ room → talks          │      speech out)
                                                  └──────────────────────┘
```

**Flow in one line:** the browser gets a token from our API (the prompt rides inside it), joins a LiveKit room, the agent is dispatched into the same room, reads the prompt, and streams the conversation through Gemini Live.

| Part | Tech | Why |
| --- | --- | --- |
| Web page | Next.js + `livekit-client` | Simple UI, and the token API lives in the same app |
| Token API | `livekit-server-sdk` | API secret stays on the server; browser only gets a short-lived (10 min) token |
| Media server | LiveKit (self-hosted, Docker) | Handles real-time WebRTC audio; assignment requires self-hosting |
| Agent | Python, `livekit-agents[google]` | Official LiveKit framework with a Gemini Live plugin |
| AI | Gemini Live (`gemini-2.5-flash-native-audio-preview-12-2025`) | Native audio model: hears and speaks directly, low latency, no separate STT/TTS |

Design choices worth explaining:

- **New room per conversation** so each user gets their own agent instance.
- **Prompt passed in token metadata** so no database is needed and the prompt can't be changed by another user.
- **Generic by default.** The prompt box starts with a general assistant, and an empty prompt is allowed — the agent then uses its own "answer anything" instructions.
- **Transcripts** come from the agent as LiveKit text streams (`lk.transcription`) and are shown as a chat.
- **Clean state between calls.** **End** disconnects the room, releases the microphone, removes the audio elements and clears the transcript. A **New chat** button clears an old transcript without starting a call.
- **Low latency.** The agent server keeps one Python worker warm (`num_idle_processes=1`) so a new conversation does not wait for Python to start.
- **Stays fast in long chats.** `context_window_compression` keeps a sliding window of recent history instead of resending the whole conversation every turn.
- **Indian English + Hindi.** The speech recogniser gets `language_hints` of `en-IN` and `hi-IN`, and the browser mic uses echo cancellation so the bot does not hear itself.
- **Secrets** live in `.env` files, which are in `.gitignore`.

---

## Run it locally (Windows)

You need Docker Desktop running, Node.js 20+, Python 3.11+, and a Gemini API key from https://aistudio.google.com.

### Easiest: `start.bat`

Double-click **`start.bat`** in this folder. It opens three labelled windows (LiveKit server, voice agent, web app). Then open http://localhost:3000 in Chrome.

Close the three windows to stop everything.

> First time only: follow the manual steps below once to create `.venv`, install packages and fill in the `.env` files. After that `start.bat` is all you need.

### Manual: three windows

Open **three** PowerShell windows.

### Window 1: LiveKit server

```
docker run --rm -p 7880:7880 -p 7881:7881 -p 7882:7882/udp livekit/livekit-server --dev --bind 0.0.0.0 --node-ip 127.0.0.1
```

`--dev` uses the test key `devkey` / secret `secret`. Leave this window open.

### Window 2: AI agent

```
cd C:\Users\Shubham\voice-bot\voice-bot\voice-bot\agent
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
notepad .env
```

In Notepad, replace `your-gemini-api-key` with your real key, save, close. Then:

```
python agent.py dev
```

You should see the agent register with the server ("registered worker").

> If `activate` gives a "running scripts is disabled" error, run this once:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

### Window 3: Web page

```
cd C:\Users\Shubham\voice-bot\voice-bot\voice-bot\web
npm install
copy .env.example .env.local
npm run dev
```

Open http://localhost:3000, allow the microphone, and click **Start conversation**. Leave the prompt as it is for a general assistant, or type your own role first.

> **Wear headphones.** Echo cancellation helps, but speakers feeding back into the microphone is still the main reason the bot mishears you.

---

## Deploy

Vercel can't host LiveKit: real-time audio needs a long-running server with open UDP ports. So:

| Part | Where |
| --- | --- |
| LiveKit server + Python agent | Oracle Cloud Free Tier VM (Ubuntu) |
| Next.js web page + token API | Vercel (free) |

### 1. Oracle VM

1. Create an **Always Free** Ubuntu VM (Ampere A1 recommended). Note its public IP.
2. Get a domain or free subdomain (e.g. DuckDNS) and add an **A record** `livekit.yourdomain.com → VM IP`.
3. Open ports in **both** the Oracle Security List and the VM firewall:
   - TCP 80, 443, 7881
   - UDP 3478, 50000–60000
4. Generate the config on your laptop and copy the startup script to the VM:
   ```
   docker run --rm -it -v ${PWD}:/output livekit/generate
   ```
   Choose the VM option, enter your domain. It produces an API key/secret and an `init_script.sh` that installs Docker, LiveKit and Caddy (automatic SSL via Let's Encrypt).
5. On the VM: `sudo bash init_script.sh`, then check `systemctl status livekit-docker`.
6. Oracle's Ubuntu image blocks ports with iptables by default. Allow them:
   ```
   sudo iptables -I INPUT -p tcp -m multiport --dports 80,443,7881 -j ACCEPT
   sudo iptables -I INPUT -p udp -m multiport --dports 3478,50000:60000 -j ACCEPT
   sudo netfilter-persistent save
   ```
7. Run the agent on the same VM:
   ```
   git clone <your repo> && cd voice-bot/agent
   python3 -m venv .venv && . .venv/bin/activate
   pip install -r requirements.txt
   cp .env.example .env   # set LIVEKIT_URL=wss://livekit.yourdomain.com, real key/secret, Gemini key
   python agent.py start
   ```
   Keep it running with a systemd service or `pm2 start "python agent.py start" --name agent`.

### 2. Vercel

1. Push the repo to GitHub, import it in Vercel, set **Root Directory** to `web`.
2. Add environment variables: `LIVEKIT_URL=wss://livekit.yourdomain.com`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (from step 4).
3. Deploy. Vercel serves HTTPS, which browsers require for microphone access.

---

## Bonus: phone calls (SIP)

1. Run LiveKit's **SIP service** (`livekit/sip` Docker image) next to the server, with Redis (both share it). The generator in step 4 can include it.
2. Buy a number from a SIP trunk provider (Twilio, Telnyx, Plivo) and point its trunk at the VM.
3. Create an **inbound trunk** and a **dispatch rule** with the `lk` CLI so each call creates a room.
4. The same agent joins and answers the call. Callers have no prompt box, so the agent falls back to its default prompt (or a prompt set on the dispatch rule).

---

## Troubleshooting

| Problem | Check |
| --- | --- |
| "Could not get a token" | `.env.local` exists in `web` and has the three LiveKit values |
| Page connects but agent never speaks | Window 2 shows the agent registered; the Gemini key is correct |
| No sound | Click anywhere on the page (browsers block autoplay), check speaker volume |
| Mic doesn't work on the deployed site | Must be HTTPS |
| Works locally but not on Oracle | UDP ports open in both Oracle Security List and iptables |
| Bot mishears you / shows Devanagari | Use headphones; the agent sets `en-IN`/`hi-IN` language hints |
| Old transcript still on screen | Click **New chat** (**End** clears it automatically) |
| Edited a file and nothing changed | Check you edited the project folder named at the top of this README, not a copy in `old-copies` |
