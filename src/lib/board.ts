/**
 * The whiteboard scene format: what Jeff's drawing brain produces and what
 * the Whiteboard component animates. Shared by the API route and the page.
 *
 * The board is a 1000 x 600 virtual canvas. Shapes are positioned by their
 * centre; arrows connect two element ids. Steps play in order, each one
 * adding elements and optionally highlighting some, so an explanation
 * unfolds while Jeff narrates it.
 */

import { z } from "zod";

export const BOARD_W = 1000;
export const BOARD_H = 600;

export const ElementSchema = z.object({
  id: z.string().describe("Short unique id, e.g. 'e1'. Arrows reference these."),
  kind: z.enum(["box", "note", "person", "group", "label", "arrow", "check", "cross"]),
  text: z.string().nullable().describe("The words on the element. Keep to a few words; boxes wrap at ~4 short lines."),
  x: z.number().describe("Centre x on a 1000-wide board. For arrows, ignored."),
  y: z.number().describe("Centre y on a 600-tall board. For arrows, ignored."),
  w: z.number().nullable().describe("Width for box / note / group. Null for defaults."),
  h: z.number().nullable().describe("Height for box / note / group. Null for defaults."),
  from: z.string().nullable().describe("Arrow start element id."),
  to: z.string().nullable().describe("Arrow end element id."),
  emphasis: z.enum(["normal", "strong", "muted"]).nullable(),
});

export const StepSchema = z.object({
  caption: z.string().nullable().describe("One short line Jeff would say while this step appears."),
  add: z.array(ElementSchema).describe("Elements that appear in this step."),
  highlight: z.array(z.string()).nullable().describe("Element ids to spotlight during this step; others soften."),
});

export const SceneSchema = z.object({
  title: z.string().describe("Board title, a few words."),
  steps: z.array(StepSchema).min(1).max(8),
});

export type BoardElement = z.infer<typeof ElementSchema>;
export type BoardStep = z.infer<typeof StepSchema>;
export type Scene = z.infer<typeof SceneSchema>;

/** Text shown to Jeff so he can narrate what the board is doing. */
export function describeScene(scene: Scene): string {
  const steps = scene.steps.map((s, i) => {
    const what = s.add.filter((e) => e.kind !== "arrow" && e.text).map((e) => e.text).slice(0, 5).join(", ");
    return `${i + 1}) ${s.caption ?? what}`;
  });
  return `Whiteboard "${scene.title}" is drawing in ${scene.steps.length} steps: ${steps.join("; ")}.`;
}

// ── A deterministic scene from a plain list: Jeff's fast path with no second brain ──

export type QuickBoard = {
  title: string;
  items: { label: string; kind?: "box" | "note" | "person" | "label" | "check" | "cross" | null; detail?: string | null }[];
  connections?: [string, string][] | null;
};

/** Lay `items` out left-to-right in rows of four, one step each, then draw connections. */
export function quickScene(q: QuickBoard): Scene {
  const items = q.items.slice(0, 12);
  const cols = Math.min(4, Math.max(1, items.length));
  const rows = Math.ceil(items.length / cols);
  const cellW = BOARD_W / (cols + 0.4);
  const cellH = Math.min(200, (BOARD_H - 80) / rows);
  const ids = new Map<string, string>();
  const steps: BoardStep[] = items.map((it, i) => {
    const id = `q${i + 1}`;
    ids.set(it.label.toLowerCase(), id);
    const col = i % cols, row = Math.floor(i / cols);
    const x = cellW * (col + 0.7), y = 70 + cellH * (row + 0.5);
    const kind = it.kind ?? "box";
    const text = it.detail ? `${it.label}\n${it.detail}` : it.label;
    return { caption: it.label, add: [{ id, kind, text, x, y, w: null, h: null, from: null, to: null, emphasis: null }], highlight: [id] };
  });
  const arrows: BoardElement[] = [];
  for (const [a, b] of q.connections ?? []) {
    const from = ids.get(String(a).toLowerCase()), to = ids.get(String(b).toLowerCase());
    if (from && to) arrows.push({ id: `a${arrows.length + 1}`, kind: "arrow", text: null, x: 0, y: 0, w: null, h: null, from, to, emphasis: null });
  }
  if (arrows.length) steps.push({ caption: "How they connect", add: arrows, highlight: null });
  return { title: q.title, steps };
}
