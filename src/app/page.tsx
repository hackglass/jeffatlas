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
import { ExpertCards, ImpactCards, DocCards, PersonCard } from "@/components/PeopleCards";
import { SlackDraftCard } from "@/components/SlackDraft";
import * as history from "@/lib/history";
import { analyticsOn, beginConversation, endConversation, identifyViewer, initAnalytics, track, trackTool, trackTurn } from "@/lib/analytics";
import {
  findPerson, impactOfMoving, loadGraph, loadPeople, personSummary, rankExperts, sectionMatches, sectionOverview,
  type Graph, type ImpactReport, type Person, type ScoredPerson,
} from "@/lib/jeffData";
import { loadDocs, passageSummary, rankDocs, type DocPassage, type ScoredPassage } from "@/lib/docsData";

const AGENT_ID = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID ?? "";
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type Line = { role: "user" | "jeff" | "tool" };

// Jeff's first line, spoken the instant the line opens (the agent's
// first_message is "{{greeting}}"). A hidden "greet them" turn used to do this
// and Jeff was silent on three openings in one round, so the opener is fixed
// text in his voice; the page picks one at random and drops the name in.
// Each greeting is a function of the first name, if any — the "with name" and
// "no name" phrasing are genuinely different sentences, not one template with
// a blank spliced in. A blind {name} substitution left "Hey. Jeff." on an
// anonymous session, which reads like Jeff is addressing someone named Jeff.
const GREETINGS: ((name: string) => string)[] = [
  (n) => (n ? `Hey ${n}. Jeff here—pull up a chair, what are we untangling?` : "Hey, I'm Jeff—pull up a chair, what are we untangling?"),
  (n) => (n ? `Hey ${n}, it's Jeff. Give me the messy version.` : "Hey there, it's Jeff. Give me the messy version."),
  (n) => (n ? `${n}, hey. Jeff here. Who—or what acronym—are we hunting?` : "Hey, Jeff here. Who—or what acronym—are we hunting?"),
  (n) => (n ? `Hey ${n}. I'm Jeff. I know which org charts are still technically fiction. What's up?` : "Hey there. I'm Jeff. I know which org charts are still technically fiction. What's up?"),
  (n) => (n ? `Hey ${n}. I'm Jeff. Tell me where you're stuck; I probably know who has the scar tissue.` : "Hey, I'm Jeff. Tell me where you're stuck; I probably know who has the scar tissue."),
  (n) => (n ? `Alright ${n}, Jeff's here. What's misbehaving?` : "Alright, Jeff's here. What's misbehaving?"),
];
function pickGreeting(who: string) {
  const real = who && !who.includes("@") && who.toLowerCase() !== "anonymous" ? who.split(/\s+/)[0] : "";
  const g = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
  return g(real);
}

function collapseExactEcho(text: string) {
  const clean = text.trim();
  if (clean.length % 2) return clean;
  const half = clean.length / 2;
  return clean.slice(0, half) === clean.slice(half) ? clean.slice(0, half) : clean;
}

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
type Panel = { kind: "experts"; ranked: ScoredPerson[] } | { kind: "impact"; report: ImpactReport }
  | { kind: "docs"; passages: ScoredPassage[]; experts: ScoredPerson[] } | { kind: "person"; person: Person }
  | { kind: "slack"; toName: string; message: string; autoCopied: boolean } | null;

