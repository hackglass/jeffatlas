"use client";

/**
 * Jeff — one page. Left: the blob you talk to and the running transcript.
 * Right: the org graph and the evidence cards Jeff's tool calls produce.
 *
 * The whole conversation (mic, speech-to-text, the model, the voice) runs
 * through an ElevenLabs Agent over WebRTC. This page only supplies the
 * *client tools* the agent calls to look things up, and draws the results.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConversationProvider, useConversation } from "@elevenlabs/react";
import JeffBlob, { type BlobMood } from "@/components/JeffBlob";
import OrgGraph, { type Highlight } from "@/components/OrgGraph";
import Whiteboard from "@/components/Whiteboard";
import { describeScene, quickScene, SceneSchema, type QuickBoard, type Scene } from "@/lib/board";
import { ExpertCards, ImpactCards } from "@/components/PeopleCards";
import {
  findPerson, impactOfMoving, loadGraph, loadPeople, personSummary, rankExperts, sectionOverview,
  type Graph, type ImpactReport, type Person, type ScoredPerson,
} from "@/lib/jeffData";

const AGENT_ID = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID ?? "";
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type Line = { role: "user" | "jeff" | "tool" };

// A sample sketch for ?board=demo: the shape of a staffing move.
const DEMO_SCENE: Scene = {
  title: "If Priya moves",
  steps: [
    { caption: "Here's the cluster team today.", highlight: ["g1"], add: [
      { id: "g1", kind: "group", text: "Cluster provisioning", x: 300, y: 300, w: 440, h: 300, from: null, to: null, emphasis: null },
      { id: "p1", kind: "person", text: "Priya Shah", x: 200, y: 260, w: null, h: null, from: null, to: null, emphasis: null },
      { id: "p2", kind: "person", text: "Bill Burke", x: 400, y: 260, w: null, h: null, from: null, to: null, emphasis: null },
      { id: "n1", kind: "note", text: "~1,400 commits between them", x: 300, y: 390, w: null, h: null, from: null, to: null, emphasis: "muted" },
    ] },
    { caption: "Priya heads to the new project.", highlight: ["p1", "b1", "a1"], add: [
      { id: "b1", kind: "box", text: "New AI project", x: 800, y: 160, w: null, h: null, from: null, to: null, emphasis: "strong" },
      { id: "a1", kind: "arrow", text: "moves", x: 0, y: 0, w: null, h: null, from: "p1", to: "b1", emphasis: null },
    ] },
    { caption: "That leaves Bill alone on provisioning. Single point of failure.", highlight: ["p2", "x1"], add: [
      { id: "x1", kind: "cross", text: null, x: 460, y: 230, w: null, h: null, from: null, to: null, emphasis: null },
    ] },
    { caption: "Marco has the history to backfill. Keep one, bring one.", highlight: ["p3", "a2", "c1"], add: [
      { id: "p3", kind: "person", text: "Marco Ruiz", x: 800, y: 420, w: null, h: null, from: null, to: null, emphasis: "strong" },
      { id: "a2", kind: "arrow", text: "backfills", x: 0, y: 0, w: null, h: null, from: "p3", to: "g1", emphasis: null },
      { id: "c1", kind: "check", text: null, x: 860, y: 380, w: null, h: null, from: null, to: null, emphasis: null },
    ] },
  ],
};
type Panel = { kind: "experts"; ranked: ScoredPerson[] } | { kind: "impact"; report: ImpactReport } | null;

export default function Home() {
  return (
    <ConversationProvider>
      <Jeff />
    </ConversationProvider>
  );
}

function Jeff() {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [highlight, setHighlight] = useState<Highlight>(null);
  const [error, setError] = useState<string | null>(null);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [transcript, setTranscript] = useState<string[]>([]);
  // The whiteboard: what Jeff has sketched, and whether the graph or the board is up.
  const [board, setBoard] = useState<Scene | null>(null);
  const [boardBusy, setBoardBusy] = useState<string | null>(null);
  const [view, setView] = useState<"graph" | "board">("graph");

  useEffect(() => {
    loadPeople().then(setPeople).catch(() => setError("Couldn't load the people data."));
    loadGraph().then(setGraph).catch(() => { /* graph is decoration */ });
    // ?board=demo previews the whiteboard without a conversation.
    if (new URLSearchParams(window.location.search).get("board") === "demo") {
      const t = setTimeout(() => { setBoard(DEMO_SCENE); setView("board"); setCanvasOpen(true); }, 0);
      return () => clearTimeout(t);
    }
  }, []);

  const peopleRef = useRef<Person[] | null>(null);
  useEffect(() => { peopleRef.current = people; }, [people]);

  // Every turn goes to the console; Jeff's own words are also printed under the blob.
  const say = useCallback((role: Line["role"], text: string) => {
    console.log(`[jeff:${role}]`, text);
    if (role === "jeff" && text.trim()) setTranscript((t) => [...t, text.trim()]);
  }, []);

  // Tools tell Jeff what the screen is doing through contextual updates (no reply expected).
  const tellJeffRef = useRef<(text: string) => void>(() => {});
  const highlightRef = useRef<Highlight>(null);
  useEffect(() => { highlightRef.current = highlight; }, [highlight]);

  const showScene = useCallback((scene: Scene, source: string) => {
    setBoard(scene);
    setView("board");
    setCanvasOpen(true);
    say("tool", `${source} → "${scene.title}" (${scene.steps.length} steps)`);
    tellJeffRef.current(describeScene(scene) + " Narrate it step by step; the screen advances on its own every couple of seconds.");
  }, [say]);

  // ── Client tools: what Jeff can look up ──────────────────────────────────
  const clientTools = useMemo(() => ({
    find_experts: async ({ topic, limit }: { topic: string; limit?: number }) => {
      const ps = peopleRef.current ?? await loadPeople();
      const ranked = rankExperts(ps, String(topic ?? ""), Math.min(8, Number(limit) || 5));
      say("tool", `find_experts("${topic}") → ${ranked.length} candidates`);
      if (ranked.length) {
        setPanel({ kind: "experts", ranked });
        setHighlight({ people: ranked.map((r) => r.person.name), title: `Who knows ${topic}` });
        setCanvasOpen(true);
      }
      if (!ranked.length) return JSON.stringify({ result: "no matches in the Boston data", topic });
      return JSON.stringify({
        topic,
        candidates: ranked.map((r, i) => ({ rank: i + 1, ...personSummary(r.person), evidence: r.evidence })),
      });
    },
    lookup_person: async ({ name }: { name: string }) => {
      const ps = peopleRef.current ?? await loadPeople();
      const p = findPerson(ps, String(name ?? ""));
      say("tool", `lookup_person("${name}") → ${p ? p.name : "not found"}`);
      if (!p) return JSON.stringify({ result: "not found in the Boston data", name });
      setHighlight({ people: [p.name], title: p.name });
      setCanvasOpen(true);
      return JSON.stringify(personSummary(p, true));
    },
    impact_if_moved: async ({ names }: { names: string[] | string }) => {
      const ps = peopleRef.current ?? await loadPeople();
      const list = Array.isArray(names) ? names : String(names ?? "").split(/,|\band\b/).map((s) => s.trim()).filter(Boolean);
      const report = impactOfMoving(ps, list);
      say("tool", `impact_if_moved(${list.join(", ")}) → ${report.summary}`);
      setPanel({ kind: "impact", report });
      setCanvasOpen(true);
      const backfills = report.areas.filter((a) => a.backfill && a.status !== "fine").map((a) => a.backfill!.name);
      setHighlight({ people: [...report.moved, ...backfills], skills: report.areas.filter((a) => a.kind === "skill" && a.status !== "fine").map((a) => a.area), title: `If ${report.moved.join(", ")} move` });
      return JSON.stringify({
        moved: report.moved,
        not_found: report.unknown,
        summary: report.summary,
        areas: report.areas.slice(0, 8).map((a) => ({
          area: a.area, kind: a.kind, status: a.status, loses: a.moved,
          remaining: a.remaining.slice(0, 3).map((r) => r.name),
          suggested_backfill: a.backfill,
        })),
      });
    },
    team_overview: async ({ section }: { section?: string }) => {
      const ps = peopleRef.current ?? await loadPeople();
      say("tool", `team_overview(${section ? `"${section}"` : ""})`);
      setHighlight(null);
      setPanel(null);
      return JSON.stringify({ total_people: ps.length, sections: sectionOverview(ps, section) });
    },
    show_on_graph: ({ people: names, skills, title }: { people?: string[]; skills?: string[]; title?: string }) => {
      const ps = peopleRef.current ?? [];
      const resolved = (names ?? []).map((n) => findPerson(ps, n)?.name ?? n);
      setHighlight({ people: resolved, skills: skills ?? [], title });
      setView("graph");
      setCanvasOpen(true);
      return "shown";
    },

    // ── The whiteboard ──
    // Slow path: a brief goes to the drawing brain (/api/board), which
    // designs an animated scene. Jeff keeps talking; the board reports back.
    board_explain: ({ brief, facts }: { brief: string; facts?: string }) => {
      const b = String(brief ?? "").trim();
      if (!b) return "need a brief";
      say("tool", `board_explain("${b}")`);
      setBoardBusy(b);
      setView("board");
      setCanvasOpen(true);
      const hl = highlightRef.current;
      const context = [facts, hl?.people?.length ? `People on screen: ${hl.people.join(", ")}` : ""].filter(Boolean).join("\n");
      void (async () => {
        try {
          const res = await fetch(`${BASE}/api/board`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ brief: b, context }) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
          const scene = SceneSchema.parse(data.scene);
          showScene(scene, "drawing brain");
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          say("tool", `board_explain failed: ${msg}`);
          setView((v) => (v === "board" && !board ? "graph" : v));
          tellJeffRef.current(`The drawing brain could not sketch that (${msg}). Use board_write to put the key items on the board yourself.`);
        } finally {
          setBoardBusy(null);
        }
      })();
      return "sketching; keep talking, the board will tell you when it is up";
    },
    // Fast path: Jeff writes the board directly. No second brain, works anywhere.
    board_write: ({ title, items, connections }: QuickBoard) => {
      const list = (Array.isArray(items) ? items : []).map((it) => typeof it === "string" ? { label: it } : it).filter((it) => it && it.label);
      if (!list.length) return "nothing to write";
      showScene(quickScene({ title: String(title ?? "Whiteboard"), items: list, connections: connections ?? null }), "board_write");
      return "on the board";
    },
    board_clear: () => {
      setBoard(null);
      setBoardBusy(null);
      setView("graph");
      say("tool", "board_clear()");
      return "wiped";
    },
  }), [say, showScene, board]);

  // ── The conversation ─────────────────────────────────────────────────────
  const conversation = useConversation({
    clientTools,
    onConnect: () => { setError(null); setTranscript([]); setBoard(null); setView("graph"); },
    onMessage: ({ message, role }) => {
      const r = String(role);
      if (r === "user") say("user", message);
      else if (message) say("jeff", message);
    },
    onError: (msg) => setError(typeof msg === "string" ? msg : "Something went wrong with the connection."),
  });
  const { status, isSpeaking, startSession, endSession, sendUserMessage, sendContextualUpdate, getInputVolume, getOutputVolume } = conversation;
  useEffect(() => {
    tellJeffRef.current = (text) => {
      if (status !== "connected") return;
      try { sendContextualUpdate(text); } catch { /* not connected */ }
    };
  }, [status, sendContextualUpdate]);

  const start = useCallback(async () => {
    if (!AGENT_ID) { setError("No agent configured yet. See the setup note on the right."); return; }
    setError(null);
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone unavailable. Check the browser's mic permission.");
      return;
    }
    startSession({ agentId: AGENT_ID, connectionType: "webrtc" });
  }, [startSession]);

  const mood: BlobMood = status === "connected" ? (isSpeaking ? "speaking" : "listening") : status === "connecting" ? "connecting" : "idle";

  const onTap = useCallback(() => {
    if (mood === "idle") void start();
    else if (mood === "speaking") sendUserMessage(""); // an empty user turn is the cheapest interrupt the SDK offers
    else endSession();
  }, [mood, start, sendUserMessage, endSession]);

  const stop = useCallback(() => { void endSession(); }, [endSession]);

  const getLevel = useCallback(() => {
    try {
      return mood === "speaking" ? getOutputVolume() : mood === "listening" ? getInputVolume() : 0;
    } catch { return 0; }
  }, [mood, getInputVolume, getOutputVolume]);


  return (
    <main className={`jeff-page${canvasOpen ? "" : " jeff-page--collapsed"}`}>
      <button
        type="button"
        className="jeff-canvas-toggle"
        onClick={() => setCanvasOpen((o) => !o)}
        aria-label={canvasOpen ? "Hide canvas" : "Show canvas"}
        title={canvasOpen ? "Hide canvas" : "Show canvas"}
      >
        {canvasOpen ? "›" : "‹"}
      </button>
      <section className="jeff-stage">
        <div className="jeff-brand"><h1>Jeff</h1></div>
        <JeffBlob
          mood={mood}
          getLevel={getLevel}
          onTap={onTap}
          word=""
          helper=""
          error={error}
          disabled={!people && mood === "idle"}
          onStop={mood === "idle" ? undefined : stop}
          transcript={transcript}
        />
      </section>

      <section className="jeff-panel" aria-hidden={!canvasOpen}>
        <div className="jeff-panel-head">
          <h2>Red Hat Boston</h2>
          <div className="jeff-panel-meta">
            <span>{graph ? `${graph.nodes.filter((n) => n.type === "person").length} people · ${graph.nodes.filter((n) => n.type === "skill").length} skill areas` : ""}</span>
            {(board || boardBusy) && (
              <div className="jeff-view-switch" role="tablist" aria-label="Canvas view">
                <button type="button" role="tab" aria-selected={view === "graph"} className={view === "graph" ? "on" : undefined} onClick={() => setView("graph")}>Graph</button>
                <button type="button" role="tab" aria-selected={view === "board"} className={view === "board" ? "on" : undefined} onClick={() => setView("board")}>Board</button>
              </div>
            )}
          </div>
        </div>
        {view === "board" && board ? (
          <Whiteboard
            scene={board}
            onDone={() => tellJeffRef.current(`The whiteboard "${board.title}" is fully drawn.`)}
            onClear={() => { setBoard(null); setView("graph"); }}
          />
        ) : view === "board" && boardBusy ? (
          <div className="wb"><div className="wb-busy">sketching “{boardBusy}”…</div></div>
        ) : (
          <OrgGraph graph={graph} highlight={highlight} />
        )}
        {panel?.kind === "experts" && <ExpertCards ranked={panel.ranked} />}
        {panel?.kind === "impact" && <ImpactCards report={panel.report} />}
        {!AGENT_ID && (
          <div className="jeff-setup">
            <strong>Jeff has no voice yet.</strong> Create the ElevenLabs agent once with{" "}
            <code>python3 ingest/create_agent.py</code>, then put the printed id in{" "}
            <code>src/.env.local</code> as <code>NEXT_PUBLIC_ELEVENLABS_AGENT_ID</code> and restart the dev server.
          </div>
        )}
      </section>
    </main>
  );
}
