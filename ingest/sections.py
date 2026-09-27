#!/usr/bin/env python3
"""Split the broad sections into finer ones.

The roster (data/boston_people.csv) and the GitHub research
(data/github_enrichment.json) give each person a broad, hand-checked section:
Leadership, AI, Platform, Product & GTM, or none (not confirmed Red Hat
staff, drawn as "Community & alumni"). export_json.py calls refine() to split
those into finer sections. The evidence, in order: the role (what someone
does), then the bio, then their top GitHub skill. The broad section is kept as
a frame: a Platform person only moves to a Platform-side section, so a bare
"Software Engineer" there lands in OpenShift & Kubernetes. People outside Red
Hat stay where they are. OVERRIDES pins the few the rules get wrong.

    python3 ingest/export_json.py && python3 ingest/sections.py   # counts
"""
import json
from collections import Counter
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PEOPLE_JSON = ROOT / "src" / "public" / "data" / "people.json"

LEAD = "Leadership"
AI = "AI / ML"
K8S = "OpenShift & Kubernetes"
LINUX = "Linux & virtualization"
DEV = "Developer tools & runtimes"
SRE = "SRE, QA & automation"
UX = "UX & design"
DOCS = "Docs & learning"
PRODUCT = "Product & programs"
SALES = "Sales & partners"
COMMUNITY = "Community & ops"
OTHER = ""  # not confirmed Red Hat staff: drawn as "Community & alumni"
# Its own section, not folded into Leadership: a small, visible team (the
# accelerator lives on its own floor, its own program) that people ask about
# by name. Anyone whose role or bio names it lands here regardless of their
# broad CSV section - see the early-out at the top of refine().
OPEN_ACCELERATOR = "The Open Accelerator"

# What someone does for a living, checked in order; the first match wins.
# Functions come before technologies, so a UX designer on OpenShift AI is UX.
FUNCTION_RULES = [
    (LEAD, r"\b(s?vp|vice president|chief|cto|cpo|director|head of|general manager|distinguished)\b"
           r"|\b(engineering|kernel engineering|software engineering|sr\.?|senior|associate) manager\b|^manager\b"),
    (SALES, r"\b(sales|gtm|go-to-market|account executive|account manager|solutions? architect|consultant|consulting|partner|alliances?|customer success|specialist)\b"),
    (UX, r"\b(ux|designer|design|interaction|user experience|user research)\b"),
    (DOCS, r"\b(technical writer|writer|documentation|docs|curriculum|instructor|training|content|learning (experience|and development|& development))\b"),
    (PRODUCT, r"\b(product manager|product owner|business strategy|program manager|project manager|marketing|product management)\b"),
    (COMMUNITY, r"\b(talent|recruit\w*|events?|citizenship|community|evangelist|advocate|workplace|executive briefing|ebc|engagement manager|people partner)\b"),
]
# The technology someone works on, checked after the functions.
TECH_RULES = [
    (DOCS, r"\b(docs|documentation)\b"),
    (UX, r"\b(design|ux)\b"),
    (AI, r"\b(ai|ml|machine learning|data scien\w*|research scientist|llms?|inference|vllm|genai|gen ai|neural|pytorch|model\w*|lightspeed|instructlab|agentic)\b"),
    (SRE, r"\b(sre|site reliability|quality|qe|qa|test\w*|automation|ansible|devops|release|ci/cd)\b"),
    (LINUX, r"\b(kernel|rhel|linux|virtuali[sz]ation|kubevirt|storage|ceph|real-?time|hardware|firmware|systems programming|rhivos|in-vehicle|automotive)\b"),
    (K8S, r"\b(openshift|kubernetes|k8s|cloud|operators?|containers?|podman|telco|serverless|service mesh|opentelemetry|observability)\b"),
    (DEV, r"\b(java|quarkus|keycloak|middleware|front ?end|javascript|typescript|developer tools|runtimes?|backend|security|identity)\b"),
]
# GitHub's top inferred skill, for people the words above do not place.
SKILL_SECTION = {
    "AI / ML": AI,
    "Cloud / Kubernetes": K8S,
    "Containers & Runtimes": K8S,
    "Linux / OS": LINUX,
    "Virtualization": LINUX,
    "Storage": LINUX,
    "Systems / Low-level (C, Rust)": LINUX,
    "Automation / DevOps": SRE,
    "Frontend (TypeScript/JS)": DEV,
    "Java / JVM": DEV,
    "Go / Backend services": DEV,
    "Python": DEV,
    "Security / Identity": DEV,
}
# The broad frame each section belongs to, old hand-set names and new ones.
ENGINEERING = {K8S, LINUX, DEV, SRE}
BUSINESS = {UX, DOCS, PRODUCT, SALES, COMMUNITY}
FRAME = {
    "Leadership": LEAD,
    "AI / ML research, engineering, data science": AI, AI: AI,
    "Platform / infrastructure engineering, QA, SRE": "eng", **{s: "eng" for s in ENGINEERING},
    "Product, UX, docs, marketing, sales, GTM, ops": "biz", **{s: "biz" for s in BUSINESS},
}
# login (lowercase) -> section, for the handful the rules misplace.
OVERRIDES: dict[str, str] = {
    "adereis": LEAD,           # "Software Engineering Leader" at Red Hat, said only in the bio
    "crm:mark-kurtz": AI,      # AI researcher; "former CTO" is history
    "danieloh30": COMMUNITY,   # developer advocate, CNCF ambassador
    "prb112": K8S,             # partner *engineer*, not partner sales
    "jeking3": SRE,            # bio is a joke about AI; the work is automation
    "jeffbyrnes": SRE,         # ops engineering
    "cogumbreiro": DEV,        # researcher on languages and runtimes
}


def match(rules, text):
    for section, pattern in rules:
        if text and re.search(pattern, text, re.I):
            return section
    return None


def refine(login, section, role, bio, top_skill):
    """The fine section for someone whose broad section is `section`."""
    if re.search(r"open accelerator", f"{role or ''} {bio or ''}", re.I):
        return OPEN_ACCELERATOR
    frame = FRAME.get(section or "")
    if not frame:
        return OTHER
    if (login or "").lower() in OVERRIDES:
        return OVERRIDES[login.lower()]
    # "Office of the CTO" is a place to work, not a title.
    role = re.sub(r"office of the cto", "OCTO", role or "", flags=re.I)
    bio = bio or ""
    # Researched roles read "Engineer; works on community-operators, ...": the
    # repo names are evidence of technology, never of job function.
    title = re.split(r"works on", role, flags=re.I)[0]
    by_role = match(FUNCTION_RULES, title)
    if by_role:
        return by_role
    if frame in (LEAD, AI):
        return frame
    # A named technology in the role beats the broad frame (a kernel engineer
    # filed under Product & GTM is still a kernel engineer).
    by_role = match(TECH_RULES, role)
    if by_role:
        return by_role
    # Bios are self-written: they say what someone does, but "founder" or
    # "chief" there is often another company, so bios never make a leader.
    guess = (match(FUNCTION_RULES[1:], bio) or match(TECH_RULES, bio)
             or SKILL_SECTION.get(top_skill))
    if frame == "eng":
        return guess if guess in ENGINEERING or guess == AI else K8S
    if frame == "biz":
        return guess if guess in BUSINESS else PRODUCT
    return guess or K8S


def main():
    """Print how people.json (already refined by export_json.py) splits up."""
    counts = Counter(p["section"] or "Community & alumni" for p in json.loads(PEOPLE_JSON.read_text()))
    for section, n in counts.most_common():
        print(f"{n:4d}  {section}")


if __name__ == "__main__":
    main()
