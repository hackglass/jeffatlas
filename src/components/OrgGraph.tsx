"use client";

/**
 * OrgGraph — the shared canvas on the right.
 *
 * Two hands on the same picture:
 *  - Jeff drives it through `highlight` (show_on_graph, find_experts, …):
 *    the named people and their skill / repo neighbours are pulled forward,
 *    everything else fades, and a caption says what is on screen.
 *  - The human drives it directly: hover for a card, click a person or a
 *    skill hub to focus on it (the parent tells Jeff), drag nodes to pin
 *    them, drag the background to pan, wheel to zoom, double-click the
 *    background to reset.
 *
 * A tiny hand-rolled force layout keeps it moving without pulling in d3.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Graph, GraphNode, Person } from "@/lib/jeffData";

export type Highlight = { people: string[]; skills?: string[]; title?: string } | null;
export type Pick = { type: "person" | "skill"; label: string; id: string };
/** People: everyone in Boston, grouped by section. Skills: the technical view from GitHub (skill areas + repos). */
export type Lens = "people" | "skills";

const SECTION_SHORT: Record<string, string> = {
  "Platform / infrastructure engineering, QA, SRE": "Platform & infra",
  "Product, UX, docs, marketing, sales, GTM, ops": "Product & GTM",
  "AI / ML research, engineering, data science": "AI / ML",
  "Leadership": "Leadership",
  "": "Community & alumni",
};
export const sectionShort = (s: string | undefined) => SECTION_SHORT[s ?? ""] ?? s ?? "Community & alumni";

type Sim = {
  id: string; type: GraphNode["type"]; label: string;
  x: number; y: number; vx: number; vy: number; r: number;
  lit: boolean; dim: boolean;
  fx?: number; fy?: number; // pinned position (while dragging, and after a drop)
  ax?: number; ay?: number; // hub anchor on the ring; hubs are pulled toward it, people orbit them
};
type View = { x: number; y: number; k: number };

// Quiet by default: grey dots and hairlines. Green is reserved for what Jeff
// or the human is pointing at, so a highlight actually reads as one.
const COLORS = { person: "#9aa4ae", skill: "#3b4552", repo: "#c7ccd1", lit: "#2fb36a", ink: "#111827", line: "#cfd4d9" };
const CLICK_SLOP = 4; // px of movement before a press becomes a drag

