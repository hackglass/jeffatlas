"use client";

/**
 * JeffBlob — the one control. Copied in spirit from Timeaudit's voice dock:
 * the blob IS the assistant, a tap starts the conversation, a tap while Jeff
 * is talking cuts him off, and the word under it is the ONLY place the state
 * is named. `--voice-level` swells the body with whoever is talking (the
 * user's mic while listening, Jeff's output while speaking).
 */

import { useEffect, useRef } from "react";

export type BlobMood = "idle" | "connecting" | "listening" | "speaking";

type Props = {
  mood: BlobMood;
  /** Returns the current 0..1 level to animate with (called every frame). */
  getLevel: () => number;
  onTap: () => void;
  word: string;
  helper?: string;
  error?: string | null;
  disabled?: boolean;
  /** Small-print "Stop" under the blob; shown only when provided. */
  onStop?: () => void;
  /** What Jeff has said this conversation, printed under the blob. */
  transcript?: string[];
};

export default function JeffBlob({ mood, getLevel, onTap, word, helper, error, disabled, onStop, transcript }: Props) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (mood === "idle" || mood === "connecting") {
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
  }, [mood, getLevel]);

  const label = mood === "idle" ? "Tap to talk to Jeff" : mood === "speaking" ? "Interrupt Jeff" : "End the conversation";

  return (
    <div className="voice-dock">
      <button
        ref={ref}
        type="button"
        className={`voice-blob voice-blob--${mood}`}
        onClick={onTap}
        disabled={disabled}
        aria-label={label}
      >
        <span className="voice-blob-core" aria-hidden="true" />
        <span className="voice-blob-halo" aria-hidden="true" />
      </button>
      {word && <div className="voice-dock-word" aria-live="polite">{word}</div>}
      {error ? (
        <div className="voice-dock-helper voice-dock-error">{error}</div>
      ) : helper ? (
        <div className="voice-dock-helper">{helper}</div>
      ) : null}
      {onStop && (
        <div className="voice-dock-controls">
          <button type="button" className="voice-dock-quiet" onClick={onStop}>Stop</button>
        </div>
      )}
      {transcript && transcript.length > 0 && (
        <div ref={transcriptRef} className="voice-dock-transcript" aria-live="polite">
          {transcript.map((line, i) => (
            <p key={i} className={i === transcript.length - 1 ? "is-latest" : undefined}>{line}</p>
          ))}
        </div>
      )}
    </div>
  );
}
