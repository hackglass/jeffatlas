"use client";

/**
 * /xray — every conversation with Jeff, opened up.
 *
 * Left: the list (who, when, how long, access level, what they first asked,
 * flags for the ones worth a look: nothing found, declined, suggestion, tool
 * error). Right: the whole conversation turn by turn, with every tool call
 * expanded: name, parameters, and what came back. Search filters on any
 * word said or any tool parameter.
 *
 * Data comes from /api/convos (server-side ElevenLabs key), so this page
 * works in `npm run dev` and on a Node host, not on the static Pages build.
 */

import { useEffect, useMemo, useState } from "react";
import type { Convo, ConvoSummary, ToolCall } from "@/lib/convos";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

function when(iso: string) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function dur(s: number | null) {
  if (s == null) return "";
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export default function XRay() {
  const [list, setList] = useState<ConvoSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [convo, setConvo] = useState<Convo | null>(null);
  const [q, setQ] = useState("");
  const [showSystem, setShowSystem] = useState(false);

  useEffect(() => {
    fetch(`${BASE}/api/convos`).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setList(j.conversations);
    }).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!picked) return;
    let live = true;
    fetch(`${BASE}/api/convos?id=${encodeURIComponent(picked)}`).then((r) => r.json()).then((c) => { if (live) setConvo(c); }).catch(() => { if (live) setConvo(null); });
    return () => { live = false; };
  }, [picked]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list ?? []).filter((c) => c.questions > 0 || c.toolCalls > 0).filter((c) => !needle || JSON.stringify(c).toLowerCase().includes(needle));
  }, [list, q]);

  const totals = useMemo(() => {
    const real = (list ?? []).filter((c) => c.questions > 0);
    return { convos: real.length, questions: real.reduce((n, c) => n + c.questions, 0), tools: real.reduce((n, c) => n + c.toolCalls, 0), users: new Set(real.map((c) => c.userId ?? "anonymous")).size };
  }, [list]);

  return (
    <main className="xray">
      <header className="xray-head">
        <div>
          <h1>Jeff · x-ray</h1>
          <p>{list ? `${totals.convos} conversations · ${totals.questions} questions · ${totals.tools} tool calls · ${totals.users} ${totals.users === 1 ? "user" : "users"}` : error ? "" : "loading…"}</p>
        </div>
        <div className="xray-tools">
          <input type="search" placeholder="search anything said or asked" value={q} onChange={(e) => setQ(e.target.value)} />
          <a href={`${BASE}/?view=usage`}>Usage Sankey</a>
        </div>
      </header>
      {error && (
        <div className="xray-error">
          <strong>Can’t reach the conversation record.</strong> {error}. This page needs the server: run <code>cd src && npm run dev</code> with <code>ELEVENLABS_API_KEY</code> in <code>src/.env.local</code>. The static GitHub Pages build has no backend.
        </div>
      )}
      <div className="xray-body">
        <ol className="xray-list">
          {shown.map((c) => (
            <li key={c.id} className={picked === c.id ? "on" : undefined} onClick={() => setPicked(c.id)}>
              <div className="xray-row">
                <strong>{c.userId ?? "anonymous"}</strong>
                <span>{when(c.startedAt)} · {dur(c.seconds)}</span>
              </div>
              <div className="xray-first">{c.firstQuestion ?? <em>no question</em>}</div>
              <div className="xray-meta">
                {c.access && <span className="xray-chip">{c.access}</span>}
                <span>{c.questions} q · {c.toolCalls} tools</span>
                {c.flags.map((f) => <span key={f} className={`xray-flag xray-flag-${f.replace(/\s/g, "-")}`}>{f}</span>)}
              </div>
            </li>
          ))}
          {list && !shown.length && <li className="xray-none">Nothing matches.</li>}
        </ol>
        <section className="xray-detail">
          {!picked ? (
            <div className="xray-none">Pick a conversation.</div>
          ) : !convo ? (
            <div className="xray-none">opening…</div>
          ) : (
            <>
              <div className="xray-detail-head">
                <div>
                  <strong>{convo.userId ?? "anonymous"}</strong> · {when(convo.startedAt)} · {dur(convo.seconds)} · {convo.access ?? "access unknown"}
                  <div className="xray-id">{convo.id}</div>
                </div>
                <label><input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} /> show screen notes</label>
              </div>
              <ol className="xray-turns">
                {convo.turns.map((t, i) => {
                  const tools = t.tools.filter((x) => showSystem || x.name !== "contextual_update");
                  if (!t.text && !tools.length) return null;
                  return (
                    <li key={i} className={`xray-turn xray-${t.role}`}>
                      <div className="xray-who">{t.role === "user" ? convo.userId ?? "user" : "Jeff"}<small>{t.at != null ? `${t.at}s` : ""}</small></div>
                      {t.text && <p>{t.text}</p>}
                      {tools.map((x, j) => <Tool key={j} call={x} />)}
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function Tool({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  const params = call.params && typeof call.params === "object" && Object.keys(call.params as object).length ? JSON.stringify(call.params) : "";
  let result = call.result ?? "";
  try { result = JSON.stringify(JSON.parse(result), null, 1); } catch { /* plain text */ }
  const sys = call.name === "contextual_update";
  return (
    <div className={`xray-tool${call.error ? " err" : ""}${sys ? " sys" : ""}`}>
      <button type="button" onClick={() => setOpen((o) => !o)}>
        <code>{call.name}</code>{params && <span className="xray-params">{params.length > 140 ? params.slice(0, 139) + "…" : params}</span>}
        <i>{open ? "hide" : call.result == null ? "no result" : "result"}</i>
      </button>
      {open && <pre>{result || "(no result recorded)"}</pre>}
    </div>
  );
}
