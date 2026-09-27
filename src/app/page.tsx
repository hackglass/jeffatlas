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
import JeffBlob, { type BlobMood, type DockTurn } from "@/components/JeffBlob";
import OrgGraph, { sectionShort, type Highlight, type Lens, type Pick } from "@/components/OrgGraph";
import Whiteboard from "@/components/Whiteboard";
import UsageSankey, { describeUsage, loadUsage, type Usage } from "@/components/UsageSankey";
import { describeScene, quickScene, SceneSchema, type QuickBoard, type Scene } from "@/lib/board";
import { ExpertCards, ImpactCards } from "@/components/PeopleCards";
import * as history from "@/lib/history";
import {
  findPerson, impactOfMoving, loadGraph, loadPeople, personSummary, rankExperts, sectionOverview,
  type Graph, type ImpactReport, type Person, type ScoredPerson,
} from "@/lib/jeffData";

const AGENT_ID = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID ?? "";
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type Line = { role: "user" | "jeff" | "tool" };

// Sent as the first user turn so Jeff opens in his own words. Hidden from the dock.
const KICKOFF = "[The viewer just sat down at your desk; greet them briefly in your own words.]";

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

// Who is looking. There is no login on this demo, so the viewer picks a
// level; a real deployment would take it from SSO claims. It gates what the
// tools return *and* is told to Jeff so he pitches the conversation right:
//   new      — service desk: who to ask, what team they are on. No risk analysis.
//   manager  — plus staffing impact and backfill suggestions.
//   leader   — plus full profiles, bios and public links.
type Access = "new" | "manager" | "leader";
const ACCESS_LABEL: Record<Access, string> = { new: "New hire", manager: "Manager", leader: "Senior leader" };
const ACCESS_BLURB: Record<Access, string> = {
  new: "directory level: who to ask and where they sit; no staffing or risk analysis",
  manager: "manager level: who knows what, plus staffing impact and backfills",
  leader: "leadership level: everything, including full profiles and public bios",
};

export default function Home() {
  return (
    <ConversationProvider>
      <Jeff />
    </ConversationProvider>
  );
}

