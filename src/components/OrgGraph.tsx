"use client";

/**
 * OrgGraph — the animated org picture on the right.
 *
 * Idle: the skill areas sit as hubs with the people who have them orbiting as
 * small dots, so the office reads as a constellation rather than a chart.
 * Highlighted (a tool call from Jeff): the named people and their skill /
 * repo neighbours are pulled forward, everything else fades, and a caption
 * says what is on screen. A tiny hand-rolled force layout keeps it moving
 * without pulling in d3.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Graph, GraphNode } from "@/lib/jeffData";

export type Highlight = { people: string[]; skills?: string[]; title?: string } | null;

type Sim = { id: string; type: GraphNode["type"]; label: string; x: number; y: number; vx: number; vy: number; r: number; lit: boolean; dim: boolean };

const COLORS = { person: "#2c8a5f", skill: "#1f6446", repo: "#7fd6a4" };

export default function OrgGraph({ graph, highlight }: { graph: Graph | null; highlight: Highlight }) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 480 });

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
    const keep = new Set<string>();

    if (highlight && litNames.size) {
      const litPeople = graph.nodes.filter((n) => n.type === "person" && litNames.has(n.label.toLowerCase()));
      for (const p of litPeople) keep.add(p.id);
      for (const e of graph.edges) {
        if (keep.has(e.source)) keep.add(e.target);
      }
      // Second ring: other people who share a lit skill, capped so it stays legible.
      let extra = 0;
      for (const e of graph.edges) {
        if (keep.has(e.target) && !keep.has(e.source) && byId.get(e.target)?.type === "skill" && extra < 26) {
          keep.add(e.source); extra++;
        }
      }
      for (const n of graph.nodes) if (n.type === "skill" && litSkills.has(n.label.toLowerCase())) keep.add(n.id);
    } else {
      for (const n of graph.nodes) if (n.type === "skill") keep.add(n.id);
      const people = graph.nodes.filter((n) => n.type === "person" && (n.commits ?? 0) > 0)
        .sort((a, b) => (b.commits ?? 0) - (a.commits ?? 0)).slice(0, 70);
      for (const p of people) keep.add(p.id);
    }
    const nodes = graph.nodes.filter((n) => keep.has(n.id));
    const edges = graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target) && byId.get(e.target)?.type !== "repo" || (highlight && keep.has(e.source) && keep.has(e.target) && litNames.has(byId.get(e.source)?.label.toLowerCase() ?? "")));
    return { nodes, edges };
  }, [graph, highlight]);

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
      const r = n.type === "skill" ? 16 : n.type === "repo" ? 5 : lit ? 11 : Math.min(8, 3 + Math.log10(1 + (n.commits ?? 0)) * 1.5);
      if (existing) { existing.lit = lit; existing.r = r; existing.dim = !!highlight && !lit && n.type === "person" && litNames.size > 0; continue; }
      // Skill hubs start evenly spaced on a ring; people scatter around them.
      const skillIdx = nodes.filter((m) => m.type === "skill").findIndex((m) => m.id === n.id);
      const skillCount = nodes.filter((m) => m.type === "skill").length || 1;
      const a = n.type === "skill" ? (skillIdx / skillCount) * Math.PI * 2 : Math.random() * Math.PI * 2;
      const d = n.type === "skill" ? Math.min(w, h) * 0.32 : Math.min(w, h) * (0.15 + Math.random() * 0.3);
      sims.set(n.id, { id: n.id, type: n.type, label: n.label, x: w / 2 + Math.cos(a) * d, y: h / 2 + Math.sin(a) * d, vx: 0, vy: 0, r, lit, dim: !!highlight && !lit && n.type === "person" });
    }

    let raf = 0;
    let frames = 0;
    const step = () => {
      const arr = [...sims.values()];
      const alpha = frames < 240 ? 0.9 : 0.35;
      // Centering + gentle repulsion.
      for (const a of arr) {
        a.vx += (w / 2 - a.x) * 0.0025 * alpha;
        a.vy += (h / 2 - a.y) * 0.0025 * alpha;
        for (const b of arr) {
          if (a === b) continue;
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
          const min = a.type === "skill" && b.type === "skill" ? 150 : a.r + b.r + 14;
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
        const rest = s.lit || t.lit ? 70 : t.type === "repo" ? 40 : 110;
        const f = ((d - rest) / d) * 0.012 * alpha;
        s.vx += dx * f; s.vy += dy * f;
        t.vx -= dx * f; t.vy -= dy * f;
      }
      for (const a of arr) {
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
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [nodes, edges, size, highlight]);

  const byId = useMemo(() => new Map(sims.map((s) => [s.id, s])), [sims]);

  return (
    <div className="jeff-graph">
      <svg ref={svgRef} viewBox={`0 0 ${size.w} ${size.h}`} role="img" aria-label="Org graph of Red Hat Boston">
        {edges.map((e, i) => {
          const s = byId.get(e.source), t = byId.get(e.target);
          if (!s || !t) return null;
          const lit = s.lit || t.lit;
          return <line key={i} x1={s.x} y1={s.y} x2={t.x} y2={t.y} stroke={lit ? "#2c8a5f" : "#1f6446"} strokeOpacity={lit ? 0.55 : highlight ? 0.08 : 0.16} strokeWidth={lit ? 1.6 : 1} />;
        })}
        {sims.map((n) => (
          <g key={n.id} transform={`translate(${n.x},${n.y})`} opacity={n.dim ? 0.28 : 1} style={{ transition: "opacity 300ms" }}>
            {n.lit && <circle r={n.r + 9} fill="rgba(70,178,124,0.18)"><animate attributeName="r" values={`${n.r + 6};${n.r + 12};${n.r + 6}`} dur="2.4s" repeatCount="indefinite" /></circle>}
            <circle r={n.r} fill={n.type === "skill" ? "#fff" : COLORS[n.type]} stroke={n.type === "skill" ? COLORS.skill : n.lit ? "#1f6446" : "none"} strokeWidth={n.type === "skill" ? 1.5 : 2} />
            {(n.type === "skill" || n.lit || (n.type === "person" && !highlight && n.r >= 7)) && (
              <text y={n.type === "skill" ? 4 : n.r + 13} textAnchor="middle" fontSize={n.type === "skill" ? 10.5 : n.lit ? 12 : 10} fontWeight={n.lit || n.type === "skill" ? 600 : 400} fill={n.type === "skill" ? "#1f6446" : "#14261c"} style={{ pointerEvents: "none" }}>
                {n.type === "skill" ? shortSkill(n.label) : n.label}
              </text>
            )}
          </g>
        ))}
      </svg>
      {highlight?.title && <div className="jeff-graph-caption">{highlight.title}</div>}
      <div className="jeff-graph-legend">
        <span><i style={{ background: "#fff", border: "1.5px solid #1f6446" }} />skill area</span>
        <span><i style={{ background: COLORS.person }} />person</span>
        <span><i style={{ background: COLORS.repo }} />repo</span>
      </div>
    </div>
  );
}

function shortSkill(s: string): string {
  return s.replace(/\s*\(.*\)\s*/, "").replace(" / ", "/");
}
