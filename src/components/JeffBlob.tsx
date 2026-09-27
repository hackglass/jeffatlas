"use client";

/**
 * JeffBlob — the voice dock. The blob is Jeff and the one control.
 * One tap does the obvious thing for the state Jeff is in. A line under
 * the blob says what a tap will do. The blob is the only conversation
 * control; its shape and color stay recognizably Jeff in every state.
 *
 *   dormant     tap → start
 *   connecting  tap → cancel
 *   listening   tap → pause
 *   thinking    tap → pause
 *   speaking    tap → cut in
 *   paused      tap → resume
 */

import { useEffect, useRef } from "react";

/** dormant: no call. thinking: the person has finished and Jeff has not started talking yet. paused: mic off, Jeff waiting. */
export type BlobMood = "dormant" | "connecting" | "listening" | "thinking" | "speaking" | "paused";
export type DockTurn = { role: "user" | "jeff" | "tool"; text: string };

type Props = {
  mood: BlobMood;
  /** Returns the current 0..1 level to animate with (called every frame). */
  getLevel: () => number;
  /** Tap on the blob: the natural next state (see the table above). */
  onTap: () => void;
  muted: boolean;
  error?: string | null;
  disabled?: boolean;
  /** Why the last conversation ended, shown once the dock is idle again. */
  endedNote?: string | null;
  /** Both sides of this conversation, in order. */
  transcript?: DockTurn[];
};

export default function JeffBlob({ mood, getLevel, onTap, muted, error, disabled, endedNote, transcript }: Props) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript, mood]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (mood === "dormant" || mood === "connecting" || mood === "thinking" || mood === "paused" || (mood === "listening" && muted)) {
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

  const hasTurns = !!transcript && transcript.length > 0;

  // The word names the state; the one hint line says what a tap will do.
  const word =
    mood === "connecting" ? "Connecting"
    : mood === "speaking" ? "Jeff is talking"
    : mood === "thinking" ? "Thinking"
    : mood === "paused" ? "Paused"
    : mood === "listening" ? (muted ? "One sec" : "Listening")
    : endedNote ?? (hasTurns ? "Ended" : "");
  const hint =
    error ? error
    : mood === "connecting" ? "Tap to cancel"
    : mood === "speaking" ? "Tap to interrupt"
    : mood === "thinking" ? "Tap to pause"
    : mood === "paused" ? "Tap to pick back up"
    : mood === "listening" ? "Take your time · tap to pause"
    : hasTurns ? "Tap to talk again"
    : "Tap to talk";

  const label =
    mood === "dormant" ? "Start talking to Jeff"
    : mood === "connecting" ? "Cancel"
    : mood === "speaking" ? "Interrupt Jeff"
    : mood === "paused" ? "Resume"
    : "Pause";

  return (
    <div className="voice-dock">
      <button
        ref={ref}
        type="button"
        className={`voice-blob voice-blob--${mood}`}
        onClick={onTap}
        disabled={disabled}
        aria-label={label}
        title={label}
      >
        <span className="voice-blob-core" aria-hidden="true" />
        <span className="voice-blob-halo" aria-hidden="true" />
      </button>

      {word && <div className={`voice-dock-word voice-dock-word--${mood}`} aria-live="polite">{word}</div>}
      <div className={`voice-dock-hint${error ? " is-error" : ""}`} role={error ? "alert" : undefined}>{hint}</div>

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
