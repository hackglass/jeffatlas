"use client";

/**
 * UsageSankey — how people are using Jeff.
 *
 * Reads public/data/usage.json (written by ingest/fetch_transcripts.py from
 * the ElevenLabs transcripts) and draws every question as a flow:
 *
 *     who asked  →  what kind of question  →  what about  →  what happened
 *     (access)      (person / topic / …)     (topic)        (answered / nothing / declined)
 *
 * Click any node to filter the flows through it; hover for counts. Beside
 * it, the leaderboard ranks the topics people ask about most. The `Table`
 * toggle shows the same rows as text.
 */

import { useMemo, useState } from "react";

export type UsageQuery = { kind: string; topic: string; outcome: string; tool: string | null; text: string; t: number | null };
export type UsageConversation = { id: string; startedAt: string; seconds: number | null; access: string; user?: string | null; queries: UsageQuery[] };
export type Usage = { exportedAt: string; source: string; conversations: UsageConversation[] };

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export async function loadUsage(): Promise<Usage> {
  const r = await fetch(`${BASE}/data/usage.json`);
  if (!r.ok) throw new Error(`usage.json ${r.status}`);
  return r.json();
}

// Query kinds in fixed order; each keeps its hue no matter which are on screen.
// Palette validated with the dataviz checker (light surface): six categorical
// slots pass CVD + normal-vision separation; "other" is the neutral fold.
export const KINDS: { id: string; label: string; color: string }[] = [
  { id: "topic", label: "by topic", color: "#2a78d6" },
  { id: "person", label: "by person", color: "#eb6834" },
  { id: "staffing", label: "staffing move", color: "#1baf7a" },
  { id: "team", label: "team shape", color: "#eda100" },
  { id: "region", label: "by region", color: "#e87ba4" },
  { id: "suggestion", label: "suggestion", color: "#4a3aa7" },
  { id: "other", label: "other", color: "#9aa0a6" },
];
const KIND = new Map(KINDS.map((k) => [k.id, k]));
const OUTCOMES = ["answered", "nothing found", "declined", "no tool", "cut off"];
const ACCESS_ORDER = ["New hire", "Manager", "Senior leader", "Unknown"];

type Row = { access: string; kind: string; topic: string; outcome: string; text: string; when: string };

export function usageRows(u: Usage | null): Row[] {
  if (!u) return [];
  return u.conversations.flatMap((c) => c.queries.map((q) => ({ access: c.access, kind: q.kind, topic: q.topic, outcome: q.outcome, text: q.text, when: c.startedAt })));
}

