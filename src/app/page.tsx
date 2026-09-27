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
import { ExpertCards, ImpactCards } from "@/components/PeopleCards";
import {
  findPerson, impactOfMoving, loadGraph, loadPeople, personSummary, rankExperts, sectionOverview,
  type Graph, type ImpactReport, type Person, type ScoredPerson,
} from "@/lib/jeffData";

const AGENT_ID = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID ?? "";

type Line = { role: "user" | "jeff" | "tool" };
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

  useEffect(() => {
    loadPeople().then(setPeople).catch(() => setError("Couldn't load the people data."));
    loadGraph().then(setGraph).catch(() => { /* graph is decoration */ });
  }, []);

  const peopleRef = useRef<Person[] | null>(null);
  useEffect(() => { peopleRef.current = people; }, [people]);

  // Tool calls and turns are logged to the console only: the surface stays clean.
  const say = useCallback((role: Line["role"], text: string) => { console.log(`[jeff:${role}]`, text); }, []);

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
      setCanvasOpen(true);
      return "shown";
    },
  }), [say]);

  // ── The conversation ─────────────────────────────────────────────────────
  const conversation = useConversation({
    clientTools,
    onConnect: () => setError(null),
    onMessage: ({ message, role }) => {
      const r = String(role);
      if (r === "user") say("user", message);
      else if (message) say("jeff", message);
    },
    onError: (msg) => setError(typeof msg === "string" ? msg : "Something went wrong with the connection."),
  });
  const { status, isSpeaking, startSession, endSession, sendUserMessage, getInputVolume, getOutputVolume } = conversation;
  void status;

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
        <JeffBlob mood={mood} getLevel={getLevel} onTap={onTap} word="" helper="" error={error} disabled={!people && mood === "idle"} />
      </section>

      <section className="jeff-panel" aria-hidden={!canvasOpen}>
        <div className="jeff-panel-head">
          <h2>Red Hat Boston</h2>
          <span>{graph ? `${graph.nodes.filter((n) => n.type === "person").length} people · ${graph.nodes.filter((n) => n.type === "skill").length} skill areas` : ""}</span>
        </div>
        <OrgGraph graph={graph} highlight={highlight} />
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