function Jeff() {
  // Tools tell Jeff what the screen is doing through contextual updates (no reply expected).
  const tellJeffRef = useRef<(text: string) => void>(() => {});
  const [people, setPeople] = useState<Person[] | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [highlight, setHighlight] = useState<Highlight>(null);
  const [error, setError] = useState<string | null>(null);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [instant, setInstant] = useState(false); // open without the slide animation (?canvas=)
  const [dev, setDev] = useState(false); // ?dev shows the team-only footer (saved history, x-ray link)
  const [transcript, setTranscript] = useState<DockTurn[]>([]);
  const [endedNote, setEndedNote] = useState<string | null>(null);
  // Thinking: the person's words have landed (or a tool ran) and Jeff has not
  // started talking yet. Cleared when his audio starts, or after a safety timeout.
  const [thinking, setThinking] = useState(false);
  const thinkingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const think = useCallback(() => {
    setThinking(true);
    if (thinkingTimer.current) clearTimeout(thinkingTimer.current);
    thinkingTimer.current = setTimeout(() => setThinking(false), 15000);
  }, []);
  // The whiteboard: what Jeff has sketched, and whether the graph or the board is up.
  const [board, setBoard] = useState<Scene | null>(null);
  const [boardBusy, setBoardBusy] = useState<string | null>(null);
  const [view, setView] = useState<"graph" | "board" | "usage">("graph");
  // How Jeff is being used: every question from the saved transcripts, as a Sankey.
  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageFocus, setUsageFocus] = useState<string | null>(null);
  const usageRef = useRef<Usage | null>(null);
  useEffect(() => { usageRef.current = usage; }, [usage]);
  // The shared canvas: which lens is on, and what the human last clicked.
  const [lens, setLens] = useState<Lens>("people");
  const [selected, setSelected] = useState<Pick | null>(null);
  const lensRef = useRef<Lens>("people");
  useEffect(() => { lensRef.current = lens; }, [lens]);
  // Remembered per browser. Read after mount (not in the initializer) so the
  // server and first client render agree.
  // Who is talking. No login on the demo: the viewer types a name or email
  // once, it is kept in this browser and sent to ElevenLabs as the session's
  // user id, so every recorded conversation says who it was with.
  const [user, setUser] = useState("");
  const userRef = useRef("");
  useEffect(() => { userRef.current = user; }, [user]);
  useEffect(() => {
    let u = "";
    try { u = localStorage.getItem("jeff.user") ?? ""; } catch { /* no storage */ }
    if (!u) return;
    const t = setTimeout(() => setUser(u), 0);
    return () => clearTimeout(t);
  }, []);
  const chooseUser = useCallback((u: string) => {
    setUser(u);
    try { localStorage.setItem("jeff.user", u); } catch { /* no storage */ }
  }, []);

  const [access, setAccess] = useState<Access>("new");
  const accessRef = useRef<Access>(access);
  useEffect(() => { accessRef.current = access; }, [access]);
  useEffect(() => {
    let a: Access | null = null;
    try { a = localStorage.getItem("jeff.access") as Access | null; } catch { /* no storage */ }
    if (!a || !(a in ACCESS_LABEL)) return;
    const t = setTimeout(() => setAccess(a as Access), 0);
    return () => clearTimeout(t);
  }, []);
  const chooseAccess = useCallback((a: Access) => {
    setAccess(a);
    try { localStorage.setItem("jeff.access", a); } catch { /* no storage */ }
    tellJeffRef.current(`The viewer switched their access level to "${ACCESS_LABEL[a]}" (${ACCESS_BLURB[a]}). Adjust what you offer accordingly.`);
  }, []);

  // Is the drawing brain (/api/board) reachable in this build? The static
  // GitHub Pages site has no server, and a dev box may have no key yet. An
  // empty POST answers 400 when the route is live and keyed, anything else
  // means "off". Jeff is told once so he goes straight to board_write.
  const brainRef = useRef<"unknown" | "on" | "off">("unknown");
  useEffect(() => {
    loadPeople().then(setPeople).catch(() => setError("Couldn't load the people data."));
    loadGraph().then(setGraph).catch(() => { /* graph is decoration */ });
    loadUsage().then(setUsage).catch(() => { /* no transcripts exported yet */ });
    fetch(`${BASE}/api/board`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .then((r) => { brainRef.current = r.status === 400 ? "on" : "off"; })
      .catch(() => { brainRef.current = "off"; });
    const qs = new URLSearchParams(window.location.search);
    if (qs.has("dev")) setTimeout(() => setDev(true), 0);
    if (qs.get("canvas")) {
      const t = setTimeout(() => { setInstant(true); setCanvasOpen(true); if (qs.get("canvas") === "skills") setLens("skills"); }, 0);
      return () => clearTimeout(t);
    }
    // ?view=usage opens the usage Sankey without a conversation.
    if (qs.get("view") === "usage") {
      const t = setTimeout(() => { setView("usage"); setCanvasOpen(true); }, 0);
      return () => clearTimeout(t);
    }
    // ?board=demo previews the whiteboard without a conversation.
    if (qs.get("board") === "demo") {
      const t = setTimeout(() => { setBoard(DEMO_SCENE); setView("board"); setCanvasOpen(true); }, 0);
      return () => clearTimeout(t);
    }
  }, []);

  const peopleRef = useRef<Person[] | null>(null);
  useEffect(() => { peopleRef.current = people; }, [people]);

  // Every turn (the person, Jeff, and what the tools did) is saved to the
  // session's history in localStorage, echoed to the console, and Jeff's own
  // words are printed under the blob.
  const sessionRef = useRef<string | null>(null);
  const [histStats, setHistStats] = useState<{ sessions: number; turns: number } | null>(null);
  useEffect(() => { const t = setTimeout(() => setHistStats(history.historyStats()), 0); return () => clearTimeout(t); }, []);
  const say = useCallback((role: Line["role"], text: string) => {
    console.log(`[jeff:${role}]`, text);
    history.appendTurn(sessionRef.current, role, text);
    if (!text.trim()) return;
    // Tool lines are kept short on the dock: what Jeff looked up, not the result.
    const shown = role === "tool" ? text.trim().split(" → ")[0] : text.trim();
    setTranscript((t) => [...t, { role, text: shown }]);
    if (role !== "jeff") think();
  }, [think]);

  const highlightRef = useRef<Highlight>(null);
  useEffect(() => { highlightRef.current = highlight; }, [highlight]);

  // Point the graph at people. Someone with no GitHub footprint (most of
  // leadership, product, GTM) only exists in the People lens, so switch to it
  // when the Skills lens would show an empty picture.
  const focus = useCallback((h: Exclude<Highlight, null>, wantLens?: Lens) => {
    const ps = peopleRef.current ?? [];
    const technical = h.people.length > 0 && h.people.every((n) => (findPerson(ps, n)?.commits ?? 0) > 0);
    setHighlight(h);
    setSelected(null);
    setLens(wantLens ?? (technical || (h.skills?.length && !h.people.length) ? "skills" : "people"));
    setView("graph");
    setCanvasOpen(true);
  }, []);

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
      const cap = accessRef.current === "new" ? 3 : 8;
      const ranked = rankExperts(ps, String(topic ?? ""), Math.min(cap, Number(limit) || 5));
      say("tool", `find_experts("${topic}") → ${ranked.length} candidates`);
      if (ranked.length) {
        setPanel({ kind: "experts", ranked });
        focus({ people: ranked.map((r) => r.person.name), title: `Who knows ${topic}` });
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
      focus({ people: [p.name], title: p.name });
      // Full profiles (long bio, public links) are leadership-level; everyone else gets the card.
      return JSON.stringify(personSummary(p, accessRef.current === "leader"));
    },
    impact_if_moved: async ({ names }: { names: string[] | string }) => {
      const ps = peopleRef.current ?? await loadPeople();
      const list = Array.isArray(names) ? names : String(names ?? "").split(/,|\band\b/).map((s) => s.trim()).filter(Boolean);
      if (accessRef.current === "new") {
        say("tool", `impact_if_moved(${list.join(", ")}) → blocked at new-hire access`);
        return JSON.stringify({ result: "staffing impact analysis is not available at this viewer's access level; offer to point them at the right people instead" });
      }
      const report = impactOfMoving(ps, list);
      say("tool", `impact_if_moved(${list.join(", ")}) → ${report.summary}`);
      setPanel({ kind: "impact", report });
      setCanvasOpen(true);
      const backfills = report.areas.filter((a) => a.backfill && a.status !== "fine").map((a) => a.backfill!.name);
      focus({ people: [...report.moved, ...backfills], skills: report.areas.filter((a) => a.kind === "skill" && a.status !== "fine").map((a) => a.area), title: `If ${report.moved.join(", ")} move` });
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
      setSelected(null);
      setPanel(null);
      setLens("people");
      setView("graph");
      setCanvasOpen(true);
      return JSON.stringify({ total_people: ps.length, sections: sectionOverview(ps, section) });
    },
    show_on_graph: ({ people: names, skills, title, lens: wantLens }: { people?: string[]; skills?: string[]; title?: string; lens?: string }) => {
      const ps = peopleRef.current ?? [];
      const resolved = (names ?? []).map((n) => findPerson(ps, n)?.name ?? n);
      const l = wantLens === "people" || wantLens === "skills" ? wantLens : undefined;
      if (!resolved.length && !(skills ?? []).length) {
        setHighlight(null); setSelected(null); setView("graph"); setCanvasOpen(true);
        if (l) setLens(l);
        return "cleared";
      }
      focus({ people: resolved, skills: skills ?? [], title }, l);
      return "shown";
    },
    graph_lens: ({ lens: wantLens }: { lens: string }) => {
      const l = wantLens === "skills" ? "skills" : "people";
      setLens(l); setView("graph"); setCanvasOpen(true);
      say("tool", `graph_lens("${l}")`);
      return l === "people" ? "showing everyone in Boston grouped by section" : "showing the technical view: skill areas and GitHub activity";
    },

    // ── The whiteboard ──
    // Slow path: a brief goes to the drawing brain (/api/board), which
    // designs an animated scene. Jeff keeps talking; the board reports back.
    board_explain: ({ brief, facts }: { brief: string; facts?: string }) => {
      const b = String(brief ?? "").trim();
      if (!b) return "need a brief";
      say("tool", `board_explain("${b}")`);
      if (brainRef.current === "off") return "the drawing brain is offline in this build; use board_write to put the key items on the board yourself";
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
    // Feedback about Jeff himself, filed as a tool call so it lands in the
    // ElevenLabs transcript, the local history, the usage export and /xray.
    record_feedback: ({ note, kind }: { note: string; kind?: string }) => {
      const n = String(note ?? "").trim();
      if (!n) return "nothing to file";
      const k = ["suggestion", "bug", "complaint", "praise"].includes(String(kind)) ? String(kind) : "suggestion";
      say("tool", `record_feedback(${k}) → "${n}"`);
      console.log("[jeff:feedback]", k, n);
      return `filed as ${k}; thank them in one breath and carry on`;
    },
    board_clear: () => {
      setBoard(null);
      setBoardBusy(null);
      setView("graph");
      say("tool", "board_clear()");
      return "wiped";
    },

    // ── Usage: what people ask Jeff ──
    // The Sankey of every saved question (who asked → kind → topic → outcome)
    // with a leaderboard of topics. Leadership-facing; a new hire just gets the tally.
    show_usage: async ({ focus: want }: { focus?: string }) => {
      const u = usageRef.current ?? await loadUsage().then((x) => { setUsage(x); return x; }).catch(() => null);
      const f = want ? String(want).trim() : null;
      setUsageFocus(f);
      setView("usage");
      setCanvasOpen(true);
      say("tool", `show_usage(${f ? `"${f}"` : ""})`);
      if (!u || !u.conversations.length) return "no usage data yet: nobody's transcripts have been exported";
      if (accessRef.current === "new") {
        const n = u.conversations.reduce((a, c) => a + c.queries.length, 0);
        return `${u.conversations.length} conversations and ${n} questions so far; the breakdown is a manager-level view, keep it to that`;
      }
      return describeUsage(u, f ?? undefined);
    },
  }), [say, showScene, focus, board]);

  // ── The human's hand on the canvas ──
  // A click is a pick: the graph focuses on it and Jeff is told, as context
  // rather than as a question, so he can fold it in without being forced to answer.
  const onPick = useCallback((pick: Pick | null) => {
    setSelected(pick);
    if (!pick) { setHighlight(null); return; }
    const ps = peopleRef.current ?? [];
    if (pick.type === "person") {
      const p = findPerson(ps, pick.label);
      setHighlight({ people: [pick.label], title: pick.label });
      // Nobody without commits exists in the Skills lens; show them among their section instead.
      if (!(p?.commits ?? 0)) setLens("people");
      const who = p ? [p.role, sectionShort(p.section), p.commits ? `${p.commits} commits` : ""].filter(Boolean).join(", ") : "";
      say("tool", `you picked ${pick.label}`);
      tellJeffRef.current(`The user just clicked ${pick.label} on the org graph${who ? ` (${who})` : ""}. If it fits, mention them briefly or ask what they want to know; do not read out a profile unprompted.`);
    } else if (pick.id.startsWith("section:")) {
      setHighlight(null);
      say("tool", `you picked the ${pick.label} section`);
      tellJeffRef.current(`The user just clicked the "${pick.label}" section hub on the org graph. They may want an overview of that group; team_overview("${pick.label}") answers it.`);
    } else {
      setHighlight({ skills: [pick.label], people: [], title: pick.label });
      say("tool", `you picked ${pick.label}`);
      tellJeffRef.current(`The user just clicked the "${pick.label}" skill area on the org graph; the people in it are now on screen. find_experts("${pick.label}") ranks them if they ask.`);
    }
  }, [say]);

  // ── The conversation ─────────────────────────────────────────────────────
  const conversation = useConversation({
    clientTools,
    onConnect: () => {
      setError(null); setTranscript([]); setEndedNote(null); setBoard(null); setView("graph");
      const a = accessRef.current;
      sessionRef.current = history.startSession(ACCESS_LABEL[a]);
      setHistStats(history.historyStats());
      setTimeout(() => tellJeffRef.current(`Viewer access level: ${ACCESS_LABEL[a]} (${ACCESS_BLURB[a]}). The screen shows the ${lensRef.current === "people" ? "People lens (everyone, by section)" : "Skills lens (technical, from GitHub)"}; the user can click people and areas on it and you will be told.`), 600);
      // No canned first message on the agent: a hidden kickoff turn asks Jeff
      // to greet in his own words. A pending "Ask Jeff" click rides along instead.
      const pending = pendingAskRef.current;
      pendingAskRef.current = null;
      const who = userRef.current.trim();
      const kickoff = pending ?? `${KICKOFF} ${who ? `Their name is ${who}.` : "They did not give a name."}`;
      setTimeout(() => { try { conversationRef.current?.sendUserMessage(kickoff); } catch { /* not ready */ } }, 400);
      if (brainRef.current === "off") {
        setTimeout(() => tellJeffRef.current("Note: the drawing brain (board_explain) is offline in this build. Draw with board_write instead; it works fine."), 800);
      }
    },
    onModeChange: ({ mode }) => {
      if (mode !== "speaking") return;
      setThinking(false);
      if (thinkingTimer.current) clearTimeout(thinkingTimer.current);
    },
    onMessage: ({ message, role }) => {
      const r = String(role);
      if (r === "user") { if (!message.startsWith(KICKOFF)) say("user", message); }
      else if (message) say("jeff", message);
    },
    onDisconnect: (details) => {
      history.endSession(sessionRef.current);
      sessionRef.current = null;
      setHistStats(history.historyStats());
      // Say why the line went quiet: hanging up looks different from Jeff timing out.
      const reason = (details as { reason?: string; message?: string } | undefined)?.reason;
      setThinking(false);
      setEndedNote(reason === "user" ? "Conversation ended" : reason === "agent" ? "Jeff ended the conversation" : reason === "error" ? "The connection dropped" : "Conversation ended");
    },
    onError: (msg) => setError(typeof msg === "string" ? msg : "Something went wrong with the connection."),
  });
  const { status, isSpeaking, isMuted, setMuted, startSession, endSession, sendUserMessage, sendContextualUpdate, getInputVolume, getOutputVolume } = conversation;
  const conversationRef = useRef<typeof conversation | null>(null);
  useEffect(() => { conversationRef.current = conversation; }, [conversation]);
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
    const who = userRef.current.trim() || "anonymous";
    startSession({
      agentId: AGENT_ID, connectionType: "webrtc", userId: who,
      dynamicVariables: { access_level: ACCESS_LABEL[accessRef.current], access_scope: ACCESS_BLURB[accessRef.current], user_name: who },
    });
  }, [startSession]);

  // "Ask Jeff" on a picked node: a real user turn if we are talking, otherwise
  // it starts the session and asks as soon as Jeff is on the line.
  const pendingAskRef = useRef<string | null>(null);
  const onAsk = useCallback((pick: Pick) => {
    const q = pick.type === "person" ? `Tell me about ${pick.label}.` : pick.id.startsWith("section:") ? `Give me the shape of the ${pick.label} group.` : `Who should I talk to about ${pick.label}?`;
    if (status === "connected") { say("user", q); sendUserMessage(q); }
    else { pendingAskRef.current = q; void start(); }
  }, [status, sendUserMessage, start, say]);

  const mood: BlobMood = status === "connected" ? (isSpeaking ? "speaking" : thinking ? "thinking" : "listening") : status === "connecting" ? "connecting" : "dormant";

  // Cut Jeff off. The SDK has no interrupt call; an empty user turn is the
  // cheapest thing that stops his audio and hands the floor back.
  const interrupt = useCallback(() => { try { sendUserMessage(""); } catch { /* not connected */ } }, [sendUserMessage]);
  const toggleMute = useCallback(() => { setMuted(!isMuted); }, [isMuted, setMuted]);

  // The blob itself: start when idle, cut in while Jeff talks, unmute if muted. Never ends the call.
  const onTap = useCallback(() => {
    if (mood === "dormant") void start();
    else if (mood === "speaking") interrupt();
    else if (mood === "listening" && isMuted) setMuted(false);
  }, [mood, start, interrupt, isMuted, setMuted]);

  const stop = useCallback(() => { void endSession(); }, [endSession]);

  // Keyboard: Escape hangs up, Space cuts Jeff off (unless typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "Escape" && status === "connected") { e.preventDefault(); void endSession(); }
      else if (e.key === " " && status === "connected" && isSpeaking) { e.preventDefault(); interrupt(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, isSpeaking, endSession, interrupt]);

  const getLevel = useCallback(() => {
    try {
      return mood === "speaking" ? getOutputVolume() : mood === "listening" ? getInputVolume() : 0;
    } catch { return 0; }
  }, [mood, getInputVolume, getOutputVolume]);


  return (
    <main className={`jeff-page${canvasOpen ? "" : " jeff-page--collapsed"}${instant ? " jeff-page--instant" : ""}`}>
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
          onStart={() => void start()}
          onEnd={stop}
          onInterrupt={interrupt}
          muted={isMuted}
          onToggleMute={toggleMute}
          error={error}
          disabled={!people && mood === "dormant"}
          endedNote={endedNote}
          transcript={transcript}
        />
      </section>

      <section className="jeff-panel" aria-hidden={!canvasOpen}>
       <div className="jeff-panel-inner">
        <div className="jeff-panel-head">
          <div>
            <h2>Red Hat Boston</h2>
            <span>{graph ? `${graph.nodes.filter((n) => n.type === "person").length} people · ${lens === "people" ? "5 sections" : `${graph.nodes.filter((n) => n.type === "skill").length} skill areas`}` : ""}</span>
          </div>
          <div className="jeff-panel-meta">
            <label className="jeff-access" title="Who you are: recorded with the conversation so the transcripts say who asked">
              <span>you are</span>
              <input type="text" value={user} placeholder="name or email" onChange={(e) => chooseUser(e.target.value)} spellCheck={false} />
            </label>
            <label className="jeff-access" title="Who is looking: gates what Jeff and the tools will share">
              <span>viewing as</span>
              <select value={access} onChange={(e) => chooseAccess(e.target.value as Access)}>
                {(Object.keys(ACCESS_LABEL) as Access[]).map((a) => <option key={a} value={a}>{ACCESS_LABEL[a]}</option>)}
              </select>
            </label>
            {view === "graph" && (
              <div className="jeff-view-switch" role="tablist" aria-label="Graph lens">
                <button type="button" role="tab" aria-selected={lens === "people"} className={lens === "people" ? "on" : undefined} onClick={() => { setLens("people"); tellJeffRef.current("The user switched the graph to the People lens (everyone, by section)."); }}>People</button>
                <button type="button" role="tab" aria-selected={lens === "skills"} className={lens === "skills" ? "on" : undefined} onClick={() => { setLens("skills"); tellJeffRef.current("The user switched the graph to the Skills lens (technical view from GitHub)."); }}>Skills</button>
              </div>
            )}
            {(board || boardBusy || view === "usage" || (usage && usage.conversations.length > 0)) && (
              <div className="jeff-view-switch" role="tablist" aria-label="Canvas view">
                <button type="button" role="tab" aria-selected={view === "graph"} className={view === "graph" ? "on" : undefined} onClick={() => setView("graph")}>Graph</button>
                {(board || boardBusy) && <button type="button" role="tab" aria-selected={view === "board"} className={view === "board" ? "on" : undefined} onClick={() => setView("board")}>Board</button>}
                {usage && usage.conversations.length > 0 && <button type="button" role="tab" aria-selected={view === "usage"} className={view === "usage" ? "on" : undefined} onClick={() => { setView("usage"); tellJeffRef.current("The user opened the Usage view: a Sankey of what people have asked you, by access level, kind, topic and outcome, with a leaderboard of topics."); }}>Usage</button>}
              </div>
            )}
          </div>
        </div>
        {view === "usage" ? (
          <UsageSankey usage={usage} focus={usageFocus} onFocus={(label) => { setUsageFocus(label); tellJeffRef.current(label ? `On the usage view the user clicked "${label}"; the flows through it are highlighted.` : "The user cleared the usage filter."); }} />
        ) : view === "board" && board ? (
          <Whiteboard
            scene={board}
            onDone={() => tellJeffRef.current(`The whiteboard "${board.title}" is fully drawn.`)}
            onClear={() => { setBoard(null); setView("graph"); }}
          />
        ) : view === "board" && boardBusy ? (
          <div className="wb"><div className="wb-busy">sketching “{boardBusy}”…</div></div>
        ) : (
          <OrgGraph graph={graph} highlight={highlight} lens={lens} selected={selected} onPick={onPick} onAsk={onAsk} onClear={() => { setHighlight(null); setSelected(null); }} />
        )}
        {panel?.kind === "experts" && <ExpertCards ranked={panel.ranked} />}
        {panel?.kind === "impact" && <ImpactCards report={panel.report} />}
        {dev && <div className="jeff-history">
          {histStats && histStats.sessions > 0 ? (
            <>
              <span>{histStats.sessions} saved {histStats.sessions === 1 ? "conversation" : "conversations"} · {histStats.turns} turns</span>
              <button type="button" onClick={() => history.downloadHistory()}>Download transcripts</button>
              <a href={`${BASE}/xray`}>x-ray all conversations</a>
            </>
          ) : (
            <span>Conversations are saved in this browser as you talk.</span>
          )}
        </div>}
        {!AGENT_ID && (
          <div className="jeff-setup">
            <strong>Jeff has no voice yet.</strong> Create the ElevenLabs agent once with{" "}
            <code>python3 ingest/create_agent.py</code>, then put the printed id in{" "}
            <code>src/.env.local</code> as <code>NEXT_PUBLIC_ELEVENLABS_AGENT_ID</code> and restart the dev server.
          </div>
        )}
       </div>
      </section>
    </main>
  );
}