/** Plain-language summary for Jeff to narrate. */
export function describeUsage(u: Usage | null, focus?: string): string {
  const rows = usageRows(u);
  if (!rows.length) return "No usage data yet.";
  const count = (key: (r: Row) => string) => {
    const m = new Map<string, number>();
    rows.forEach((r) => m.set(key(r), (m.get(key(r)) ?? 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const kinds = count((r) => KIND.get(r.kind)?.label ?? r.kind).map(([k, n]) => `${k} ${n}`).join(", ");
  const topics = count((r) => r.topic).filter(([t]) => t && !t.startsWith("(")).slice(0, 5).map(([t, n]) => `${t} (${n})`).join(", ");
  const outcomes = count((r) => r.outcome).map(([k, n]) => `${k} ${n}`).join(", ");
  const access = count((r) => r.access).map(([k, n]) => `${k} ${n}`).join(", ");
  const parts = [`${u!.conversations.length} conversations, ${rows.length} questions.`, `Kinds: ${kinds}.`, `Top topics: ${topics}.`, `Outcomes: ${outcomes}.`, `Asked by: ${access}.`];
  if (focus) parts.push(`The screen is focused on "${focus}".`);
  return parts.join(" ");
}

// ── Layout ──────────────────────────────────────────────────────────────────

const W = 1000, H = 560, PAD_TOP = 40, PAD_BOTTOM = 16, NODE_W = 16, GAP = 12, MAX_TOPICS = 7;
const COLS = [
  { key: "access", title: "1 · Who asked", x: 0 },
  { key: "kind", title: "2 · What kind of question", x: 300 },
  { key: "topic", title: "3 · About what", x: 600 },
  { key: "outcome", title: "4 · How it went", x: 986 - NODE_W },
] as const;
type ColKey = (typeof COLS)[number]["key"];

type Node = { id: string; col: number; label: string; value: number; y0: number; y1: number; color: string; kind?: string };
type Link = { source: Node; target: Node; value: number; color: string; sy: number; ty: number; rows: Row[] };

function layout(rows: Row[]) {
  // Fold rare topics so the middle column stays readable.
  const topicCount = new Map<string, number>();
  rows.forEach((r) => topicCount.set(r.topic, (topicCount.get(r.topic) ?? 0) + 1));
  const keep = new Set([...topicCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_TOPICS).map(([t]) => t));
  const topicOf = (r: Row) => (keep.has(r.topic) ? r.topic : "other topics");
  const key = (r: Row, c: ColKey) => (c === "topic" ? topicOf(r) : r[c]);

  // Dominant kind per topic, for colouring the topic node.
  const topicKind = new Map<string, Map<string, number>>();
  rows.forEach((r) => {
    const t = topicOf(r);
    const m = topicKind.get(t) ?? new Map();
    m.set(r.kind, (m.get(r.kind) ?? 0) + 1);
    topicKind.set(t, m);
  });
  const dominant = (t: string) => [...(topicKind.get(t) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";

  const nodes: Node[] = [];
  const byId = new Map<string, Node>();
  COLS.forEach((c, ci) => {
    const counts = new Map<string, number>();
    rows.forEach((r) => counts.set(key(r, c.key), (counts.get(key(r, c.key)) ?? 0) + 1));
    let ids = [...counts.keys()];
    if (c.key === "kind") ids.sort((a, b) => KINDS.findIndex((k) => k.id === a) - KINDS.findIndex((k) => k.id === b));
    else if (c.key === "outcome") ids.sort((a, b) => OUTCOMES.indexOf(a) - OUTCOMES.indexOf(b));
    else if (c.key === "access") ids.sort((a, b) => ACCESS_ORDER.indexOf(a) - ACCESS_ORDER.indexOf(b));
    else ids = ids.sort((a, b) => (a === "other topics" ? 1 : b === "other topics" ? -1 : (counts.get(b)! - counts.get(a)!) || a.localeCompare(b)));
    const total = rows.length;
    const usable = H - PAD_TOP - PAD_BOTTOM - GAP * (ids.length - 1);
    let y = PAD_TOP;
    ids.forEach((id) => {
      const v = counts.get(id)!;
      const h = (v / total) * usable;
      const kind = c.key === "kind" ? id : c.key === "topic" ? dominant(id) : undefined;
      const color = kind ? KIND.get(kind)?.color ?? "#9aa0a6" : "#4b5563";
      const label = c.key === "kind" ? KIND.get(id)?.label ?? id : id;
      const n: Node = { id: `${c.key}:${id}`, col: ci, label, value: v, y0: y, y1: y + h, color, kind };
      nodes.push(n); byId.set(n.id, n);
      y += h + GAP;
    });
  });

  const links: Link[] = [];
  for (let ci = 0; ci < COLS.length - 1; ci++) {
    const a = COLS[ci].key, b = COLS[ci + 1].key;
    const groups = new Map<string, Row[]>();
    rows.forEach((r) => { const k = `${a}:${key(r, a)}|${b}:${key(r, b)}`; groups.set(k, [...(groups.get(k) ?? []), r]); });
    const offS = new Map<string, number>(), offT = new Map<string, number>();
    // Order links by target position so ribbons do not cross more than they must.
    const ordered = [...groups.entries()].sort(([ka], [kb]) => {
      const [sa, ta] = ka.split("|"), [sb, tb] = kb.split("|");
      return (byId.get(sa)!.y0 - byId.get(sb)!.y0) || (byId.get(ta)!.y0 - byId.get(tb)!.y0);
    });
    ordered.forEach(([k, rs]) => {
      const [sid, tid] = k.split("|");
      const s = byId.get(sid)!, t = byId.get(tid)!;
      const hS = (rs.length / s.value) * (s.y1 - s.y0), hT = (rs.length / t.value) * (t.y1 - t.y0);
      const sy = s.y0 + (offS.get(sid) ?? 0), ty = t.y0 + (offT.get(tid) ?? 0);
      offS.set(sid, (offS.get(sid) ?? 0) + hS); offT.set(tid, (offT.get(tid) ?? 0) + hT);
      const kind = rs[0].kind;
      links.push({ source: s, target: t, value: rs.length, color: KIND.get(kind)?.color ?? "#9aa0a6", sy: sy + hS / 2, ty: ty + hT / 2, rows: rs });
    });
    // Second pass: ribbon thickness is the average of both ends so it never overflows a node.
    links.filter((l) => l.source.col === ci).forEach((l) => { (l as Link & { w: number }).w = ((l.value / l.source.value) * (l.source.y1 - l.source.y0) + (l.value / l.target.value) * (l.target.y1 - l.target.y0)) / 2; });
  }
  return { nodes, links: links as (Link & { w: number })[] };
}

function ribbon(l: Link, x0: number, x1: number) {
  const c = (x1 - x0) / 2;
  return `M ${x0} ${l.sy} C ${x0 + c} ${l.sy}, ${x1 - c} ${l.ty}, ${x1} ${l.ty}`;
}

// ── Component ───────────────────────────────────────────────────────────────

type Props = { usage: Usage | null; focus?: string | null; onFocus?: (nodeLabel: string | null) => void };

export default function UsageSankey({ usage, focus, onFocus }: Props) {
  const rows = useMemo(() => usageRows(usage), [usage]);
  const [picked, setPicked] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const [table, setTable] = useState(false);
  // Follow the focus Jeff asked for (adjust-state-during-render pattern).
  const [prevFocus, setPrevFocus] = useState(focus);
  if (prevFocus !== focus) { setPrevFocus(focus); setPicked(focus ?? null); }

  const { nodes, links } = useMemo(() => layout(rows), [rows]);
  const active = useMemo(() => {
    if (!picked) return null;
    const n = nodes.find((x) => x.id === picked || x.label === picked);
    if (!n) return null;
    // Every row that passes through the picked node.
    const through = new Set(links.filter((l) => l.source.id === n.id || l.target.id === n.id).flatMap((l) => l.rows));
    return { node: n, rows: through };
  }, [picked, nodes, links]);
  const lit = (l: Link) => !active || l.rows.some((r) => active.rows.has(r));

  const leaderboard = useMemo(() => {
    const m = new Map<string, { n: number; ok: number; kind: string }>();
    rows.forEach((r) => {
      if (r.topic.startsWith("(")) return;
      const e = m.get(r.topic) ?? { n: 0, ok: 0, kind: r.kind };
      e.n++; if (r.outcome === "answered") e.ok++;
      m.set(r.topic, e);
    });
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).slice(0, 10);
  }, [rows]);
  const max = leaderboard[0]?.[1].n ?? 1;

  const pick = (n: Node | null) => {
    const next = n && picked !== n.id ? n.id : null;
    setPicked(next);
    onFocus?.(next ? n!.label : null);
  };

  if (!usage) return <div className="usage"><div className="usage-empty">Loading usage…</div></div>;
  if (!rows.length) return <div className="usage"><div className="usage-empty">No conversations yet. Run <code>python3 ingest/fetch_transcripts.py</code> after people have talked to Jeff.</div></div>;

  return (
    <div className="usage">
      <div className="usage-head">
        <div>
          <strong>{usage.conversations.length} conversations · {rows.length} questions</strong>
          <span> · from ElevenLabs transcripts, exported {usage.exportedAt.replace("T", " ")}</span>
          <p className="usage-howto">Every question is one ribbon, read left to right: who asked it, what kind of question it was, what it was about, and whether Jeff could answer. Thicker means more questions. Click any bar to follow only the questions through it.</p>
        </div>
        <div className="usage-tools">
          {active && <button type="button" onClick={() => pick(null)}>clear filter</button>}
          <button type="button" aria-pressed={table} onClick={() => setTable((t) => !t)}>{table ? "Chart" : "Table"}</button>
        </div>
      </div>
      {table ? (
        <div className="usage-table">
          <table>
            <thead><tr><th>When</th><th>Who</th><th>Kind</th><th>About</th><th>Outcome</th><th>Said</th></tr></thead>
            <tbody>
              {rows.filter((r) => !active || active.rows.has(r)).map((r, i) => (
                <tr key={i}><td>{r.when.slice(5, 16).replace("T", " ")}</td><td>{r.access}</td><td><i style={{ background: KIND.get(r.kind)?.color }} />{KIND.get(r.kind)?.label ?? r.kind}</td><td>{r.topic}</td><td>{r.outcome}</td><td>{r.text}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="usage-body">
          <div className="usage-chart" onMouseLeave={() => setHover(null)}>
            <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Sankey of questions asked to Jeff: who asked, kind, topic, outcome">
              {COLS.map((c) => <text key={c.key} x={c.key === "outcome" ? c.x + NODE_W : c.x} y={20} fontSize={14} fontWeight={600} textAnchor={c.key === "outcome" ? "end" : "start"} className="usage-col">{c.title}</text>)}
              {links.map((l, i) => {
                const x0 = COLS[l.source.col].x + NODE_W, x1 = COLS[l.target.col].x;
                return (
                  <path key={i} d={ribbon(l, x0, x1)} fill="none" stroke={l.color} strokeWidth={Math.max(1.5, l.w)}
                    className={`usage-link${lit(l) ? "" : " dim"}`}
                    onMouseMove={(e) => setHover({ x: e.clientX, y: e.clientY, text: `${l.source.label} → ${l.target.label}: ${l.value}` })}
                    onMouseLeave={() => setHover(null)}
                  />
                );
              })}
              {nodes.map((n) => {
                const x = COLS[n.col].x;
                const dim = active && !links.some((l) => (l.source.id === n.id || l.target.id === n.id) && lit(l));
                const right = n.col === COLS.length - 1;
                const tx = right ? x - 6 : x + NODE_W + 6;
                return (
                  <g key={n.id} className={`usage-node${dim ? " dim" : ""}${active?.node.id === n.id ? " on" : ""}`} onClick={() => pick(n)}
                    onMouseMove={(e) => setHover({ x: e.clientX, y: e.clientY, text: `${n.label}: ${n.value} ${n.value === 1 ? "question" : "questions"}` })}
                    onMouseLeave={() => setHover(null)}>
                    <rect x={x - 6} y={n.y0 - 4} width={NODE_W + 12} height={n.y1 - n.y0 + 8} fill="transparent" />
                    <rect x={x} y={n.y0} width={NODE_W} height={Math.max(2, n.y1 - n.y0)} rx={3} fill={n.color} />
                    <text x={tx} y={(n.y0 + n.y1) / 2} dominantBaseline="middle" textAnchor={right ? "end" : "start"} fontSize={13.5}>
                      {n.label.length > 28 ? n.label.slice(0, 27) + "…" : n.label} <tspan className="usage-n">{n.value === 1 ? "1 question" : `${n.value} questions`}</tspan>
                    </text>
                  </g>
                );
              })}
            </svg>
            {hover && <div className="usage-tip" style={{ left: hover.x + 12, top: hover.y + 12 }}>{hover.text}</div>}
          </div>
          <aside className="usage-board">
            <h3>Most asked about</h3>
            <p className="usage-board-sub">Topics ranked by how many times they came up, and how many Jeff could answer.</p>
            <ol>
              {leaderboard.map(([t, e]) => (
                <li key={t} className={active && active.node.label === t ? "on" : undefined} onClick={() => { const n = nodes.find((x) => x.label === t) ?? null; pick(n); }}>
                  <span className="usage-board-label" title={t}>{t}</span>
                  <span className="usage-board-bar"><i style={{ width: `${(e.n / max) * 100}%`, background: KIND.get(e.kind)?.color }} /></span>
                  <span className="usage-board-n">{e.n}<small>{e.ok === e.n ? "" : ` · ${e.ok} answered`}</small></span>
                </li>
              ))}
            </ol>
            <p className="usage-legend">
              {KINDS.filter((k) => rows.some((r) => r.kind === k.id)).map((k) => <span key={k.id}><i style={{ background: k.color }} />{k.label}</span>)}
            </p>
          </aside>
        </div>
      )}
    </div>
  );
}
