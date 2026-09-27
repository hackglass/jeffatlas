#!/usr/bin/env python3
"""Research the GitHub-only people (the ones with no CRM row, so no role and no
section) and give each a plain-language role, a section, and an affiliation.

Pulls, through the gh CLI (already logged in): company, bio, website, org
memberships, pinned repos and the profile README. Then infers:

    role        one line saying what they do: title from the bio when there is
                one, otherwise built from their skills and top repos
    section     one of the four org sections when the evidence supports it
    affiliation red_hat | alumni | external | student | unknown

Writes data/github_enrichment.json; export_json.py merges it into people whose
CSV row has no role/section. Re-run after fetch_people.py adds people.

    python3 ingest/enrich_github.py
    python3 ingest/export_json.py
"""
import csv
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "data" / "boston_people.csv"
OUT = ROOT / "data" / "github_enrichment.json"

PLATFORM = "Platform / infrastructure engineering, QA, SRE"
PRODUCT = "Product, UX, docs, marketing, sales, GTM, ops"
AI = "AI / ML research, engineering, data science"
LEADERSHIP = "Leadership"

RH_ORGS = {"openshift", "redhat-developer", "red-hat-data-services", "opendatahub-io", "kubevirt", "ansible",
           "containers", "operator-framework", "openshift-pipelines", "stolostron", "open-cluster-management-io",
           "red-hat-storage", "quarkusio", "keycloak", "patternfly", "cockpit-project", "coreos", "osbuild",
           "ceph", "rook", "instructlab", "vllm-project", "llm-d", "redhat-cop", "redhatofficial", "rhel-lightspeed",
           "openshift-kni", "openshift-eng", "redhat-plumbers", "fedora-infra", "theforeman", "ovirt", "kiali",
           "strimzi", "apicurio", "3scale", "hyperfoil", "samba-in-kubernetes", "openshift-helm-charts", "kube-burner"}

TITLE_RE = re.compile(
    r"\b((?:senior |sr\.? |principal |staff |lead |distinguished |associate |junior |chief |head of |vp of |director of )?"
    r"(?:site reliability engineer|sre|software engineer|software developer|software engineering leader|technical writer|"
    r"engineering manager|ops engineering manager|product manager|program manager|ux designer|product designer|designer|"
    r"developer advocate|solutions? engineer|solutions? architect|architect|data scientist|machine learning engineer|"
    r"ml engineer|ai engineer|research scientist|researcher|quality engineer|qe|devops engineer|cloud engineer|"
    r"security engineer|front ?end developer|backend developer|full ?stack developer|intern|cto|founder|maintainer|"
    r"partner engineer|consultant|engineer))\b", re.I)

STUDENT_RE = re.compile(r"\b(student|phd|grad(uate)? student|undergrad|university|alumni|csail|@ (mit|umass|northeastern|bu|harvard)|"
                        r"senior in |cs @|umass|college|institute of technology)\b", re.I)
ALUMNI_RE = re.compile(r"\b(former(ly)?|ex-?|previously|prev\.?|past)\b[^.|]{0,40}red ?hat|red ?hat[^.|]{0,20}\b(alum|alumni)\b|red ?hat\s*(-->|→|->)", re.I)
RH_RE = re.compile(r"\bred ?hat\b|@redhatofficial|@redhat-", re.I)
OTHER_CO_RE = re.compile(r"\b(?:@|at )(ibm|nvidia|google|aws|amazon|microsoft|datadog|mirakl|meta|apple|stripe|intel|oracle|cisco|vmware|broadcom)\b", re.I)
MANAGER_RE = re.compile(r"\b(manager|director|vp\b|head of|cto|chief|engineering leader|team lead|lead designer|founder)\b", re.I)
DOCS_UX_RE = re.compile(r"\b(technical writer|writer|documentation|docs|ux|designer|design|developer advocate|advocate|"
                        r"technical marketing|marketing|product manager|solutions? (engineer|architect)|customer|sales)\b", re.I)
