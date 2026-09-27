/**
 * Jeff's data layer, entirely in the browser.
 *
 * The ElevenLabs agent calls these as *client tools*: the agent decides it
 * needs facts, the SDK invokes the matching function here, and the string we
 * return goes back into the model's context. No server, no keys in the page.
 *
 * Data comes from /data/people.json and /data/graph.json, exported by
 * ingest/export_json.py from boston_people.csv + redhat.db.
 */

export type Skill = { skill: string; score: number };
export type RepoStat = { repo: string; commits: number };
export type Person = {
  id: string;
  name: string;
  login: string | null;
  role: string;
  section: string;
  location: string;
  bio: string;
  profile: string;
  linkedin: string;
  url: string;
  blog: string;
  sources: string;
  commits: number;
  skills: Skill[];
  languages: string[];
  top_repos: RepoStat[];
};

export type GraphNode = { id: string; type: "person" | "skill" | "repo"; label: string; section?: string; role?: string; commits?: number };
export type GraphEdge = { source: string; target: string; weight: number };
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

let peopleCache: Person[] | null = null;
let graphCache: Graph | null = null;

const base = () => (process.env.NEXT_PUBLIC_BASE_PATH ?? "");

export async function loadPeople(): Promise<Person[]> {
  if (peopleCache) return peopleCache;
  const res = await fetch(`${base()}/data/people.json`);
  peopleCache = (await res.json()) as Person[];
  return peopleCache;
}

export async function loadGraph(): Promise<Graph> {
  if (graphCache) return graphCache;
  const res = await fetch(`${base()}/data/graph.json`);
  graphCache = (await res.json()) as Graph;
  return graphCache;
}

// ── Matching ────────────────────────────────────────────────────────────────

/** Loose synonyms so "k8s" finds the Cloud / Kubernetes skill, etc. */
const SYNONYMS: Record<string, string[]> = {
  kubernetes: ["k8s", "openshift", "cluster", "operator", "cloud", "provisioning"],
  openshift: ["kubernetes", "cluster", "ocp"],
  ai: ["ml", "llm", "vllm", "model", "inference", "instructlab", "granite", "data science", "machine learning"],
  vllm: ["inference", "llm", "ai", "serving"],
  storage: ["ceph", "rook", "csi", "s3"],
  security: ["keycloak", "auth", "identity", "oidc", "sso", "cve", "compliance"],
  auth: ["keycloak", "identity", "oidc", "sso", "security"],
  payments: ["billing", "commerce", "subscription"],
  java: ["quarkus", "jvm"],
  quarkus: ["java", "jvm"],
  ansible: ["automation", "playbook", "awx"],
  virtualization: ["kubevirt", "vm", "kvm", "libvirt"],
  observability: ["prometheus", "grafana", "monitoring", "metrics", "logging"],
  frontend: ["react", "typescript", "ui", "patternfly", "console"],
  go: ["golang", "backend"],
  linux: ["rhel", "fedora", "kernel", "os", "bootc"],
  leadership: ["director", "vp", "manager", "cto", "ceo", "chief"],
  docs: ["documentation", "writer", "technical writer"],
  product: ["product manager", "pm", "roadmap"],
};

