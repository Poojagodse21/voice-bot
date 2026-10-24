"""
Real-time AI voice agent.

How it works:
1. The LiveKit server tells this worker that a new room has started.
2. The worker joins the room and waits for the browser user.
3. It reads the user's prompt from the participant's metadata
   (the token server put it there when it created the access token).
4. It starts a Gemini Live (real-time speech-to-speech) session using that
   prompt as the system instructions, and talks with the user.
"""

import json
import logging
import os

from dotenv import load_dotenv
from google.genai import types
from livekit import agents
from livekit.agents import Agent, AgentServer, AgentSession
from livekit.plugins import google

load_dotenv()

logger = logging.getLogger("voice-agent")

# Generic by default: if the user sends no prompt, the bot answers anything.
DEFAULT_PROMPT = (
    "You are a helpful general voice assistant. Answer questions on any topic: "
    "general knowledge, technology, studies, health basics, cooking, travel and more. "
    "Be accurate, and say so when you are not sure."
)
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.8-live")
GEMINI_VOICE = os.getenv("GEMINI_VOICE", "Puck")

# How long the user must be silent before Gemini decides the turn is over.
# Google's docs: "the larger this value, the longer speech gaps can be without
# interrupting the user's activity but this will increase the model's latency."
VAD_SILENCE_MS = int(os.getenv("VAD_SILENCE_MS", "500"))

# Transcription language. English only: when Hindi is also listed, Gemini writes
# English words in Devanagari ("yes so I want" -> "यस सो आई वांट").
TRANSCRIPT_LANGUAGES = ["en-IN"]

# num_idle_processes=1 keeps one Python worker process warm and already
# imported. Without it (the "dev" default is 0) every new conversation pays
# a few seconds of cold start before the agent can even say hello.
server = AgentServer(num_idle_processes=1)


def read_prompt(metadata: str | None) -> str:
    """Pull the user's prompt out of the participant metadata (JSON)."""
    if not metadata:
        return DEFAULT_PROMPT
    try:
        prompt = json.loads(metadata).get("prompt", "").strip()
    except (json.JSONDecodeError, AttributeError):
        prompt = metadata.strip()
    return prompt[:4000] or DEFAULT_PROMPT


def log_reply_latency(session: AgentSession) -> None:
    """Print how long each reply took, so delays are numbers and not a feeling.

    LiveKit times every turn for us. On the agent's own message,
    `e2e_latency` is the gap between the user finishing speaking and the agent
    starting to answer -- the delay the user actually hears. On the user's
    message, `end_of_turn_delay` is how long the silence detector waited before
    deciding the user had stopped, which is the part we can tune.
    """

    @session.on("conversation_item_added")
    def _item(ev) -> None:
        # Not every item is a message (handoffs show up here too), so ask for
        # the role instead of assuming there is one.
        role = getattr(ev.item, "role", None)
        m = getattr(ev.item, "metrics", None) or {}
        if role == "assistant" and "e2e_latency" in m:
            logger.info("LATENCY reply=%.2fs", m["e2e_latency"])
        elif role == "assistant":
            # Only happens without a real microphone turn to measure from.
            logger.info("LATENCY reply=unavailable available=%s", sorted(m))
        elif role == "user" and "end_of_turn_delay" in m:
            logger.info("LATENCY waited_for_silence=%.2fs", m["end_of_turn_delay"])


@server.rtc_session()
async def entrypoint(ctx: agents.JobContext):
    await ctx.connect()

    # Wait for the browser user to join, then read their prompt.
    participant = await ctx.wait_for_participant()
    prompt = read_prompt(participant.metadata)
    logger.info("User %s joined with prompt: %s", participant.identity, prompt[:100])

    instructions = (
        f"{prompt}\n\n"
        "You are speaking out loud in a real-time voice conversation. "
        "Keep replies short and natural, like a phone call. "
        "Do not use markdown, lists, or emojis. "
        "The user speaks Indian English and may mix in Hindi words. "
        "Always reply in English unless the user clearly asks for another language."
    )

    # Write the transcript in English only. `language_codes` is the current
    # option name; `language_hints` is deprecated in google-genai.
    transcription = types.AudioTranscriptionConfig(language_codes=TRANSCRIPT_LANGUAGES)

    # Long chats get slower because every turn resends the whole conversation.
    # This keeps only a recent sliding window instead.
    compression = types.ContextWindowCompressionConfig(
        trigger_tokens=16000,
        sliding_window=types.SlidingWindow(target_tokens=8000),
    )

    # Answer sooner after the user stops talking. If it starts talking over
    # your pauses, raise VAD_SILENCE_MS in .env.
    vad = types.RealtimeInputConfig(
        automatic_activity_detection=types.AutomaticActivityDetection(
            end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_HIGH,
            silence_duration_ms=VAD_SILENCE_MS,
        ),
    )

    # Print the settings before connecting, so we never have to guess which
    # ones are live.
    logger.info(
        "CONFIG model=%s voice=%s transcript_languages=%s compression=%s vad=%s",
        GEMINI_MODEL,
        GEMINI_VOICE,
        transcription.language_codes,
        compression.sliding_window,
        vad.automatic_activity_detection,
    )

    session = AgentSession(
        llm=google.realtime.RealtimeModel(
            model=GEMINI_MODEL,
            voice=GEMINI_VOICE,
            api_key=os.getenv("GOOGLE_API_KEY"),
            input_audio_transcription=transcription,
            context_window_compression=compression,
            realtime_input_config=vad,
        ),
    )

    log_reply_latency(session)
    await session.start(room=ctx.room, agent=Agent(instructions=instructions))

    # Greet first so the user knows the agent is ready.
    await session.generate_reply(
        instructions="Greet the user in one short sentence, in the role you were given."
    )


if __name__ == "__main__":
    agents.cli.run_app(server)