AI_RE = re.compile(r"\b(machine learning|ml\b|ai\b|llm|language model|data scien|deep learning|neural|nlp|vllm|instructlab|"
                   r"opendatahub|rhods|kubeflow|pytorch|agentic)\b", re.I)
DOC_REPO_RE = re.compile(r"-docs?$|documentation|/docs", re.I)


def gh_graphql(query, variables=None):
    cmd = ["gh", "api", "graphql", "-f", f"query={query}"]
    for k, v in (variables or {}).items():
        cmd += ["-f", f"{k}={v}"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    # gh exits non-zero on partial errors (e.g. no profile README) but still prints data.
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        raise SystemExit(f"gh api failed: {r.stderr[:300]}")


def fetch(logins):
    out = {}
    for i in range(0, len(logins), 20):
        chunk = logins[i:i + 20]
        parts = []
        for j, login in enumerate(chunk):
            parts.append(
                f'u{j}: user(login:"{login}"){{ login name company bio websiteUrl '
                f'organizations(first:20){{nodes{{login}}}} '
                f'pinnedItems(first:6,types:REPOSITORY){{nodes{{... on Repository{{nameWithOwner description}}}}}} '
                f'repository(name:"{login}"){{object(expression:"HEAD:README.md"){{... on Blob{{text}}}}}} }}')
        data = gh_graphql("query { " + " ".join(parts) + " }").get("data") or {}
        for j, login in enumerate(chunk):
            u = data.get(f"u{j}")
            if not u:
                continue
            readme = ((u.get("repository") or {}).get("object") or {}).get("text") or ""
            out[login] = {
                "name": u.get("name") or "",
                "company": u.get("company") or "",
                "bio": u.get("bio") or "",
                "website": u.get("websiteUrl") or "",
                "orgs": [o["login"] for o in (u.get("organizations") or {}).get("nodes") or []],
                "pinned": [{"repo": p["nameWithOwner"], "about": p.get("description") or ""} for p in (u.get("pinnedItems") or {}).get("nodes") or []],
                "readme": re.sub(r"\s+", " ", re.sub(r"<[^>]+>|!\[[^\]]*\]\([^)]*\)|\[([^\]]*)\]\([^)]*\)", r"\1", readme))[:600],
            }
        print(f"fetched {min(i + 20, len(logins))}/{len(logins)}")
    return out


def affiliation(row, gh):
    text = " ".join([gh["company"], gh["bio"], gh["readme"], row.get("bio") or ""])
    company = gh["company"] or row.get("company") or ""
    if ALUMNI_RE.search(text):
        return "alumni"
    says_rh = bool(RH_RE.search(gh["bio"]) or RH_RE.search(row.get("bio") or "") or row.get("says_red_hat") == "True")
    if company and not re.search(r"red ?hat|jboss", company, re.I):
        # The company field names somewhere else: IBM is Red Hat's parent (keep them
        # in the org picture), a school is a student, anything else is external, or
        # alumni when their own words still mention Red Hat.
        if re.search(r"\bibm\b", company, re.I):
            return "ibm"
        if STUDENT_RE.search(company):
            return "student"
        return "alumni" if says_rh else "external"
    if RH_RE.search(company) or says_rh:
        return "red_hat"
    m = OTHER_CO_RE.search(gh["bio"])
    if m:
        return "ibm" if m.group(1).lower() == "ibm" else "external"
    if STUDENT_RE.search(text):
        return "student"
    rh_orgs = [o for o in gh["orgs"] if o.lower() in RH_ORGS]
    if len(rh_orgs) >= 2:
        return "red_hat"
    return "unknown"


def title_from_bio(gh, row):
    for src in (gh["bio"], row.get("bio") or "", gh["readme"]):
        m = TITLE_RE.search(src)
        if m:
            t = m.group(1).strip()
            t = re.sub(r"\bsre\b", "SRE", t, flags=re.I)
            t = re.sub(r"\bqe\b", "quality engineer", t, flags=re.I)
            t = re.sub(r"\bcto\b", "CTO", t, flags=re.I)
            t = re.sub(r"\bml\b", "ML", t, flags=re.I)
            t = re.sub(r"\bai\b", "AI", t, flags=re.I)
            t = re.sub(r"\bux\b", "UX", t, flags=re.I)
            return t[0].upper() + t[1:]
    return ""


def describe_work(person, gh):
    """'works on Ceph and go-ceph' from the top repos; skill area as fallback."""
    repos = [r["repo"] for r in person["top_repos"][:3]]
    names = []
    for r in repos:
        short = r.split("/")[-1]
        if short not in names:
            names.append(short)
    skills = [s["skill"] for s in person["skills"][:2]]
    if names:
        return "works on " + (", ".join(names[:-1]) + " and " + names[-1] if len(names) > 1 else names[0])
    if skills:
        return skills[0].split(" (")[0].lower()
    return ""


def pick_section(person, gh, row, title):
    text = " ".join([title, gh["bio"], row.get("bio") or "", gh["readme"], " ".join(p["about"] for p in gh["pinned"])])
    skills = [s["skill"] for s in person["skills"]]
    repos = [r["repo"] for r in person["top_repos"][:3]]
    if MANAGER_RE.search(title) and not re.search(r"\b(founder|cto)\b", title, re.I):
        return LEADERSHIP
    if DOCS_UX_RE.search(title) or all(DOC_REPO_RE.search(r) for r in repos if r) and repos:
        return PRODUCT
    if skills and skills[0] == "AI / ML" or AI_RE.search(title) or (AI_RE.search(text) and "AI / ML" in skills[:3]):
        return AI
    if DOCS_UX_RE.search(text) and not skills:
        return PRODUCT
    if skills or repos:
        return PLATFORM
    return ""


def main():
    people = {p["login"]: p for p in json.loads((ROOT / "src/public/data/people.json").read_text()) if p.get("login")}
    rows = {r["login"]: r for r in csv.DictReader(CSV_PATH.open(newline="", encoding="utf-8"))}
    targets = [l for l, r in rows.items() if not r.get("section") and not l.startswith("crm:") and l in people]
    print(f"{len(targets)} GitHub-only people to research")
    gh_data = fetch(targets)

    result = {}
    for login in targets:
        row, person = rows[login], people[login]
        gh = gh_data.get(login) or {"name": "", "company": "", "bio": "", "website": "", "orgs": [], "pinned": [], "readme": ""}
        aff = affiliation(row, gh)
        title = title_from_bio(gh, row)
        work = describe_work(person, gh)
        if title and work:
            role = f"{title}; {work}"
        elif title:
            role = title
        elif work:
            role = ("Contributor" if aff in ("alumni", "external", "student", "unknown") else "Engineer") + f", {work}"
        else:
            role = ""
        company = gh["company"] or row.get("company") or ""
        company = re.sub(r"^@", "", company).strip()
        if aff == "alumni":
            role = (role + "; " if role else "") + "former Red Hat" + (f", now at {company}" if company and not RH_RE.search(company) else "")
        elif aff == "external":
            named = company and not re.match(r"^(ex\b|a |an )", company, re.I)
            role = (role + "; " if role else "") + (f"at {company}, not Red Hat" if named else "not Red Hat staff")
        elif aff == "ibm":
            role = (role + "; " if role else "") + "at IBM"
        elif aff == "student":
            role = (role + "; " if role else "") + "student / early career"
        section = pick_section(person, gh, row, title) if aff in ("red_hat", "ibm", "unknown") else ""
        result[login] = {
            "role": role,
            "section": section,
            "affiliation": aff,
            "company": company,
            "bio": gh["bio"] or row.get("bio") or "",
            "github_orgs": gh["orgs"][:12],
            "pinned": gh["pinned"][:4],
            "readme": gh["readme"],
            "website": gh["website"],
        }
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=1))
    from collections import Counter
    print("affiliation:", dict(Counter(v["affiliation"] for v in result.values())))
    print("section:", dict(Counter(v["section"] or "(none)" for v in result.values())))
    print("with role:", sum(1 for v in result.values() if v["role"]), "/", len(result))
    print(f"-> {OUT}")


if __name__ == "__main__":
    main()
