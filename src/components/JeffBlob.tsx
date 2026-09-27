"use client";

/**
 * JeffBlob — the voice dock. The blob is Jeff: it swells with whoever is
 * talking (the mic while listening, Jeff's output while speaking). A tap on
 * it starts the conversation, or cuts Jeff off while he is talking; it never
 * ends the call. The status line under it always names the state, and the
 * controls row makes mute / interrupt / end explicit buttons, so nothing
 * destructive hides behind a tap.
 */

import { useEffect, useRef } from "react";

/** dormant: no call. thinking: the person has finished and Jeff has not started talking yet. */
export type BlobMood = "dormant" | "connecting" | "listening" | "thinking" | "speaking";
export type DockTurn = { role: "user" | "jeff" | "tool"; text: string };

type Props = {
  mood: BlobMood;
  /** Returns the current 0..1 level to animate with (called every frame). */
  getLevel: () => number;
  /** Tap on the blob: start when idle, interrupt when Jeff is speaking. */
  onTap: () => void;
  onStart: () => void;
  onEnd: () => void;
  onInterrupt: () => void;
  muted: boolean;
  onToggleMute: () => void;
  error?: string | null;
  disabled?: boolean;
  /** Why the last conversation ended, shown once the dock is idle again. */
  endedNote?: string | null;
  /** Both sides of this conversation, in order. */
  transcript?: DockTurn[];
};

export default function JeffBlob({ mood, getLevel, onTap, onStart, onEnd, onInterrupt, muted, onToggleMute, error, disabled, endedNote, transcript }: Props) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript, mood]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (mood === "dormant" || mood === "connecting" || mood === "thinking" || (mood === "listening" && muted)) {
      el.style.setProperty("--voice-level", "0");
      return;
    }
    let raf = 0;
    let smoothed = 0;
    const tick = () => {
      const level = Math.min(1, Math.max(0, getLevel()));
      smoothed += (level - smoothed) * 0.25;
      el.style.setProperty("--voice-level", smoothed.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.style.setProperty("--voice-level", "0");
    };
  }, [mood, muted, getLevel]);

  const live = mood === "listening" || mood === "thinking" || mood === "speaking";
  const hasTurns = !!transcript && transcript.length > 0;

  // The one line that names the state.
  const status =
    mood === "connecting" ? "Connecting…"
    : mood === "speaking" ? "Jeff is talking"
    : mood === "thinking" ? "Jeff is thinking"
    : mood === "listening" ? (muted ? "Mic muted" : "Listening")
    : endedNote ? endedNote
    : hasTurns ? "Conversation ended"
    : "Tap Jeff to start talking";
  const hint =
    mood === "speaking" ? "tap the blob to cut in"
    : mood === "thinking" ? "hang on"
    : mood === "listening" ? (muted ? "unmute to be heard" : "just talk; Jeff hears you")
    : mood === "connecting" ? "asking for the mic"
    : null;

  const tapLabel = mood === "dormant" ? "Start talking to Jeff" : mood === "speaking" ? "Interrupt Jeff" : "Jeff is listening";

  return (
    <div className="voice-dock">
      <button
        ref={ref}
        type="button"
        className={`voice-blob voice-blob--${mood}${muted && live ? " voice-blob--muted" : ""}`}
        onClick={onTap}
        disabled={disabled || mood === "connecting" || mood === "thinking" || (mood === "listening" && !muted)}
        aria-label={tapLabel}
        title={tapLabel}
      >
        <span className="voice-blob-core" aria-hidden="true" />
        <span className="voice-blob-halo" aria-hidden="true" />
      </button>

      <div className={`voice-dock-status voice-dock-status--${mood}${muted && live ? " is-muted" : ""}`} aria-live="polite">
        <span className="voice-dock-dot" aria-hidden="true" />
        <span className="voice-dock-word">{status}</span>
        {hint && <span className="voice-dock-hint">{hint}</span>}
      </div>

      {error && <div className="voice-dock-helper voice-dock-error" role="alert">{error}</div>}

      <div className="voice-dock-controls">
        {mood === "dormant" && (
          <button type="button" className="voice-btn voice-btn--primary" onClick={onStart} disabled={disabled}>
            {hasTurns ? "Talk again" : "Talk to Jeff"}
          </button>
        )}
        {mood === "connecting" && (
          <button type="button" className="voice-btn voice-btn--ghost" onClick={onEnd}>Cancel</button>
        )}
        {live && (
          <>
            <button
              type="button"
              className={`voice-btn voice-btn--ghost${muted ? " is-on" : ""}`}
              onClick={onToggleMute}
              aria-pressed={muted}
              title={muted ? "Unmute your mic" : "Mute your mic"}
            >
              {muted ? "Unmute" : "Mute"}
            </button>
            <button
              type="button"
              className="voice-btn voice-btn--ghost"
              onClick={onInterrupt}
              disabled={mood !== "speaking"}
              title="Cut Jeff off"
            >
              Interrupt
            </button>
            <button type="button" className="voice-btn voice-btn--end" onClick={onEnd} title="Hang up">
              End
            </button>
          </>
        )}
      </div>

      {hasTurns && (
        <div ref={transcriptRef} className="voice-dock-transcript" aria-live="polite">
          {transcript!.map((turn, i) => (
            turn.role === "tool" ? (
              <div key={i} className="voice-turn voice-turn--tool">{turn.text}</div>
            ) : (
              <div key={i} className={`voice-turn voice-turn--${turn.role}${i === transcript!.length - 1 ? " is-latest" : ""}`}>
                <span className="voice-turn-who">{turn.role === "jeff" ? "Jeff" : "You"}</span>
                <p>{turn.text}</p>
              </div>
            )
          ))}
          {mood === "speaking" && transcript![transcript!.length - 1]?.role !== "jeff" && (
            <div className="voice-turn voice-turn--jeff is-latest voice-turn--typing"><span className="voice-turn-who">Jeff</span><p><span /><span /><span /></p></div>
          )}
        </div>
      )}
    </div>
  );
}
