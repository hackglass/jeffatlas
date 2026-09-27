"use client";

/**
 * Whiteboard — Jeff's sketchpad on the right.
 *
 * Plays a Scene step by step: shapes sketch in, arrows draw themselves, the
 * elements the current caption is about glow while the rest soften. It is
 * SVG on a 1000x600 virtual board, so it scales with the panel.
 */

import { useEffect, useMemo, useState } from "react";
import { BOARD_H, BOARD_W, type BoardElement, type Scene } from "@/lib/board";

type Props = {
  scene: Scene;
  /** ms between steps; a caption with more words plays a little longer. */
  stepMs?: number;
  onStep?: (index: number, total: number) => void;
  onDone?: () => void;
  onClear?: () => void;
};

const DEFAULT: Record<BoardElement["kind"], { w: number; h: number }> = {
  box: { w: 200, h: 80 }, note: { w: 220, h: 70 }, person: { w: 60, h: 60 }, group: { w: 320, h: 220 },
  label: { w: 200, h: 30 }, arrow: { w: 0, h: 0 }, check: { w: 30, h: 30 }, cross: { w: 30, h: 30 },
};

export default function Whiteboard({ scene, stepMs = 1600, onStep, onDone, onClear }: Props) {
  const [shown, setShown] = useState(1);
  // Restart whenever a new scene arrives (adjust-state-during-render pattern).
  const [prevScene, setPrevScene] = useState(scene);
  if (prevScene !== scene) { setPrevScene(scene); setShown(1); }

  useEffect(() => {
    onStep?.(shown - 1, scene.steps.length);
    if (shown >= scene.steps.length) { onDone?.(); return; }
    const step = scene.steps[shown - 1];
    const extra = Math.min(1800, (step.caption?.split(/\s+/).length ?? 0) * 90 + step.add.length * 220);
    const t = setTimeout(() => setShown((s) => s + 1), stepMs + extra);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, scene, stepMs]);

  const visible = useMemo(() => scene.steps.slice(0, shown), [scene, shown]);
  const current = visible[visible.length - 1];
  const spot = new Set(current?.highlight ?? []);

  // Elements in draw order: groups behind, arrows on top, with the step that
  // introduced them so animations can be staggered.
  const elements = useMemo(() => {
    const out: { el: BoardElement; step: number; order: number }[] = [];
    visible.forEach((s, si) => s.add.forEach((el, oi) => out.push({ el, step: si, order: oi })));
    const rank = (k: BoardElement["kind"]) => (k === "group" ? 0 : k === "arrow" ? 2 : 1);
    return out.sort((a, b) => rank(a.el.kind) - rank(b.el.kind) || a.step - b.step || a.order - b.order);
  }, [visible]);
  const byId = useMemo(() => new Map(elements.map((e) => [e.el.id, e.el])), [elements]);

  return (
    <div className="wb">
      <svg viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} role="img" aria-label={`Whiteboard: ${scene.title}`}>
        <defs>
          <filter id="wb-rough" x="-5%" y="-5%" width="110%" height="110%">
            <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="2" seed="3" result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale="2.2" />
          </filter>
          <marker id="wb-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
            <path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
        </defs>
        {elements.map(({ el, step, order }) => {
          const isNew = step === shown - 1;
          const dim = spot.size > 0 && !spot.has(el.id) && el.kind !== "group" && el.kind !== "arrow";
          const cls = `wb-el wb-${el.kind}${isNew ? " wb-in" : ""}${spot.has(el.id) ? " wb-spot" : ""}${dim ? " wb-dim" : ""} wb-${el.emphasis ?? "normal"}`;
          const style = { animationDelay: isNew ? `${order * 260}ms` : "0ms" } as const;
          return <g key={el.id} className={cls} style={style}>{draw(el, byId)}</g>;
        })}
      </svg>
      <div className="wb-title">{scene.title}</div>
      {current?.caption && <div key={shown} className="wb-caption">{current.caption}</div>}
      <div className="wb-steps" aria-hidden="true">
        {scene.steps.map((_, i) => <i key={i} className={i < shown ? "on" : undefined} />)}
      </div>
      {onClear && <button type="button" className="wb-clear" onClick={onClear} aria-label="Wipe the whiteboard">wipe</button>}
    </div>
  );
}

function size(el: BoardElement) {
  const d = DEFAULT[el.kind];
  return { w: el.w ?? d.w, h: el.h ?? d.h };
}