// Who is looking. There is no login on this demo, so the viewer picks a
// level; a real deployment would take it from SSO claims. It gates what the
// tools return *and* is told to Jeff so he pitches the conversation right:
//   new      — service desk: who to ask, what team they are on. No risk analysis.
//   manager  — plus staffing impact and backfill suggestions.
//   leader   — plus full profiles, bios and public links.
type Access = "new" | "manager" | "leader";
const ACCESS_LABEL: Record<Access, string> = { new: "New hire", manager: "Manager", leader: "Senior leader" };
const ACCESS_BLURB: Record<Access, string> = {
  new: "directory level: who to ask (top 3 names) and where they sit; no staffing impact, no usage stats, no bios",
  manager: "manager level: who knows what with evidence (up to 8 names), staffing impact and backfills; still no full profiles or usage stats",
  leader: "leadership level: everything, including full profiles, public bios, links, and the usage view of what people ask Jeff",
};
/** What each level unlocks, shown under the picker so the difference is visible. */
const ACCESS_HINT: Record<Access, string> = {
  new: "who to ask · where they sit",
  manager: "+ evidence · staffing impact · backfills",
  leader: "+ full profiles · links · what people ask",
};

/** Wrap client tools so each call is logged with params, result and duration. */
function withLogging<T extends Record<string, (p: never) => unknown>>(tools: T): T {
  const out: Record<string, (p: never) => unknown> = {};
  for (const [name, fn] of Object.entries(tools)) {
    out[name] = (params: never) => {
      const t0 = performance.now();
      const done = (result: unknown) => { trackTool(name, params, result, Math.round(performance.now() - t0)); return result; };
      try {
        const r = fn(params);
        return r instanceof Promise ? r.then(done, (e) => { done(`error: ${e instanceof Error ? e.message : String(e)}`); throw e; }) : done(r);
      } catch (e) {
        done(`error: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }
    };
  }
  return out as T;
}

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
  const [docs, setDocs] = useState<DocPassage[] | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [highlight, setHighlight] = useState<Highlight>(null);
  const [error, setError] = useState<string | null>(null);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [instant, setInstant] = useState(false); // open without the slide animation (?canvas=)
  const [dev, setDev] = useState(false); // ?dev shows the team-only footer (saved history, x-ray link)
  const [transcript, setTranscript] = useState<DockTurn[]>([]);
  const [endedNote, setEndedNote] = useState<string | null>(null);
  const lastJeffLineRef = useRef<string | null>(null);
  // "Done" mutes the mic to hand Jeff the floor; cleared when he starts talking.
  const handoffRef = useRef(false);
  const transcriptRef = useRef<DockTurn[]>([]);
  useEffect(() => { transcriptRef.current = transcript; }, [transcript]);
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
  // The shared canvas: which lens is on, and what the human has clicked.
  // At most one skill/section, or any number of people (see `toggle`).
  const [lens, setLens] = useState<Lens>("people");
  const [selection, setSelection] = useState<Pick[]>([]);
  const selectionRef = useRef<Pick[]>([]);
  useEffect(() => { selectionRef.current = selection; }, [selection]);
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
    identifyViewer(u);
  }, []);
  useEffect(() => { identifyViewer(user); }, [user]);

  // No picker any more: Jeff sees everything (full profiles, impact analysis, usage).
  const [access, setAccess] = useState<Access>("leader");
  const accessRef = useRef<Access>(access);
  useEffect(() => { accessRef.current = access; }, [access]);
  const chooseAccess = useCallback((a: Access) => {
    setAccess(a);
    try { localStorage.setItem("jeff.access", a); } catch { /* no storage */ }
    track("access_changed", { access: a });
    tellJeffRef.current(`The viewer switched their access level to "${ACCESS_LABEL[a]}" (${ACCESS_BLURB[a]}). Adjust what you offer accordingly.`);
  }, []);

  // Is the drawing brain (/api/board) reachable in this build? The static
  // GitHub Pages site has no server, and a dev box may have no key yet. An
  // empty POST answers 400 when the route is live and keyed, anything else
  // means "off". Jeff is told once so he goes straight to board_write.
  const brainRef = useRef<"unknown" | "on" | "off">("unknown");
  useEffect(() => {
    initAnalytics();
    loadPeople().then(setPeople).catch(() => setError("Couldn't load the people data."));
    loadGraph().then(setGraph).catch(() => { /* graph is decoration */ });
    loadDocs().then(setDocs).catch(() => { /* docs.json not built yet; search_docs degrades to people-only */ });
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
  const docsRef = useRef<DocPassage[] | null>(null);
  useEffect(() => { docsRef.current = docs; }, [docs]);

  // Every turn (the person, Jeff, and what the tools did) is saved to the
  // session's history in localStorage, echoed to the console, and Jeff's own
  // words are printed under the blob.
  const sessionRef = useRef<string | null>(null);
  const [histStats, setHistStats] = useState<{ sessions: number; turns: number } | null>(null);
  useEffect(() => { const t = setTimeout(() => setHistStats(history.historyStats()), 0); return () => clearTimeout(t); }, []);
  const say = useCallback((role: Line["role"], text: string) => {
    const clean = collapseExactEcho(text);
    if (!clean) return;
    // Tool lines are kept short on the dock: what Jeff looked up, not the result.
    const shown = role === "tool" ? clean.split(" → ")[0] : clean;
    if (role === "jeff" && lastJeffLineRef.current === shown) return;
    lastJeffLineRef.current = role === "jeff" ? shown : null;
    console.log(`[jeff:${role}]`, clean);
    history.appendTurn(sessionRef.current, role, clean);
    setTranscript((t) => [...t, { role, text: shown }]);
    if (role !== "tool") trackTurn(role, clean);
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
    setSelection([]);
    setLens(wantLens ?? (technical || (h.skills?.length && !h.people.length) ? "skills" : "people"));
    setView("graph");
    setCanvasOpen(true);
  }, []);

  // The search box: everyone whose name has every typed word lights up on the map.
  const [find, setFind] = useState("");
  const findPeople = useCallback((q: string) => {
    setFind(q);
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const all = words.length ? (peopleRef.current ?? []).filter((p) => words.every((w) => p.name.toLowerCase().includes(w))) : [];
    // Stay on the lens the user is on. Skills only shows people with GitHub
    // work, so match those there; if none match, fall back to People.
    const onSkills = lensRef.current === "skills" ? all.filter((p) => p.commits > 0) : [];
    const hits = onSkills.length ? onSkills : all;
    if (hits.length) focus({ people: hits.map((p) => p.name), title: q.trim() }, onSkills.length ? "skills" : "people");
    else setHighlight(null);
  }, [focus]);

  const showScene = useCallback((scene: Scene, source: string) => {
    setBoard(scene);
    setView("board");
    setCanvasOpen(true);
    say("tool", `${source} → "${scene.title}" (${scene.steps.length} steps)`);
    tellJeffRef.current(describeScene(scene) + " The screen advances on its own. Give only the main takeaway; explain a step only if the viewer asks.");
  }, [say]);

  // ── Client tools: what Jeff can look up ──────────────────────────────────
  // (The closures read refs only when Jeff calls a tool, never during render.)
  // eslint-disable-next-line react-hooks/refs
  const clientTools = useMemo(() => withLogging({
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
    search_docs: async ({ query, product, limit }: { query: string; product?: string; limit?: number }) => {
      const [ds, ps] = await Promise.all([docsRef.current ?? loadDocs(), peopleRef.current ?? loadPeople()]);
      const passages = rankDocs(ds, String(query ?? ""), product, Math.min(6, Number(limit) || 5));
      const experts = rankExperts(ps, String(query ?? ""), 5);
      say("tool", `search_docs("${query}") → ${passages.length} passages, ${experts.length} people`);
      if (passages.length || experts.length) {
        setPanel({ kind: "docs", passages, experts });
        if (experts.length) focus({ people: experts.map((e) => e.person.name), title: `Docs: ${query}` });
      }
      if (!passages.length && !experts.length) return JSON.stringify({ result: "nothing in the curated docs slice or the Boston data on that", query });
      return JSON.stringify({
        query,
        doc_passages: passages.map((p) => passageSummary(p.passage)),
        people_who_know_this: experts.map((e) => ({ ...personSummary(e.person), evidence: e.evidence })),
      });
    },
    lookup_person: async ({ name }: { name: string }) => {
      const ps = peopleRef.current ?? await loadPeople();
      const p = findPerson(ps, String(name ?? ""));
      say("tool", `lookup_person("${name}") → ${p ? p.name : "not found"}`);
      if (!p) return JSON.stringify({ result: "not found in the Boston data", name });
      setPanel({ kind: "person", person: p });
      focus({ people: [p.name], title: p.name });
      // Full profiles (long bio, public links) are leadership-level; everyone else gets the card.
      return JSON.stringify(personSummary(p, accessRef.current === "leader"));
    },
    // No real Slack integration: this writes what Jeff drafted to the screen
    // and the clipboard so the user can paste and send it themselves.
    draft_slack_message: async ({ to, message }: { to: string; message: string }) => {
      const ps = peopleRef.current ?? await loadPeople();
      const p = findPerson(ps, String(to ?? ""));
      const toName = p?.name ?? String(to ?? "").trim();
      const text = String(message ?? "").trim();
      if (!toName || !text) return JSON.stringify({ result: "need both a recipient and message text" });
      let autoCopied = false;
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          autoCopied = true;
        }
      } catch { /* the Copy button on the card covers this */ }
      say("tool", `draft_slack_message("${toName}") → ${autoCopied ? "drafted, copied" : "drafted"}`);
      setPanel({ kind: "slack", toName, message: text, autoCopied });
      setCanvasOpen(true);
      if (p) focus({ people: [p.name], title: `Slack draft: ${p.name}` });
      return JSON.stringify({
        result: autoCopied ? "drafted and copied to the clipboard" : "drafted and on screen; clipboard auto-copy was blocked by the browser, there's a Copy button on the card",
        to: toName,
      });
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
      const sections = sectionOverview(ps, section);
      setPanel(null);
      // One section asked for: light up everyone in it, so the screen moves
      // before Jeff talks and the whole group is visible, not a sample.
      const one = section && sections.length === 1 ? sections[0] : null;
      if (one) {
        const names = ps.filter((p) => (p.section || "Community & alumni") === one.section).map((p) => p.name);
        focus({ people: names, title: `${one.section} · ${names.length} people` }, "people");
      } else {
        setHighlight(null); setSelection([]); setLens("people"); setView("graph"); setCanvasOpen(true);
      }
      if (section && !sections.length) {
        // An unknown name must not read as "the whole office": say so and list what exists.
        const known = [...new Set(ps.map((p) => p.section || "Community & alumni"))];
        return JSON.stringify({ result: `no section matches "${section}"`, sections_available: known, total_people: ps.length });
      }
      return JSON.stringify({ total_people: ps.length, sections, ...(one ? { on_screen: `all ${one.headcount} people in ${one.section} are highlighted on the graph now` } : {}) });
    },
    show_on_graph: ({ people: names, skills, section, title, lens: wantLens }: { people?: string[]; skills?: string[]; section?: string; title?: string; lens?: string }) => {
      const ps = peopleRef.current ?? [];
      const resolved = (names ?? []).map((n) => findPerson(ps, n)?.name ?? n);
      if (section) {
        for (const p of ps) if (sectionMatches(p.section || "Community & alumni", String(section))) resolved.push(p.name);
      }
      const l = wantLens === "people" || wantLens === "skills" ? wantLens : undefined;
      if (!resolved.length && !(skills ?? []).length) {
        setHighlight(null); setSelection([]); setView("graph"); setCanvasOpen(true);
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
          track("error", { where: "drawing_brain", message: msg });
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
      if (accessRef.current !== "leader") {
        const n = u.conversations.reduce((a, c) => a + c.queries.length, 0);
        return `${u.conversations.length} conversations and ${n} questions so far; the breakdown is a senior-leader view, keep it to the tally`;
      }
      return describeUsage(u, f ?? undefined);
    },
  }), [say, showScene, focus, board]);


  // ── The human's hand on the canvas ──
  // A pick focuses the graph and tells Jeff, as context rather than a
  // question, so he can fold it in without being forced to answer.
  const applySelectionEffects = useCallback((sel: Pick[]) => {
    const ps = peopleRef.current ?? [];
    if (!sel.length) { setHighlight(null); return; }
    const people = sel.filter((p) => p.type === "person");
    if (!people.length) {
      // A lone skill or section hub.
      const pick = sel[0];
      if (pick.id.startsWith("section:")) {
        // The hub's label is a short display name (e.g. "OpenShift & K8s");
        // team_overview needs the raw section string to match, since a
        // short label doesn't always substring-match the full one.
        const raw = pick.id.slice("section:".length);
        setHighlight(null);
        tellJeffRef.current(`The user just clicked the "${pick.label}" section hub on the org graph. They may want an overview of that group; team_overview("${raw}") answers it.`);
      } else {
        setHighlight({ skills: [pick.label], people: [], title: pick.label });
        tellJeffRef.current(`The user just clicked the "${pick.label}" skill area on the org graph; the people in it are now on screen. find_experts("${pick.label}") ranks them if they ask.`);
      }
      return;
    }
    const names = people.map((p) => p.label);
    setHighlight({ people: names, title: names.length === 1 ? names[0] : undefined });
    if (names.length === 1) {
      const p = findPerson(ps, names[0]);
      // Nobody without commits exists in the Skills lens; show them among their section instead.
      if (!(p?.commits ?? 0)) setLens("people");
      const who = p ? [p.role, sectionShort(p.section), p.commits ? `${p.commits} commits` : ""].filter(Boolean).join(", ") : "";
      tellJeffRef.current(`The user just clicked ${names[0]} on the org graph${who ? ` (${who})` : ""}. If it fits, mention them briefly or ask what they want to know; do not read out a profile unprompted.`);
    } else {
      tellJeffRef.current(`The user has ${names.length} people selected on the org graph: ${new Intl.ListFormat("en").format(names)}. They may ask about them as a group.`);
    }
  }, []);

  const toggle = useCallback((pick: Pick) => {
    const cur = selectionRef.current;
    const next = pick.type !== "person"
      ? (cur.length === 1 && cur[0].id === pick.id ? [] : [pick])
      : (() => {
          const peopleOnly = cur.filter((p) => p.type === "person");
          return peopleOnly.some((p) => p.id === pick.id) ? peopleOnly.filter((p) => p.id !== pick.id) : [...peopleOnly, pick];
        })();
    setSelection(next);
    track("canvas_pick", { type: pick.type, id: pick.id, label: pick.label, count: next.length, lens: lensRef.current });
    applySelectionEffects(next);
  }, [applySelectionEffects]);

  const onClearAll = useCallback(() => {
    setSelection([]);
    setHighlight(null);
    track("canvas_pick", { type: null, id: null, label: null, count: 0, lens: lensRef.current });
  }, []);

  // ── The conversation ─────────────────────────────────────────────────────
  const conversation = useConversation({
    clientTools,
    onConnect: ({ conversationId }) => {
      beginConversation(conversationId);
      track("conversation_started", { access: accessRef.current, user: userRef.current.trim() || "anonymous", lens: lensRef.current, drawing_brain: brainRef.current });
      setError(null); setTranscript([]); setEndedNote(null); setBoard(null); setView("graph"); handoffRef.current = false; lastJeffLineRef.current = null;
      const a = accessRef.current;
      sessionRef.current = history.startSession(ACCESS_LABEL[a]);
      setHistStats(history.historyStats());
      // The agent speaks its first line on its own; the screen notes wait a
      // beat so they do not land while that line is being generated.
      setTimeout(() => tellJeffRef.current(`Viewer access level: ${ACCESS_LABEL[a]} (${ACCESS_BLURB[a]}). The screen shows the ${lensRef.current === "people" ? "People lens (everyone, by section)" : "Skills lens (technical, from GitHub)"}; the user can click people and areas on it and you will be told.`), 2500);
      if (brainRef.current === "off") {
        setTimeout(() => tellJeffRef.current("Note: the drawing brain (board_explain) is offline in this build. Draw with board_write instead; it works fine."), 2800);
      }
      // A pending "Ask Jeff" click becomes the first real question.
      const pending = pendingAskRef.current;
      pendingAskRef.current = null;
      if (pending) setTimeout(() => { try { conversationRef.current?.sendUserMessage(pending); } catch { /* not ready */ } }, 3000);
    },
    onModeChange: ({ mode }) => {
      if (mode !== "speaking") return;
      setThinking(false);
      if (thinkingTimer.current) clearTimeout(thinkingTimer.current);
      // "Done" muted the mic to hand Jeff the floor; give it back once he talks.
      if (handoffRef.current) { handoffRef.current = false; try { conversationRef.current?.setMuted(false); } catch { /* fine */ } }
    },
    onMessage: ({ message, role }) => {
      const r = String(role);
      if (r === "user") say("user", message);
      else if (message) say("jeff", message);
    },
    onDisconnect: (details) => {
      history.endSession(sessionRef.current);
      sessionRef.current = null;
      setHistStats(history.historyStats());
      // Say why the line went quiet: hanging up looks different from Jeff timing out.
      const reason = (details as { reason?: string; message?: string } | undefined)?.reason;
      track("conversation_ended", { reason: reason ?? "unknown", message: (details as { message?: string } | undefined)?.message ?? null, turns: transcriptRef.current.filter((t) => t.role !== "tool").length });
      endConversation();
      setThinking(false);
      setEndedNote(reason === "user" ? "Conversation ended" : reason === "agent" ? "Jeff ended the conversation" : reason === "error" ? "The connection dropped" : "Conversation ended");
    },
    onError: (msg) => { track("error", { where: "conversation", message: String(msg) }); setError(typeof msg === "string" ? msg : "Something went wrong with the connection."); },
  });
  const { status, isSpeaking, isMuted, setMuted, startSession, endSession, sendUserMessage, sendUserActivity, sendContextualUpdate, getInputVolume, getOutputVolume } = conversation;
  const conversationRef = useRef<typeof conversation | null>(null);
  useEffect(() => { conversationRef.current = conversation; }, [conversation]);
  useEffect(() => {
    tellJeffRef.current = (text) => {
      if (status !== "connected") return;
      try { sendContextualUpdate(text); track("context", { kind: "update", text }); } catch { /* not connected */ }
    };
  }, [status, sendContextualUpdate]);

  const start = useCallback(async () => {
    if (!AGENT_ID) { setError("No agent configured yet. See the setup note on the right."); return; }
    setError(null);
    track("control", { action: "start", access: accessRef.current });
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      track("error", { where: "microphone" });
      setError("Microphone unavailable. Check the browser's mic permission.");
      return;
    }
    const who = userRef.current.trim() || "anonymous";
    const greeting = pickGreeting(who);
    startSession({
      agentId: AGENT_ID, connectionType: "webrtc", userId: who,
      dynamicVariables: { access_level: ACCESS_LABEL[accessRef.current], access_scope: ACCESS_BLURB[accessRef.current], user_name: who, greeting },
    });
  }, [startSession]);

  // "Ask Jeff" on a picked node, or the group bar: a real user turn if we
  // are talking, otherwise it starts the session and asks as soon as Jeff
  // is on the line.
  const pendingAskRef = useRef<string | null>(null);
  const onAsk = useCallback((picks: Pick[]) => {
    if (!picks.length) return;
    const q = picks.length > 1
      ? `I've selected ${new Intl.ListFormat("en").format(picks.map((p) => p.label))}. What should I know about them as a group?`
      : picks[0].type === "person" ? `Tell me about ${picks[0].label}.`
      : picks[0].id.startsWith("section:") ? `Give me the shape of the ${picks[0].label} group.`
      : `Who should I talk to about ${picks[0].label}?`;
    track("ask_jeff", { count: picks.length, labels: picks.map((p) => p.label), question: q, live: status === "connected" });
    if (status === "connected") { say("user", q); sendUserMessage(q); }
    else { pendingAskRef.current = q; void start(); }
  }, [status, sendUserMessage, start, say]);

  const mood: BlobMood = status === "connected" ? (isSpeaking ? "speaking" : thinking ? "thinking" : "listening") : status === "connecting" ? "connecting" : "dormant";

  // User activity is the SDK's interruption signal. Unlike an empty user
  // message, it stops the current response without inviting another one.
  const interrupt = useCallback(() => {
    track("control", { action: "interrupt" });
    handoffRef.current = false;
    setThinking(false);
    if (thinkingTimer.current) clearTimeout(thinkingTimer.current);
    setMuted(false);
    try { sendUserActivity(); } catch { /* not connected */ }
  }, [sendUserActivity, setMuted]);

  // "I'm done": hand Jeff the floor now instead of waiting for him to decide
  // the pause was long enough. The mic goes quiet until he starts talking.
  const done = useCallback(() => {
    track("control", { action: "done_speaking" });
    handoffRef.current = true;
    setMuted(true);
    think();
    try { sendUserMessage(""); } catch { /* not connected */ }
  }, [setMuted, sendUserMessage, think]);
  // The blob controls turns: finish the person's turn while listening, or
  // stop Jeff while he is responding. Hanging up is a separate visible action.
  const onTap = useCallback(() => {
    if (mood === "dormant") void start();
    else if (mood === "connecting") void endSession();
    else if (mood === "speaking" || mood === "thinking") interrupt();
    else done();
  }, [mood, start, endSession, interrupt, done]);

  const stop = useCallback(() => {
    track("control", { action: "end" });
    handoffRef.current = false;
    setThinking(false);
    setMuted(true);
    void endSession();
  }, [endSession, setMuted]);

  // Keyboard: Escape hangs up, Space cuts Jeff off or says "done" (unless typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "Escape" && status === "connected") { e.preventDefault(); stop(); }
      else if (e.key === " " && status === "connected") { e.preventDefault(); if (isSpeaking || thinking) interrupt(); else done(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [status, isSpeaking, thinking, stop, interrupt, done]);

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
        onClick={() => { track("control", { action: canvasOpen ? "hide_canvas" : "show_canvas" }); setCanvasOpen((o) => !o); }}
        aria-label={canvasOpen ? "Hide canvas" : "Show canvas"}
        title={canvasOpen ? "Hide canvas" : "Show canvas"}
      >
        {canvasOpen ? "›" : "‹"}
      </button>
      <section className="jeff-stage">
        {mood === "dormant" && !endedNote && transcript.length === 0 && (
          <div className="jeff-brand"><h1>Jeff</h1></div>
        )}
        <JeffBlob
          mood={mood}
          getLevel={getLevel}
          onTap={onTap}
          onEnd={stop}
          muted={isMuted}
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
            <span>{graph ? `${graph.nodes.filter((n) => n.type === "person").length} people · ${lens === "people" ? `${new Set(graph.nodes.filter((n) => n.type === "person").map((n) => n.section ?? "")).size} sections` : `${graph.nodes.filter((n) => n.type === "skill").length} skill areas`}` : ""}</span>
            {view === "graph" && (
              <div className="jeff-lens-switch" role="tablist" aria-label="Map view">
                <button type="button" role="tab" aria-selected={lens === "people"} onClick={() => { track("lens", { lens: "people" }); setFind(""); setHighlight(null); setSelection([]); setLens("people"); tellJeffRef.current("The user switched the map to People: everyone grouped by section."); }}>People</button>
                <button type="button" role="tab" aria-selected={lens === "skills"} onClick={() => { track("lens", { lens: "skills" }); setFind(""); setHighlight(null); setSelection([]); setLens("skills"); tellJeffRef.current("The user switched the map to Skills: the technical view from GitHub."); }}>Skills</button>
              </div>
            )}
          </div>
          <div className="jeff-panel-meta">
            <label className="jeff-access" title="Find people by name: matches light up on the map">
              <span>search</span>
              <input type="search" value={find} placeholder="find a person" onChange={(e) => findPeople(e.target.value)} spellCheck={false} />
            </label>
            <label className="jeff-access" title="Who is looking: gates what Jeff and the tools will share">
              <span>viewing as</span>
              <select value={access} onChange={(e) => chooseAccess(e.target.value as Access)}>
                {(Object.keys(ACCESS_LABEL) as Access[]).map((a) => <option key={a} value={a}>{ACCESS_LABEL[a]}</option>)}
              </select>
              <em className="jeff-access-hint">{ACCESS_HINT[access]}</em>
            </label>
          </div>
        </div>
        {view === "usage" ? (
          <>
            <UsageSankey usage={usage} focus={usageFocus} onFocus={(label) => { track("usage_focus", { label }); setUsageFocus(label); tellJeffRef.current(label ? `On the usage view the user clicked "${label}"; the flows through it are highlighted.` : "The user cleared the usage filter."); }} />
            <button type="button" className="jeff-back" onClick={() => { track("view", { view: "graph" }); setView("graph"); }}>back to the map</button>
          </>
        ) : view === "board" && board ? (
          <Whiteboard
            scene={board}
            onDone={() => tellJeffRef.current(`The whiteboard "${board.title}" is fully drawn.`)}
            onClear={() => { track("control", { action: "clear_board" }); setBoard(null); setView("graph"); }}
          />
        ) : view === "board" && boardBusy ? (
          <div className="wb"><div className="wb-busy">sketching “{boardBusy}”…</div></div>
        ) : (<>
          {(board || (access === "leader" && usage && usage.conversations.length > 0)) && (
            <div className="jeff-back-row">
              {board && <button type="button" className="jeff-back" onClick={() => { track("view", { view: "board" }); setView("board"); }}>whiteboard</button>}
              {access === "leader" && usage && usage.conversations.length > 0 && <button type="button" className="jeff-back" onClick={() => { track("view", { view: "usage" }); setView("usage"); tellJeffRef.current("The user opened the Usage view: a Sankey of what people have asked you, by access level, kind, topic and outcome, with a leaderboard of topics."); }}>what people ask</button>}
            </div>
          )}
          <OrgGraph graph={graph} people={people} highlight={highlight} lens={lens} selection={selection} onToggle={toggle} onClearAll={onClearAll} onAsk={onAsk} onClear={() => { track("control", { action: "clear_graph" }); setHighlight(null); setSelection([]); }} />
        </>)}
        {panel?.kind === "experts" && <ExpertCards ranked={panel.ranked} />}
        {panel?.kind === "impact" && <ImpactCards report={panel.report} />}
        {panel?.kind === "docs" && <DocCards passages={panel.passages} experts={panel.experts} />}
        {panel?.kind === "person" && <PersonCard person={panel.person} showEvidence={access !== "new"} showLinks={access === "leader"} />}
        {panel?.kind === "slack" && <SlackDraftCard toName={panel.toName} message={panel.message} autoCopied={panel.autoCopied} />}
        {dev && <div className="jeff-history">
          {histStats && histStats.sessions > 0 ? (
            <>
              <span>{histStats.sessions} saved {histStats.sessions === 1 ? "conversation" : "conversations"} · {histStats.turns} turns</span>
              <button type="button" onClick={() => history.downloadHistory()}>Download transcripts</button>
              <a href={`${BASE}/xray`}>x-ray all conversations</a>
              <span>{analyticsOn() ? "logging to PostHog" : "PostHog off (no NEXT_PUBLIC_POSTHOG_KEY)"}</span>
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