export default function OrgGraph({ graph, people, highlight, lens = "people", selected, onPick, onAsk, onClear }: {
  graph: Graph | null;
  /** For the person card's GitHub / LinkedIn links; the graph itself only carries name + section. */
  people?: Person[] | null;
  highlight: Highlight;
  lens?: Lens;
  /** The node the human last clicked (kept by the parent so Jeff can be told). */
  selected?: Pick | null;
  onPick?: (pick: Pick | null) => void;
  /** "Ask Jeff" from the selection card. */
  onAsk?: (pick: Pick) => void;
  /** The × on the caption: drop the highlight. */
  onClear?: () => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 480 });
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const viewRef = useRef<View>(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);

  useEffect(() => {
    const el = svgRef.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Which nodes are on screen: a focused subgraph when highlighted, otherwise
  // skills + a sample of the busiest people.
  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as GraphNode[], edges: [] as Graph["edges"] };
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const litNames = new Set((highlight?.people ?? []).map((n) => n.toLowerCase()));
    const litSkills = new Set((highlight?.skills ?? []).map((n) => n.toLowerCase()));

    if (lens === "people") {
      // Everyone, hung off a hub per section. Highlights only light and dim;
      // nobody leaves the picture, because the point of this lens is the whole office.
      const people = graph.nodes.filter((n) => n.type === "person");
      const sections = [...new Set(people.map((p) => p.section ?? ""))].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
      const hubs: GraphNode[] = sections.map((sec) => ({ id: `section:${sec || "other"}`, type: "skill", label: sectionShort(sec), section: sec }));
      const edges: Graph["edges"] = people.map((p) => ({ source: p.id, target: `section:${p.section || "other"}`, weight: 1 }));
      return { nodes: [...hubs, ...people], edges };
    }

    const keep = new Set<string>();
    if (highlight && (litNames.size || litSkills.size)) {
      const litPeople = graph.nodes.filter((n) => n.type === "person" && litNames.has(n.label.toLowerCase()));
      for (const p of litPeople) keep.add(p.id);
      for (const e of graph.edges) {
        if (keep.has(e.source)) keep.add(e.target);
      }
      const litSkillIds = new Set(graph.nodes.filter((n) => n.type === "skill" && litSkills.has(n.label.toLowerCase())).map((n) => n.id));
      for (const id of litSkillIds) keep.add(id);
      // The hubs stay as the map's landmarks even when only one person is lit.
      for (const n of graph.nodes) if (n.type === "skill") keep.add(n.id);
      // Second ring: other people who share a lit skill, capped so it stays legible.
      // A skill-only focus (someone clicked a hub) gets a bigger ring: that *is* the picture.
      const cap = litNames.size ? 26 : 60;
      let extra = 0;
      const ring = graph.edges
        .filter((e) => keep.has(e.target) && !keep.has(e.source) && byId.get(e.target)?.type === "skill" && (litNames.size || litSkillIds.has(e.target)))
        .sort((a, b) => b.weight - a.weight);
      for (const e of ring) {
        if (extra >= cap) break;
        if (!keep.has(e.source)) { keep.add(e.source); extra++; }
      }
    } else {
      for (const n of graph.nodes) if (n.type === "skill") keep.add(n.id);
      const people = graph.nodes.filter((n) => n.type === "person" && (n.commits ?? 0) > 0)
        .sort((a, b) => (b.commits ?? 0) - (a.commits ?? 0)).slice(0, 70);
      for (const p of people) keep.add(p.id);
    }
    const nodes = graph.nodes.filter((n) => keep.has(n.id));
    const edges = graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target) && byId.get(e.target)?.type !== "repo" || (highlight && keep.has(e.source) && keep.has(e.target) && litNames.has(byId.get(e.source)?.label.toLowerCase() ?? "")));
    return { nodes, edges };
  }, [graph, highlight, lens]);

  const simRef = useRef<Map<string, Sim>>(new Map());
  // A per-frame snapshot of positions: render reads state, never the ref.
  const [sims, setSims] = useState<Sim[]>([]);

  useEffect(() => {
    const { w, h } = size;
    const sims = simRef.current;
    const litNames = new Set((highlight?.people ?? []).map((n) => n.toLowerCase()));
    const litSkills = new Set((highlight?.skills ?? []).map((n) => n.toLowerCase()));
    const present = new Set(nodes.map((n) => n.id));
    for (const id of [...sims.keys()]) if (!present.has(id)) sims.delete(id);
    for (const n of nodes) {
      const lit = n.type === "person" ? litNames.has(n.label.toLowerCase()) : n.type === "skill" ? litSkills.has(n.label.toLowerCase()) : false;
      const existing = sims.get(n.id);
      const r = n.type === "skill" ? (lens === "people" ? 22 : 16) : n.type === "repo" ? 5 : lit ? 11 : lens === "people" ? Math.min(6.5, 3 + Math.log10(1 + (n.commits ?? 0)) * 1.1) : Math.min(8, 3 + Math.log10(1 + (n.commits ?? 0)) * 1.5);
      const dim = !!highlight && !lit && n.type === "person" && litNames.size > 0;
      // Hubs live on a ring that fills the canvas (an ellipse, so a wide
      // canvas is used side to side). People start near their hub.
      const hubs = nodes.filter((m) => m.type === "skill");
      const hubIdx = hubs.findIndex((m) => m.id === n.id);
      const hubCount = hubs.length || 1;
      const rx = w * 0.36, ry = h * 0.30;
      const start = -Math.PI / 2 - (hubCount > 2 ? Math.PI / hubCount : 0);
      const ringAngle = start + (hubIdx / hubCount) * Math.PI * 2;
      const ax = w / 2 + Math.cos(ringAngle) * rx, ay = h / 2 + Math.sin(ringAngle) * ry;
      if (existing) {
        existing.lit = lit; existing.r = r; existing.dim = dim;
        if (n.type === "skill") { existing.ax = ax; existing.ay = ay; }
        continue;
      }
      let x: number, y: number;
      if (n.type === "skill") { x = ax; y = ay; }
      else {
        const home = edges.find((e) => e.source === n.id && sims.get(e.target)?.type === "skill");
        const hub = home ? sims.get(home.target) : undefined;
        const a = Math.random() * Math.PI * 2, d = 30 + Math.random() * Math.min(w, h) * 0.18;
        x = (hub ? hub.x : w / 2) + Math.cos(a) * d;
        y = (hub ? hub.y : h / 2) + Math.sin(a) * d;
      }
      sims.set(n.id, { id: n.id, type: n.type, label: n.label, x, y, vx: 0, vy: 0, r, lit, dim, ax: n.type === "skill" ? ax : undefined, ay: n.type === "skill" ? ay : undefined });
    }

    const hubGap = lens === "people" ? Math.min(w, h) * 0.45 : 150;
    let raf = 0;
    let frames = 0;
    const step = () => {
      const arr = [...sims.values()];
      const alpha = frames < 240 ? 0.9 : 0.35;
      // Hubs are pulled to their ring anchor; everything else drifts gently
      // toward the middle so stray dots do not pile up in the corners.
      for (const a of arr) {
        if (a.ax !== undefined && a.ay !== undefined) {
          a.vx += (a.ax - a.x) * 0.06 * alpha;
          a.vy += (a.ay - a.y) * 0.06 * alpha;
        } else {
          a.vx += (w / 2 - a.x) * 0.0008 * alpha;
          a.vy += (h / 2 - a.y) * 0.0008 * alpha;
        }
        for (const b of arr) {
          if (a === b) continue;
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
          const min = a.type === "skill" && b.type === "skill" ? hubGap : a.r + b.r + (lens === "people" ? 8 : 14);
          if (d2 < min * min * 4) {
            const d = Math.sqrt(d2);
            const f = ((min * 2 - d) / d) * 0.05 * alpha;
            a.vx += dx * f; a.vy += dy * f;
          }
        }
      }
      // Springs along edges.
      for (const e of edges) {
        const s = sims.get(e.source), t = sims.get(e.target);
        if (!s || !t) continue;
        const dx = t.x - s.x, dy = t.y - s.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const base = Math.min(w, h);
        const rest = s.lit || t.lit ? base * 0.14 : t.type === "repo" ? 40 : lens === "people" ? base * 0.2 : base * 0.22;
        const f = ((d - rest) / d) * (lens === "people" ? 0.02 : 0.012) * alpha;
        s.vx += dx * f; s.vy += dy * f;
        t.vx -= dx * f; t.vy -= dy * f;
      }
      for (const a of arr) {
        if (a.fx !== undefined && a.fy !== undefined) { a.x = a.fx; a.y = a.fy; a.vx = 0; a.vy = 0; continue; }
        a.vx *= 0.82; a.vy *= 0.82;
        const pad = a.type === "skill" ? 52 : a.r + 6; // room for hub labels
        a.x = Math.max(pad, Math.min(w - pad, a.x + a.vx));
        a.y = Math.max(a.r + 6, Math.min(h - a.r - 6, a.y + a.vy));
      }
      frames++;
      return arr;
    };
    // Warm up synchronously so the first paint is already a laid-out graph,
    // then keep it breathing on animation frames.
    let arr = step();
    for (let i = 0; i < 160; i++) arr = step();
    setSims(arr.map((a) => ({ ...a })));
    const tick = () => {
      setSims(step().map((a) => ({ ...a })));
      // Belt and braces: the panel animates open, and a ResizeObserver
      // notification can land mid-transition. Re-measure every frame so the
      // viewBox and the layout always match the box we are actually in.
      const el = svgRef.current?.parentElement;
      if (el && (Math.abs(el.clientWidth - w) > 1 || Math.abs(el.clientHeight - h) > 1)) {
        setSize({ w: el.clientWidth, h: el.clientHeight });
        return; // the effect re-runs with the new size and restarts the loop
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [nodes, edges, size, highlight, lens]);

  const byId = useMemo(() => new Map(sims.map((s) => [s.id, s])), [sims]);

  // ── Pointer handling: click / drag a node, pan the background, wheel zoom ──
  // Pointer → graph coordinates. The viewBox matches the element size 1:1,
  // so screen px are svg units; undo the pan/zoom transform on top.
  const toGraph = useCallback((e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    const sx = e.clientX - (rect?.left ?? 0), sy = e.clientY - (rect?.top ?? 0);
    return { sx, sy, x: (sx - v.x) / v.k, y: (sy - v.y) / v.k };
  }, []);

  const gesture = useRef<
    | { kind: "node"; id: string; startX: number; startY: number; moved: boolean; pointerId: number }
    | { kind: "pan"; startX: number; startY: number; viewX: number; viewY: number; moved: boolean; pointerId: number }
    | null
  >(null);

  const onNodeDown = (id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = toGraph(e);
    const s = simRef.current.get(id);
    if (!s) return;
    s.fx = s.x; s.fy = s.y; // hold it still while the finger is on it
    gesture.current = { kind: "node", id, startX: p.sx, startY: p.sy, moved: false, pointerId: e.pointerId };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = toGraph(e);
    const v = viewRef.current;
    gesture.current = { kind: "pan", startX: p.sx, startY: p.sy, viewX: v.x, viewY: v.y, moved: false, pointerId: e.pointerId };
    setPanning(true);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    if (!g) return;
    const p = toGraph(e);
    const dist = Math.hypot(p.sx - g.startX, p.sy - g.startY);
    if (dist > CLICK_SLOP) g.moved = true;
    if (!g.moved) return;
    if (g.kind === "node") {
      const s = simRef.current.get(g.id);
      if (s) { s.fx = p.x; s.fy = p.y; }
    } else {
      setView({ ...viewRef.current, x: g.viewX + (p.sx - g.startX), y: g.viewY + (p.sy - g.startY) });
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    setPanning(false);
    if (!g) return;
    (e.currentTarget as Element).releasePointerCapture?.(g.pointerId);
    if (g.kind === "node") {
      const s = simRef.current.get(g.id);
      if (!s) return;
      if (!g.moved) {
        // A tap: let it float again, and treat it as a pick.
        s.fx = undefined; s.fy = undefined;
        if (s.type === "repo") return;
        const already = selected?.id === s.id;
        onPick?.(already ? null : { type: s.type, label: s.label, id: s.id });
      }
      // A drop leaves it pinned where it landed (double-click unpins).
    } else if (!g.moved) {
      onPick?.(null);
      setHovered(null);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const p = toGraph(e);
    const v = viewRef.current;
    const k = Math.max(0.5, Math.min(3, v.k * Math.exp(-e.deltaY * 0.0015)));
    // Zoom about the cursor: keep the graph point under it fixed.
    setView({ k, x: p.sx - p.x * k, y: p.sy - p.y * k });
  };

  const unpin = (id: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    const s = simRef.current.get(id);
    if (s) { s.fx = undefined; s.fy = undefined; }
  };

  // Wheel must be a non-passive listener to stop the page scrolling.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const block = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", block, { passive: false });
    return () => el.removeEventListener("wheel", block);
  }, []);

  // ── Hover / selection card ──
  const card = useMemo(() => {
    // A selection pins the card: on the way from the node to its "Ask Jeff"
    // button the cursor crosses other nodes, and a hover-following card would
    // jump away (and lose its buttons) under the click.
    const id = selected?.id ?? hovered ?? null;
    if (!id || !graph) return null;
    const s = byId.get(id);
    const n = graph.nodes.find((m) => m.id === id) ?? nodes.find((m) => m.id === id);
    if (!s || !n || n.type === "repo") return null;
    const skillById = new Map(graph.nodes.filter((m) => m.type === "skill").map((m) => [m.id, m.label]));
    const personIds = new Set(graph.nodes.filter((m) => m.type === "person").map((m) => m.id));
    let lines: string[] = [];
    let github: string | undefined, linkedin: string | undefined;
    if (n.type === "person") {
      const skills = graph.edges.filter((e) => e.source === id && skillById.has(e.target)).sort((a, b) => b.weight - a.weight).map((e) => shortSkill(skillById.get(e.target)!)).slice(0, 4);
      lines = [
        [n.role, n.section].filter(Boolean).join(" · "),
        n.commits ? `${n.commits.toLocaleString()} commits` : "",
        skills.length ? skills.join(", ") : "",
      ].filter(Boolean);
      const p = people?.find((m) => m.name === n.label);
      github = p?.url || undefined;
      linkedin = p?.linkedin || undefined;
    } else if (id.startsWith("section:")) {
      const sec = graph.nodes.filter((m) => m.type === "person" && (m.section || "") === (n.section ?? ""));
      lines = [`${sec.length} people`];
    } else {
      const count = graph.edges.filter((e) => e.target === id && personIds.has(e.source)).length;
      lines = [`${count} ${count === 1 ? "person" : "people"} in this area`];
    }
    // Screen position of the node.
    const sx = s.x * view.k + view.x, sy = s.y * view.k + view.y;
    const flip = sx > size.w * 0.62;
    return { id, type: n.type, label: n.label, lines, github, linkedin, sx, sy, flip, pinned: s.fx !== undefined, isSelected: selected?.id === id };
  }, [hovered, selected, graph, nodes, byId, view, size.w, people]);

  // Reset puts everything back: pan/zoom, pinned nodes, hover, and the highlight.
  const resetAll = useCallback(() => {
    setView({ x: 0, y: 0, k: 1 });
    for (const s of simRef.current.values()) { s.fx = undefined; s.fy = undefined; }
    setHovered(null);
    onClear?.();
  }, [onClear]);
  const zoomed = view.k !== 1 || view.x !== 0 || view.y !== 0;
  const pinnedCount = sims.filter((s) => s.fx !== undefined).length;
  const dirty = zoomed || pinnedCount > 0 || !!highlight || !!selected;

  return (
    <div className={`jeff-graph${panning ? " jeff-graph--panning" : ""}`}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${size.w} ${size.h}`}
        role="img"
        aria-label="Org graph of Red Hat Boston"
        onPointerDown={onBackgroundDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onWheel={onWheel}
        onDoubleClick={resetAll}
        style={{ touchAction: "none" }}
      >
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {edges.map((e, i) => {
            const s = byId.get(e.source), t = byId.get(e.target);
            if (!s || !t) return null;
            const lit = s.lit || t.lit;
            const near = hovered !== null && (s.id === hovered || t.id === hovered) || (selected && (s.id === selected.id || t.id === selected.id));
            return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke={near ? COLORS.ink : lit ? COLORS.lit : COLORS.line} strokeOpacity={near ? 0.6 : lit ? 0.8 : highlight ? 0.25 : lens === "people" ? 0.45 : 0.6} strokeWidth={near ? 1.4 : lit ? 1.6 : 1} />;
          })}
          {sims.map((n) => {
            const isSel = selected?.id === n.id;
            const isHover = hovered === n.id;
            return (
              <g
                key={n.id}
                className={`jeff-node jeff-node--${n.type}`}
                transform={`translate(${n.x},${n.y})`}
                opacity={n.dim && !isSel && !isHover ? 0.28 : 1}
                style={{ transition: "opacity 300ms" }}
                onPointerDown={onNodeDown(n.id)}
                onPointerEnter={() => setHovered(n.id)}
                onPointerLeave={() => setHovered((h) => (h === n.id ? null : h))}
                onDoubleClick={unpin(n.id)}
              >
                {n.lit && <circle r={n.r + 9} fill="rgba(47,179,106,0.2)"><animate attributeName="r" values={`${n.r + 6};${n.r + 12};${n.r + 6}`} dur="2.4s" repeatCount="indefinite" /></circle>}
                {isSel && <circle r={n.r + 6} fill="none" stroke={COLORS.ink} strokeWidth={1.5} strokeDasharray="3 3" />}
                {/* An invisible, larger hit target so small dots are easy to grab. */}
                <circle r={Math.max(n.r, 10)} fill="transparent" />
                <circle
                  r={n.r}
                  fill={n.type === "skill" ? (n.lit ? "#eaf7ef" : "#fff") : n.lit ? COLORS.lit : isSel || isHover ? COLORS.ink : COLORS[n.type]}
                  stroke={n.type === "skill" ? (n.lit || isSel || isHover ? COLORS.lit : COLORS.line) : n.lit ? COLORS.ink : "none"}
                  strokeWidth={n.type === "skill" ? (n.lit || isSel || isHover ? 2 : 1.25) : 1.5}
                />
                {n.fx !== undefined && n.type !== "skill" && <circle r={2} cy={-n.r - 4} fill={COLORS.ink} />}
                {(n.type === "skill" || n.lit || isSel || isHover || (lens === "skills" && n.type === "person" && !highlight && n.r >= 7)) && (
                  <text y={n.type === "skill" ? 4 : n.r + 13} textAnchor="middle" fontSize={n.type === "skill" ? 10.5 : n.lit || isSel ? 12 : 10} fontWeight={n.lit || isSel || n.type === "skill" ? 600 : 400} fill={n.type === "skill" ? (n.lit ? COLORS.lit : COLORS.skill) : COLORS.ink} paintOrder="stroke" stroke="#fff" strokeWidth={3} strokeLinejoin="round" style={{ pointerEvents: "none" }}>
                    {n.type === "skill" ? shortSkill(n.label) : n.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {card && (
        <div
          className={`jeff-graph-card${card.isSelected ? " jeff-graph-card--selected" : ""}`}
          style={{ left: card.flip ? undefined : card.sx + 18, right: card.flip ? size.w - card.sx + 18 : undefined, top: Math.max(8, Math.min(size.h - 120, card.sy - 16)) }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="jeff-graph-card-kind">{card.type === "skill" ? (card.id.startsWith("section:") ? "section" : "skill area") : "person"}{card.pinned ? " · pinned" : ""}</div>
          <strong>{card.type === "skill" ? shortSkill(card.label) : card.label}</strong>
          {card.lines.map((l) => <div key={l} className="jeff-graph-card-line">{l}</div>)}
          {card.isSelected && (card.github || card.linkedin) && (
            <div className="jeff-graph-card-links">
              {card.github && <a href={card.github} target="_blank" rel="noreferrer" title="GitHub" aria-label="GitHub"><GithubIcon /></a>}
              {card.linkedin && <a href={card.linkedin} target="_blank" rel="noreferrer" title="LinkedIn" aria-label="LinkedIn"><LinkedinIcon /></a>}
            </div>
          )}
          {card.isSelected && onAsk && (
            <div className="jeff-graph-card-actions">
              <button type="button" onClick={() => onAsk({ type: card.type as Pick["type"], label: card.label, id: card.id })}>Ask Jeff</button>
              <button type="button" className="ghost" onClick={() => onPick?.(null)}>Clear</button>
            </div>
          )}
        </div>
      )}

      {highlight?.title && (
        <div className="jeff-graph-caption">
          {highlight.title}
          {onClear && <button type="button" aria-label="Clear highlight" title="Clear" onClick={onClear}>×</button>}
        </div>
      )}
      {dirty && (
        <button type="button" className="jeff-graph-reset" onClick={resetAll} title="Reset the view, unpin nodes and clear the highlight">reset</button>
      )}
      <div className="jeff-graph-legend">
        <span><i style={{ background: "#fff", border: `1.5px solid ${COLORS.line}` }} />{lens === "people" ? "section" : "skill area"}</span>
        <span><i style={{ background: COLORS.person }} />person</span>
        {lens === "skills" && <span><i style={{ background: COLORS.repo }} />repo</span>}
        <span><i style={{ background: COLORS.lit }} />in focus</span>
        <span className="jeff-graph-hint">click to focus · drag to pin · wheel to zoom</span>
      </div>
    </div>
  );
}

function GithubIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.5 7.5 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function LinkedinIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M3.58 5.34H.62V15.4h2.96V5.34ZM2.1 0C1.05 0 .3.75.3 1.72c0 .95.73 1.72 1.76 1.72h.02c1.07 0 1.76-.77 1.76-1.72C3.82.75 3.15 0 2.1 0ZM15.7 9.63c0-3.02-1.62-4.43-3.77-4.43-1.74 0-2.51.96-2.94 1.63V5.34H6.03c.04.83 0 10.06 0 10.06h2.96v-5.62c0-.3.02-.6.11-.82.24-.6.79-1.23 1.71-1.23 1.21 0 1.7.92 1.7 2.27v5.4h2.96l.23-5.77Z" />
    </svg>
  );
}

function shortSkill(s: string): string {
  return s.replace(/\s*\(.*\)\s*/, "").replace(" / ", "/");
}
