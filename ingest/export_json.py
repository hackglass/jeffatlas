#!/usr/bin/env python3
"""Export the data Jeff's browser client needs.

Reads data/boston_people.csv and data/redhat.db, writes:
    src/public/data/people.json   Boston Red Hat people with inferred skills
    src/public/data/graph.json    person / skill / repo nodes + edges for the org graph

Skill inference reuses skills.py (same scoring, same skill areas).

    python3 ingest/export_json.py
"""
import csv
import json
import math
import sqlite3
from collections import defaultdict
from pathlib import Path

from sections import refine
from skills import repo_signals

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "data" / "boston_people.csv"
DB_PATH = ROOT / "data" / "redhat.db"
ENRICH_PATH = ROOT / "data" / "github_enrichment.json"   # from enrich_github.py
OUT_DIR = ROOT / "src" / "public" / "data"


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    repos = {r[0]: r for r in db.execute(
        "SELECT full_name, org, description, language, topics, langs FROM repos WHERE done=1")}
    signals = {name: repo_signals(r) for name, r in repos.items()}

    gh = defaultdict(lambda: {"skills": defaultdict(float), "repos": [], "langs": defaultdict(float), "commits": 0})
    for login, repo, n in db.execute("SELECT login, repo, n FROM contributions"):
        if repo not in repos:
            continue
        p = gh[login.lower()]
        w = math.log1p(n)
        p["commits"] += n
        p["repos"].append((repo, n))
        for sk, strength in signals[repo].items():
            p["skills"][sk] += w * strength
        langs = json.loads(repos[repo][5] or "{}")
        tot = sum(langs.values()) or 1
        for l, b in langs.items():
            p["langs"][l] += w * b / tot

    # GitHub-only people have no CRM row, so no role or section. enrich_github.py
    # researched them (bio, company, orgs, pinned repos, README) and inferred both.
    enrich = json.loads(ENRICH_PATH.read_text()) if ENRICH_PATH.exists() else {}

    people = []
    with CSV_PATH.open(newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            login = (row.get("login") or "").strip()
            gh_login = None if login.startswith("crm:") else login
            g = gh.get(gh_login.lower()) if gh_login else None
            skills, top_repos, langs, commits = [], [], [], 0
            if g:
                top = sorted(g["skills"].items(), key=lambda kv: -kv[1])
                best = top[0][1] if top else 1
                skills = [{"skill": k, "score": round(v / best, 2)} for k, v in top[:5] if v / best >= 0.25]
                top_repos = [{"repo": r, "commits": n} for r, n in sorted(g["repos"], key=lambda x: -x[1])[:6]]
                langs = [l for l, _ in sorted(g["langs"].items(), key=lambda kv: -kv[1])[:4]]
                commits = g["commits"]
            name = (row.get("name") or "").strip() or gh_login or login
            e = enrich.get(login, {}) if not (row.get("role") and row.get("section")) else {}
            role = row.get("role") or e.get("role") or ""
            bio = row.get("bio") or e.get("bio") or ""
            broad = row.get("section") or e.get("section") or ""
            section = refine(login, broad, role, bio, skills[0]["skill"] if skills else None)
            people.append({
                "id": login or name,
                "name": name,
                "login": gh_login,
                "role": role,
                "section": section,
                "affiliation": "red_hat" if row.get("section") else (e.get("affiliation") or "unknown"),
                "company": (row.get("company") or e.get("company") or "").lstrip("@"),
                "location": row.get("location") or "",
                "bio": bio,
                "profile": row.get("profile") or "",
                "linkedin": row.get("linkedin") or "",
                "url": row.get("url") or "",
                "blog": row.get("blog") or e.get("website") or "",
                "github_orgs": e.get("github_orgs") or [],
                "pinned": e.get("pinned") or [],
                "sources": row.get("sources") or "",
                "commits": commits,
                "skills": skills,
                "languages": langs,
                "top_repos": top_repos,
            })

    people.sort(key=lambda p: (-p["commits"], p["name"].lower()))
    (OUT_DIR / "people.json").write_text(json.dumps(people, ensure_ascii=False))

    nodes, edges, seen = [], [], set()

    def node(id_, kind, label, **kw):
        if id_ not in seen:
            seen.add(id_)
            nodes.append({"id": id_, "type": kind, "label": label, **kw})

    for p in people:
        pid = f"person:{p['id']}"
        node(pid, "person", p["name"], section=p["section"], role=p["role"], commits=p["commits"])
        for s in p["skills"]:
            node(f"skill:{s['skill']}", "skill", s["skill"])
            edges.append({"source": pid, "target": f"skill:{s['skill']}", "weight": s["score"]})
        for r in p["top_repos"][:3]:
            node(f"repo:{r['repo']}", "repo", r["repo"])
            edges.append({"source": pid, "target": f"repo:{r['repo']}", "weight": r["commits"]})
    (OUT_DIR / "graph.json").write_text(json.dumps({"nodes": nodes, "edges": edges}))

    with_skills = sum(1 for p in people if p["skills"])
    print(f"{len(people)} people ({with_skills} with GitHub skill profiles) -> {OUT_DIR}")
    print(f"{len(nodes)} graph nodes, {len(edges)} edges")


if __name__ == "__main__":
    main()