function terms(topic: string): string[] {
  const raw = topic.toLowerCase().replace(/[^a-z0-9+#./ -]/g, " ").split(/\s+/).filter((t) => t.length > 1);
  const stop = new Set(["the", "and", "who", "has", "have", "with", "for", "in", "on", "of", "most", "best", "deepest", "experience", "expert", "experts", "knows", "about", "someone", "people", "person", "engineer", "engineers", "infrastructure", "team", "our", "at", "red", "hat", "boston"]);
  const out = new Set<string>();
  for (const t of raw) {
    if (stop.has(t)) continue;
    out.add(t);
    for (const s of SYNONYMS[t] ?? []) out.add(s);
  }
  return [...out];
}

function contains(hay: string, needle: string): boolean {
  return hay.toLowerCase().includes(needle);
}

export type ScoredPerson = { person: Person; score: number; evidence: string[] };

/** Rank Boston people for a topic, with the evidence behind each rank. */
export function rankExperts(people: Person[], topic: string, limit = 5): ScoredPerson[] {
  const ts = terms(topic);
  if (!ts.length) return [];
  const scored: ScoredPerson[] = [];
  for (const p of people) {
    let score = 0;
    const evidence: string[] = [];
    for (const t of ts) {
      for (const s of p.skills) {
        if (contains(s.skill, t)) {
          score += 3 * s.score;
          evidence.push(`skill: ${s.skill} (${Math.round(s.score * 100)}% of their GitHub footprint)`);
        }
      }
      for (const r of p.top_repos) {
        if (contains(r.repo, t)) {
          score += 2 + Math.log10(1 + r.commits);
          evidence.push(`${r.commits} commits to ${r.repo}`);
        }
      }
      if (contains(p.role, t)) { score += 2.5; evidence.push(`role: ${p.role}`); }
      if (contains(p.section, t)) { score += 1; }
      if (contains(p.bio, t)) { score += 1.5; evidence.push(`bio mentions "${t}"`); }
      if (contains(p.profile, t)) { score += 1.2; evidence.push(`profile mentions "${t}"`); }
    }
    if (score > 0) {
      score += Math.min(2, Math.log10(1 + p.commits) * 0.5);
      scored.push({ person: p, score, evidence: [...new Set(evidence)].slice(0, 5) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function findPerson(people: Person[], name: string): Person | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const exact = people.find((p) => p.name.toLowerCase() === n || (p.login ?? "").toLowerCase() === n);
  if (exact) return exact;
  const parts = n.split(/\s+/);
  const partial = people.filter((p) => parts.every((part) => p.name.toLowerCase().includes(part)));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) return partial.sort((a, b) => b.commits - a.commits)[0];
  const first = people.filter((p) => p.name.toLowerCase().startsWith(parts[0]));
  return first.length ? first.sort((a, b) => b.commits - a.commits)[0] : null;
}

// ── Impact analysis ─────────────────────────────────────────────────────────

export type AtRiskArea = {
  area: string;
  kind: "skill" | "repo";
  moved: string[];
  remaining: { name: string; strength: number }[];
  status: "unowned" | "single-point" | "thin" | "fine";
  backfill: { name: string; why: string } | null;
};

export type ImpactReport = {
  moved: string[];
  unknown: string[];
  areas: AtRiskArea[];
  summary: string;
};

/** What breaks if these people leave their current work. */
export function impactOfMoving(people: Person[], names: string[]): ImpactReport {
  const moved: Person[] = [];
  const unknown: string[] = [];
  for (const n of names) {
    const p = findPerson(people, n);
    if (p) moved.push(p); else unknown.push(n);
  }
  const movedIds = new Set(moved.map((p) => p.id));
  const areas: AtRiskArea[] = [];

  const skillAreas = new Map<string, Person[]>();
  const repoAreas = new Map<string, Person[]>();
  for (const p of moved) {
    for (const s of p.skills) if (s.score >= 0.5) skillAreas.set(s.skill, [...(skillAreas.get(s.skill) ?? []), p]);
    // Only repos the mover actually carries; a handful of drive-by commits is not ownership.
    for (const r of p.top_repos.slice(0, 3)) if (r.commits >= 20) repoAreas.set(r.repo, [...(repoAreas.get(r.repo) ?? []), p]);
  }

  const build = (area: string, kind: "skill" | "repo", movers: Person[]) => {
    const remaining = people
      .filter((p) => !movedIds.has(p.id))
      .map((p) => {
        const strength = kind === "skill"
          ? (p.skills.find((s) => s.skill === area)?.score ?? 0)
          : (p.top_repos.find((r) => r.repo === area)?.commits ?? 0);
        return { name: p.name, strength };
      })
      .filter((r) => r.strength > 0)
      .sort((a, b) => b.strength - a.strength);
    const strong = remaining.filter((r) => (kind === "skill" ? r.strength >= 0.5 : r.strength >= 10));
    const status: AtRiskArea["status"] = remaining.length === 0 ? "unowned"
      : strong.length === 1 ? "single-point" : strong.length <= 3 ? "thin" : "fine";
    const top = remaining[0];
    const backfill = top && status !== "fine"
      ? { name: top.name, why: kind === "skill" ? `strongest remaining ${area} profile` : `${top.strength} commits to ${area}` }
      : null;
    areas.push({ area, kind, moved: movers.map((m) => m.name), remaining: remaining.slice(0, 4), status, backfill });
  };
  for (const [area, movers] of skillAreas) build(area, "skill", movers);
  for (const [area, movers] of repoAreas) build(area, "repo", movers);

  const order = { unowned: 0, "single-point": 1, thin: 2, fine: 3 };
  areas.sort((a, b) => order[a.status] - order[b.status]);
  const risky = areas.filter((a) => a.status !== "fine");
  const summary = risky.length
    ? `${risky.length} area(s) at risk: ${risky.slice(0, 4).map((a) => `${a.area} (${a.status})`).join(", ")}`
    : "No area loses its last strong expert. This move is safe on the data we have.";
  return { moved: moved.map((p) => p.name), unknown, areas, summary };
}

// ── Compact serializers for the model ───────────────────────────────────────

export function personSummary(p: Person, full = false): Record<string, unknown> {
  return {
    name: p.name,
    role: p.role || undefined,
    section: p.section || undefined,
    github: p.login || undefined,
    commits: p.commits || undefined,
    skills: p.skills.map((s) => s.skill),
    top_repos: p.top_repos.slice(0, full ? 6 : 3).map((r) => `${r.repo} (${r.commits})`),
    languages: p.languages.length ? p.languages : undefined,
    bio: p.bio ? p.bio.slice(0, full ? 400 : 140) : undefined,
    profile: full && p.profile ? p.profile.slice(0, 900) : undefined,
    linkedin: full && p.linkedin ? p.linkedin : undefined,
  };
}

export function sectionOverview(people: Person[], section?: string) {
  const groups = new Map<string, Person[]>();
  for (const p of people) {
    const key = p.section || "Unlabeled (GitHub only)";
    if (section && !key.toLowerCase().includes(section.toLowerCase())) continue;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups.entries()].map(([name, ps]) => ({
    section: name,
    headcount: ps.length,
    notable: ps.slice(0, 6).map((p) => `${p.name}${p.role ? ` — ${p.role}` : ""}`),
    top_skills: topSkills(ps, 4),
  }));
}

function topSkills(ps: Person[], n: number): string[] {
  const c = new Map<string, number>();
  for (const p of ps) for (const s of p.skills) c.set(s.skill, (c.get(s.skill) ?? 0) + s.score);
  return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}
