"use client";

import type { AtRiskArea, ImpactReport, Person, ScoredPerson } from "@/lib/jeffData";
import type { ScoredPassage } from "@/lib/docsData";

export function PersonCard({ person: p, showEvidence, showLinks }: { person: Person; showEvidence: boolean; showLinks: boolean }) {
  const evidence = [
    ...p.top_repos.slice(0, 2).map((repo) => `${repo.commits} commits to ${repo.repo}`),
    ...p.skills.slice(0, 2).map((skill) => `${skill.skill} · ${Math.round(skill.score * 100)}% of GitHub work`),
  ].slice(0, 3);

  return (
    <div className="jeff-cards jeff-cards--person">
      <article className="jeff-card">
        <div className="jeff-card-rank">PROFILE</div>
        <h3>{p.name}</h3>
        <div className="jeff-card-role">{p.role || p.section}</div>
        {p.section && <div className="jeff-card-section">{p.section}</div>}
        {showEvidence && evidence.length > 0 && <ul>{evidence.map((item) => <li key={item}>{item}</li>)}</ul>}
        {showLinks && (p.url || p.linkedin) && (
          <div className="jeff-card-links">
            {p.url && <a href={p.url} target="_blank" rel="noreferrer">GitHub</a>}
            {p.linkedin && <a href={p.linkedin} target="_blank" rel="noreferrer">LinkedIn</a>}
          </div>
        )}
      </article>
    </div>
  );
}

export function ExpertCards({ ranked }: { ranked: ScoredPerson[] }) {
  if (!ranked.length) return null;
  return (
    <div className="jeff-cards">
      {ranked.map(({ person: p, evidence }, i) => (
        <article className="jeff-card" key={p.id} style={{ animationDelay: `${i * 60}ms` }}>
          <div className="jeff-card-rank">#{i + 1}</div>
          <h3>{p.name}</h3>
          <div className="jeff-card-role">{p.role || p.section || (p.login ? `@${p.login}` : "")}</div>
          <ul>
            {evidence.slice(0, 3).map((e) => <li key={e}>{e}</li>)}
          </ul>
          {(p.url || p.linkedin) && (
            <div style={{ marginTop: 8, display: "flex", gap: 10 }}>
              {p.url && <a href={p.url} target="_blank" rel="noreferrer">GitHub</a>}
              {p.linkedin && <a href={p.linkedin} target="_blank" rel="noreferrer">LinkedIn</a>}
            </div>
          )}
        </article>
      ))}
    </div>
  );
}

export function ImpactCards({ report }: { report: ImpactReport }) {
  const shown = report.areas.slice(0, 8);
  return (
    <div className="jeff-cards">
      {shown.map((a, i) => <RiskCard key={`${a.kind}:${a.area}`} area={a} delay={i * 60} />)}
    </div>
  );
}

/** Doc passages from search_docs, plus the Boston people who know the same topic. */
export function DocCards({ passages, experts }: { passages: ScoredPassage[]; experts: ScoredPerson[] }) {
  if (!passages.length && !experts.length) return null;
  return (
    <div className="jeff-cards">
      {passages.map(({ passage: p }, i) => (
        <article className="jeff-card" key={`${p.url}:${i}`} style={{ animationDelay: `${i * 60}ms` }}>
          <div className="jeff-card-role">{p.book}</div>
          <h3>{p.section}</h3>
          <p style={{ margin: "6px 0 8px", fontSize: 13, lineHeight: 1.4 }}>{p.text.slice(0, 220)}{p.text.length > 220 ? "…" : ""}</p>
          <a href={p.url} target="_blank" rel="noreferrer">docs.redhat.com</a>
        </article>
      ))}
      {experts.map(({ person: p, evidence }, i) => (
        <article className="jeff-card" key={p.id} style={{ animationDelay: `${(passages.length + i) * 60}ms` }}>
          <div className="jeff-card-rank">who knows this</div>
          <h3>{p.name}</h3>
          <div className="jeff-card-role">{p.role || p.section || (p.login ? `@${p.login}` : "")}</div>
          <ul>{evidence.slice(0, 2).map((e) => <li key={e}>{e}</li>)}</ul>
        </article>
      ))}
    </div>
  );
}

function RiskCard({ area, delay }: { area: AtRiskArea; delay: number }) {
  const cls = area.status === "fine" ? "jeff-risk-status jeff-risk-status--fine" : area.status === "thin" ? "jeff-risk-status jeff-risk-status--thin" : "jeff-risk-status";
  return (
    <article className={`jeff-card jeff-risk${area.status === "fine" ? " jeff-risk--fine" : ""}`} style={{ animationDelay: `${delay}ms` }}>
      <span className={cls}>{area.status === "single-point" ? "single point of failure" : area.status}</span>
      <h3 style={{ marginTop: 6 }}>{area.area}</h3>
      <div className="jeff-card-role">loses {area.moved.join(", ")}</div>
      <ul>
        {area.remaining.length === 0 && <li>Nobody else in Boston has this footprint.</li>}
        {area.remaining.slice(0, 3).map((r) => (
          <li key={r.name}>{r.name} stays{area.kind === "repo" ? ` (${r.strength} commits)` : ""}</li>
        ))}
      </ul>
      {area.backfill && <div className="jeff-risk-backfill">Backfill: {area.backfill.name}, {area.backfill.why}.</div>}
    </article>
  );
}