function lines(text: string | null, maxChars: number): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let cur = "";
    for (const word of para.split(/\s+/)) {
      if ((cur + " " + word).trim().length > maxChars && cur) { out.push(cur); cur = word; }
      else cur = (cur + " " + word).trim();
    }
    if (cur) out.push(cur);
  }
  return out.slice(0, 5);
}

function wrapped(text: string | null, x: number, y: number, maxChars: number, fontSize: number, extra: Record<string, unknown> = {}) {
  const ls = lines(text, maxChars);
  const lh = fontSize * 1.2;
  const y0 = y - ((ls.length - 1) * lh) / 2;
  return (
    <text x={x} y={y0} textAnchor="middle" dominantBaseline="middle" fontSize={fontSize} {...extra}>
      {ls.map((l, i) => <tspan key={i} x={x} dy={i === 0 ? 0 : lh}>{l}</tspan>)}
    </text>
  );
}

function initials(name: string | null): string {
  return (name ?? "?").split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase() ?? "").join("");
}

/** Where an arrow should stop on the edge of a target element. */
function edgePoint(el: BoardElement, towardX: number, towardY: number) {
  const { w, h } = size(el);
  const dx = towardX - el.x, dy = towardY - el.y;
  if (el.kind === "person") {
    const d = Math.hypot(dx, dy) || 1;
    const r = w / 2 + 6;
    return { x: el.x + (dx / d) * r, y: el.y + (dy / d) * r };
  }
  const hw = w / 2 + 6, hh = h / 2 + 6;
  const sx = dx === 0 ? Infinity : hw / Math.abs(dx);
  const sy = dy === 0 ? Infinity : hh / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: el.x + dx * s, y: el.y + dy * s };
}

function draw(el: BoardElement, byId: Map<string, BoardElement>) {
  const { w, h } = size(el);
  switch (el.kind) {
    case "group":
      return (
        <>
          <rect x={el.x - w / 2} y={el.y - h / 2} width={w} height={h} rx={18} className="wb-shape" />
          {el.text && <text x={el.x - w / 2 + 14} y={el.y - h / 2 + 22} fontSize={15} fontWeight={600} className="wb-group-title">{el.text}</text>}
        </>
      );
    case "box":
      return (
        <>
          <rect x={el.x - w / 2} y={el.y - h / 2} width={w} height={h} rx={12} className="wb-shape" />
          {wrapped(el.text, el.x, el.y, Math.max(8, Math.floor(w / 9)), 17, { fontWeight: 600 })}
        </>
      );
    case "note":
      return (
        <>
          <rect x={el.x - w / 2} y={el.y - h / 2} width={w} height={h} rx={4} className="wb-shape" transform={`rotate(-1.5 ${el.x} ${el.y})`} />
          {wrapped(el.text, el.x, el.y, Math.max(10, Math.floor(w / 7.5)), 14)}
        </>
      );
    case "person":
      return (
        <>
          <circle cx={el.x} cy={el.y} r={w / 2} className="wb-shape" />
          <text x={el.x} y={el.y} textAnchor="middle" dominantBaseline="middle" fontSize={20} fontWeight={700} className="wb-initials">{initials(el.text)}</text>
          {wrapped(el.text, el.x, el.y + w / 2 + 16, 18, 14, { fontWeight: 600 })}
        </>
      );
    case "label":
      return wrapped(el.text, el.x, el.y, 40, 20, { fontWeight: 700, className: "wb-label-text" });
    case "check":
      return <path d={`M ${el.x - 12} ${el.y} l 8 9 l 16 -18`} className="wb-glyph wb-ok" />;
    case "cross":
      return <path d={`M ${el.x - 10} ${el.y - 10} l 20 20 M ${el.x + 10} ${el.y - 10} l -20 20`} className="wb-glyph wb-bad" />;
    case "arrow": {
      const a = el.from ? byId.get(el.from) : undefined;
      const b = el.to ? byId.get(el.to) : undefined;
      if (!a || !b) return null;
      const p = edgePoint(a, b.x, b.y), q = edgePoint(b, a.x, a.y);
      // A gentle bow so parallel arrows do not stack.
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      const nx = -(q.y - p.y), ny = q.x - p.x;
      const len = Math.hypot(nx, ny) || 1;
      const cx = mx + (nx / len) * 18, cy = my + (ny / len) * 18;
      return (
        <>
          <path d={`M ${p.x} ${p.y} Q ${cx} ${cy} ${q.x} ${q.y}`} pathLength={1} className="wb-line" markerEnd="url(#wb-head)" />
          {el.text && <text x={cx} y={cy - 6} textAnchor="middle" fontSize={13} className="wb-arrow-text">{el.text}</text>}
        </>
      );
    }
  }
}
