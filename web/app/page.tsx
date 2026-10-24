"use client";

import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track } from "livekit-client";
import styles from "./page.module.css";

type Status = "idle" | "connecting" | "connected" | "error";
type Message = { id: string; who: "you" | "agent"; text: string };

const EXAMPLES = [
  "You are a helpful general assistant. Answer any question on any topic clearly and briefly.",
  "You are a friendly hotel receptionist in Nashik. Help guests book rooms.",
  "You are an English tutor. Correct my grammar gently while we chat.",
  "You are a customer support agent for an internet provider.",
];

export default function Home() {
  const [prompt, setPrompt] = useState(EXAMPLES[0]);
  const [status, setStatus] = useState<Status>("idle");
  const [agentState, setAgentState] = useState("waiting");
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [muted, setMuted] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const audioBoxRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Leave the room if the page is closed.
  useEffect(() => () => void roomRef.current?.disconnect(), []);

  async function start() {
    // A second click while connecting would open a second room and leak the first.
    if (roomRef.current) return;
    setError("");
    setMessages([]);
    setStatus("connecting");

    try {
      // 1. Ask our own backend for a LiveKit token (the prompt goes with it).
      const res = await fetch("/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Could not get a token");

      // 2. Join the LiveKit room.
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        // Without these the mic picks up the bot's own voice from the speakers,
        // which confuses the speech recognition.
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      roomRef.current = room;

      // Play the agent's voice when its audio track arrives.
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          audioBoxRef.current?.appendChild(el);
        }
      });
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((el) => el.remove());
      });

      // Show what the agent is doing: listening / thinking / speaking.
      room.on(RoomEvent.ParticipantAttributesChanged, (_changed, participant) => {
        const state = participant.attributes["lk.agent.state"];
        if (state) setAgentState(state);
      });

      room.on(RoomEvent.Disconnected, () => {
        // Ignore the event if the user already started a newer conversation.
        if (roomRef.current !== room) return;
        roomRef.current = null;
        cleanupAudio();
        setStatus("idle");
        setAgentState("waiting");
      });

      // Live transcripts of both sides, sent by the agent as text streams.
      room.registerTextStreamHandler("lk.transcription", async (reader, participantInfo) => {
        const segmentId = reader.info.attributes?.["lk.segment_id"] ?? reader.info.id;
        const who: Message["who"] =
          participantInfo.identity === room.localParticipant.identity ? "you" : "agent";

        let text = "";
        for await (const chunk of reader) {
          text += chunk;
          const current = text;
          setMessages((prev) => {
            const exists = prev.some((m) => m.id === segmentId);
            return exists
              ? prev.map((m) => (m.id === segmentId ? { ...m, text: current } : m))
              : [...prev, { id: segmentId, who, text: current }];
          });
        }
      });

      await room.connect(data.url, data.token);

      // 3. Turn on the microphone so the agent can hear us.
      await room.localParticipant.setMicrophoneEnabled(true);
      await room.startAudio();
      setMuted(false);
      setStatus("connected");
    } catch (e) {
      await roomRef.current?.disconnect();
      roomRef.current = null;
      setStatus("error");
      setError(e instanceof Error ? e.message : "Something went wrong");
    }
  }

  // Remove any <audio> elements we attached, so no old audio keeps playing.
  function cleanupAudio() {
    const box = audioBoxRef.current;
    while (box?.firstChild) box.removeChild(box.firstChild);
  }

  async function stop() {
    const room = roomRef.current;
    roomRef.current = null;
    // disconnect() also stops the microphone track, so the mic light goes off.
    await room?.disconnect();
    cleanupAudio();
    setStatus("idle");
    setAgentState("waiting");
    setMuted(false);
    setMessages([]); // fresh, empty transcript for the next conversation
  }

  async function toggleMute() {
    const room = roomRef.current;
    if (!room) return;
    await room.localParticipant.setMicrophoneEnabled(muted);
    setMuted(!muted);
  }

  // Clear an old transcript without starting a new call.
  function newChat() {
    setMessages([]);
    setError("");
    setStatus("idle");
  }

  const isLive = status === "connected";
  const busy = status === "connecting";

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1>Voice Agent</h1>
        <p>Describe who the AI should be, then talk to it out loud.</p>
      </header>

      <section className={styles.card}>
        <label htmlFor="prompt" className={styles.label}>
          Prompt
        </label>
        <textarea
          id="prompt"
          className={styles.prompt}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={isLive || busy}
          rows={4}
          maxLength={4000}
        />
        <div className={styles.examples}>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              className={styles.chip}
              onClick={() => setPrompt(ex)}
              disabled={isLive || busy}
            >
              {ex.split(".")[0]}
            </button>
          ))}
        </div>

        <div className={styles.controls}>
          {!isLive ? (
            <button
              className={styles.primary}
              onClick={start}
              disabled={busy}
            >
              {busy ? "Connecting…" : "Start conversation"}
            </button>
          ) : (
            <>
              <button className={styles.secondary} onClick={toggleMute}>
                {muted ? "Unmute mic" : "Mute mic"}
              </button>
              <button className={styles.danger} onClick={stop}>
                End
              </button>
            </>
          )}
          {!isLive && !busy && messages.length > 0 && (
            <button className={styles.secondary} onClick={newChat}>
              New chat
            </button>
          )}
          {isLive && (
            <span className={styles.state} data-state={agentState}>
              <span className={styles.dot} /> Agent: {agentState}
            </span>
          )}
        </div>

        {error && <p className={styles.error}>{error}</p>}
      </section>

      <section className={styles.chat} aria-live="polite">
        {messages.length === 0 ? (
          <p className={styles.empty}>
            {isLive ? "Say hello. The conversation will appear here." : "Transcript appears here once you start."}
          </p>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={m.who === "you" ? styles.you : styles.agent}>
              <span className={styles.who}>{m.who === "you" ? "You" : "Agent"}</span>
              {m.text}
            </div>
          ))
        )}
        <div ref={chatEndRef} />
      </section>

      <div ref={audioBoxRef} hidden />
    </main>
  );
}

