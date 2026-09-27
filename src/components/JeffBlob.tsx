"use client";

/**
 * JeffBlob — the voice dock. The blob is Jeff and the only control.
 * One tap does the obvious thing for the state Jeff is in; a hold ends
 * the call. A single line under the blob says what a tap will do.
 *
 *   dormant     tap → start
 *   connecting  tap → cancel
 *   listening   tap → mute / unmute
 *   thinking    tap → mute / unmute
 *   speaking    tap → cut in
 *   any live    hold → end
 */

import { useEffect, useRef } from "react";

/** dormant: no call. thinking: the person has finished and Jeff has not started talking yet. */
export type BlobMood = "dormant" | "connecting" | "listening" | "thinking" | "speaking";
export type DockTurn = { role: "user" | "jeff" | "tool"; text: string };

type Props = {
  mood: BlobMood;
  /** Returns the current 0..1 level to animate with (called every frame). */
  getLevel: () => number;
  /** Tap on the blob: the natural next state (see the table above). */
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

const HOLD_MS = 650;

export default function JeffBlob({ mood, getLevel, onTap, onEnd, muted, error, disabled, endedNote, transcript }: Props) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const holdTimer = useRef<number | null>(null);
  const heldRef = useRef(false);

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

  // Hold to end. A tap that turns into a hold does not also fire the tap.
  const clearHold = () => { if (holdTimer.current) { window.clearTimeout(holdTimer.current); holdTimer.current = null; } };
  const onPointerDown = () => {
    heldRef.current = false;
    if (!live) return;
    clearHold();
    holdTimer.current = window.setTimeout(() => { heldRef.current = true; ref.current?.classList.remove("is-holding"); onEnd(); }, HOLD_MS);
    ref.current?.classList.add("is-holding");
  };
  const onPointerUp = () => { clearHold(); ref.current?.classList.remove("is-holding"); };
  const onClick = () => { if (heldRef.current) { heldRef.current = false; return; } onTap(); };
  useEffect(() => clearHold, []);

  // The word names the state; the one hint line says what a tap will do.
  const word =
    mood === "connecting" ? "Connecting"
    : mood === "speaking" ? "Jeff is talking"
    : mood === "thinking" ? "Thinking"
    : mood === "listening" ? (muted ? "Muted" : "Listening")
    : endedNote ?? (hasTurns ? "Ended" : "Jeff");
  const hint =
    error ? error
    : mood === "connecting" ? "Tap to cancel"
    : mood === "speaking" ? "Tap to cut in · hold to end"
    : mood === "thinking" ? "Hold to end"
    : mood === "listening" ? (muted ? "Tap to unmute · hold to end" : "Tap to mute · hold to end")
    : hasTurns ? "Tap to talk again"
    : "Tap to talk";

  const label =
    mood === "dormant" ? "Start talking to Jeff"
    : mood === "connecting" ? "Cancel"
    : mood === "speaking" ? "Interrupt Jeff"
    : muted ? "Unmute" : "Mute";

  return (
    <div className="voice-dock">
      <button
        ref={ref}
        type="button"
        className={`voice-blob voice-blob--${mood}${muted && live ? " voice-blob--muted" : ""}`}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        disabled={disabled}
        aria-label={label}
        title={label}
      >
        <span className="voice-blob-core" aria-hidden="true" />
        <span className="voice-blob-halo" aria-hidden="true" />
      </button>

      <div className={`voice-dock-word voice-dock-word--${mood}${muted && live ? " is-muted" : ""}`} aria-live="polite">{word}</div>
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
