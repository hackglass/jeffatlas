#!/usr/bin/env python3
"""Fetch a curated slice of Red Hat product documentation and chunk it for Jeff.

Crawls a hand-picked set of doc "books" (see BOOKS below) across four product
trees Jeff should be able to talk about: OpenShift/Kubernetes, RHEL, Ansible
Automation Platform, and OpenShift AI. Not the whole of docs.redhat.com — that
corpus is far too large to ship to a browser; this is the same "curated,
offline, static JSON" pattern export_json.py uses for people.

Respects docs.redhat.com/robots.txt: Crawl-delay: 10 (one request every 10s,
so a full run takes tens of minutes — this is a manual, occasional job, not
CI) and Disallow: */html-single/* (crawls the paginated /html/ book view,
never /html-single/).

Writes src/public/data/docs.json: a flat array of passages, each
{product, book, book_title, page_title, section, url, text}, chunked by
h2/h3 heading so each passage is a self-contained ~150-300 word answer.
Also always includes OFFICE_KNOWLEDGE below: hand-authored Boston office
tribal knowledge (Wi-Fi, meals, desk booking) that isn't in any crawlable
doc, tagged product="office" so it's searched the same way.

    pip install -r ingest/requirements.txt
    python3 ingest/fetch_docs.py
    python3 ingest/fetch_docs.py --book using_selinux   # just one book, for testing
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup, NavigableString

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "public" / "data" / "docs.json"
BASE = "https://docs.redhat.com"

# Product keys match SYNONYMS in src/lib/searchTerms.ts, so a query like
# "RHEL" (-> linux) or "openshift" (-> kubernetes) drives both doc ranking
# and rankExperts from the same term expansion.
BOOKS = [
    # product,      book slug,                                          short title
    ("linux",      "/en/documentation/red_hat_enterprise_linux/9/html/configuring_basic_system_settings", "Configuring basic system settings"),
    ("linux",      "/en/documentation/red_hat_enterprise_linux/9/html/automating_system_administration_by_using_rhel_system_roles", "Automating system administration using RHEL system roles"),
    ("linux",      "/en/documentation/red_hat_enterprise_linux/9/html/using_selinux", "Using SELinux"),
    ("linux",      "/en/documentation/red_hat_enterprise_linux/9/html/security_hardening", "Security hardening"),
    ("kubernetes", "/en/documentation/openshift_container_platform/4.17/html/architecture", "OpenShift architecture"),
    ("kubernetes", "/en/documentation/openshift_container_platform/4.17/html/building_applications", "Building applications on OpenShift"),
    ("kubernetes", "/en/documentation/openshift_container_platform/4.17/html/operators", "Working with Operators on OpenShift"),
    ("ansible",    "/en/documentation/red_hat_ansible_automation_platform/2.5/html/getting_started_with_ansible_automation_platform", "Getting started with Ansible Automation Platform"),
    ("ansible",    "/en/documentation/red_hat_ansible_automation_platform/2.5/html/getting_started_with_playbooks", "Getting started with playbooks"),
    ("ansible",    "/en/documentation/red_hat_ansible_automation_platform/2.5/html/using_automation_execution", "Using automation execution"),
    ("ai",         "/en/documentation/red_hat_openshift_ai_self-managed/2.16/html/getting_started_with_red_hat_openshift_ai_self-managed", "Getting started with OpenShift AI"),
    ("ai",         "/en/documentation/red_hat_openshift_ai_self-managed/2.16/html/installing_and_uninstalling_openshift_ai_self-managed", "Installing and uninstalling OpenShift AI"),
    ("ai",         "/en/documentation/red_hat_openshift_ai_self-managed/2.16/html/working_on_data_science_projects", "Working on data science projects"),
]

# Boston office tribal knowledge: hand-authored, not crawled (there's no public
# doc for this). New hires ask about this constantly and it walks out the door
# with whoever happens to know it, same problem as the "who knows X" data.
# URLs are synthetic placeholders pointing at Source (Red Hat's internal wiki),
# not live pages — this is demo/seed content, not crawled fact.
OFFICE_KNOWLEDGE = [
    {
        "product": "office", "book": "Boston office basics", "page_title": "Connecting to Wi-Fi",
        "section": "Wi-Fi", "url": "https://source.redhat.com/departments/it/network/boston_wifi_setup",
        "text": "Check the Source documentation for step-by-step Wi-Fi setup. If you're still stuck, IT has a walk-up desk in the south wing of the second floor at the Boston office — they can get your laptop or phone connected in person.",
    },
    {
        "product": "office", "book": "Boston office basics", "page_title": "Ordering meals",
        "section": "Catered meals", "url": "https://source.redhat.com/departments/facilities/boston/meals_ez_cater",
        "text": "Meals are ordered through EZ Cater using the Relish app; sign in with your Red Hat email. Each day you'll have five restaurants to choose from, with a $15 budget per meal.",
    },
    {
        "product": "office", "book": "Boston office basics", "page_title": "Reserving a desk",
        "section": "Desk booking", "url": "https://source.redhat.com/departments/facilities/boston/desk_booking_appspace",
        "text": "Use Appspace to reserve a desk. You have to reserve one each day, but you can book up to 90 days out. By floor: second floor is IT, the Linux Kernel team, and Partner Ecosystems; third floor south wing is the AI team; fourth floor is the Executive Briefing Center (EBC), senior leadership, and data engineering; fifth floor is The Open Accelerator. Book near the team you're actually working with.",
    },
    {
        # Real initiative, real source (not a synthetic Source link like the
        # other office entries): https://the-open-accelerator.com/about-why.html
        "product": "office", "book": "Boston office basics", "page_title": "The Open Accelerator",
        "section": "Fifth floor: The Open Accelerator", "url": "https://the-open-accelerator.com/about-why.html",
        "text": "The Open Accelerator is Red Hat's AI entrepreneurship program, run in partnership with IBM Ventures and the Commonwealth of Massachusetts' MA AI Hub. It's based on the fifth floor of the Boston office. The program runs a selective residency (5-10 startups per cohort) for early-stage Massachusetts AI founders who've moved past the idea stage into a prototype or MVP, especially in regulated industries like healthcare, finance, and government. It helps them close the 'enterprise readiness gap' with architectural guidance so their solutions are the kind an enterprise CISO would actually approve. Beyond the residency it runs hackathons, university partnerships, and community events, and backs open-source projects like OpenClaw and the Boston AI Atlas. It's a genuinely big initiative for Red Hat, not just a co-working floor — worth knowing if AI startups or the local ecosystem come up. Book a desk there through Appspace the same as any other floor if you're working with a team based there.",
    },
]

# Plain "what is X" overviews. None of the curated books above are an intro
# page (they're all task guides), so a new hire asking "what is RHEL" had
# nothing to match. Hand-written, not crawled; product docs index URLs are
# real (fetched and confirmed while picking BOOKS above).
PRODUCT_OVERVIEWS = [
    {
        "product": "linux", "book": "Product overview", "page_title": "What is RHEL",
        "section": "What is Red Hat Enterprise Linux (RHEL)",
        "url": "https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/9",
        "text": "Red Hat Enterprise Linux (RHEL) is Red Hat's flagship enterprise operating system: a stable, secure, commercially supported Linux distribution that businesses run their servers and critical applications on. It's the foundation a lot of Red Hat's other products (OpenShift, Ansible Automation Platform, OpenShift AI) build on top of.",
    },
    {
        "product": "kubernetes", "book": "Product overview", "page_title": "What is OpenShift",
        "section": "What is OpenShift Container Platform",
        "url": "https://docs.redhat.com/en/documentation/openshift_container_platform/4.17",
        "text": "OpenShift Container Platform is Red Hat's enterprise Kubernetes platform: it packages Kubernetes with developer and operations tooling, a container registry, CI/CD pipelines, and Operators for automated lifecycle management, so teams can build, deploy, and run containerized applications at scale.",
    },
    {
        "product": "ansible", "book": "Product overview", "page_title": "What is Ansible Automation Platform",
        "section": "What is Red Hat Ansible Automation Platform (AAP)",
        "url": "https://docs.redhat.com/en/documentation/red_hat_ansible_automation_platform/2.5",
        "text": "Red Hat Ansible Automation Platform (AAP) is Red Hat's enterprise automation offering built on Ansible: teams write Playbooks (in YAML) that describe automation tasks, and the platform runs, schedules, and manages them at scale across servers, network devices, and cloud infrastructure.",
    },
    {
        "product": "ai", "book": "Product overview", "page_title": "What is OpenShift AI",
        "section": "What is Red Hat OpenShift AI",
        "url": "https://docs.redhat.com/en/documentation/red_hat_openshift_ai_self-managed/2.16",
        "text": "Red Hat OpenShift AI is a platform for building, training, and deploying AI/ML models on OpenShift: data science projects, notebooks, model training and serving, all running on the same Kubernetes-based infrastructure. It's the piece of Red Hat's AI story (alongside vLLM, InstructLab, and Red Hat AI more broadly) most directly tied to OpenShift.",
    },
]

MAX_PAGES_PER_BOOK = 40
CRAWL_DELAY = 10  # seconds; robots.txt says 10
MIN_WORDS = 40  # shorter fragments (nav leftovers, single-line notes) are noise
MAX_WORDS = 320  # a section longer than this is split further

HEADERS = {"User-Agent": "jeffatlas-docs-ingest/1.0 (internal tool, red hat boston; contact skn29@cornell.edu)"}


def get(url: str) -> str | None:
    try:
        r = requests.get(url, headers=HEADERS, timeout=30)
        if r.status_code != 200:
            print(f"    {r.status_code} {url}", file=sys.stderr)
            return None
        return r.text
    except requests.RequestException as e:
        print(f"    error {url}: {e}", file=sys.stderr)
        return None


def chapter_links(html: str, book_url: str) -> list[str]:
    """Every link on the book's landing page that stays inside this book."""
    soup = BeautifulSoup(html, "html.parser")
    prefix = book_url.rstrip("/") + "/"
    landing = (BASE + book_url).rstrip("/")
    seen, out = {landing}, []
    for a in soup.find_all("a", href=True):
        href = urljoin(BASE + book_url, a["href"])
        href = href.split("#")[0].rstrip("/")
        if not href.startswith(BASE + prefix):
            continue
        if "/html-single/" in href:
            continue
        if BOILERPLATE_SLUGS.search(href.rsplit("/", 1)[-1]):
            continue
        if href not in seen:
            seen.add(href)
            out.append(href)
    return out


def main_content(soup: BeautifulSoup) -> BeautifulSoup:
    """Strip chrome (nav, header, footer, sidebars, scripts) and return what's left."""
    for tag in soup.find_all(["script", "style", "nav", "header", "footer", "aside"]):
        tag.decompose()
    for tag in soup.find_all(attrs={"class": re.compile(r"(toc|breadcrumb|sidebar|nav-|pagination)", re.I)}):
        tag.decompose()
    main = soup.find("main") or soup.find(attrs={"role": "main"}) or soup.find(id=re.compile("content", re.I)) or soup
    return main


COPY_LINK_RE = re.compile(r"\s*Copy link Link copied to clipboard!?\s*", re.I)
BOILERPLATE_SLUGS = re.compile(r"(legal-notice|gplv3-license|open.?source.?license|providing-feedback)", re.I)


def text_of(node) -> str:
    t = re.sub(r"\s+", " ", node.get_text(" ", strip=True)).strip()
    return COPY_LINK_RE.sub(" ", t).strip()


def chunk_page(html: str, url: str, product: str, book_title: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    h1 = soup.find("h1")
    page_title = text_of(h1) if h1 else book_title
    main = main_content(soup)

    passages: list[dict] = []
    current_heading = page_title
    buf: list[str] = []

    def flush():
        text = " ".join(buf).strip()
        buf.clear()
        if len(text.split()) < MIN_WORDS:
            return
        words = text.split()
        for i in range(0, len(words), MAX_WORDS):
            chunk = " ".join(words[i:i + MAX_WORDS])
            passages.append({
                "product": product, "book": book_title, "page_title": page_title,
                "section": current_heading, "url": url, "text": chunk,
            })

    for el in main.find_all(["h2", "h3", "p", "li", "pre"], recursive=True):
        if isinstance(el, NavigableString):
            continue
        if el.name in ("h2", "h3"):
            flush()
            current_heading = text_of(el) or current_heading
        else:
            t = text_of(el)
            if t:
                buf.append(t)
    flush()
    return passages


def crawl_book(product: str, book_url: str, book_title: str) -> list[dict]:
    print(f"  {product}: {book_title}")
    html = get(BASE + book_url)
    if not html:
        return []
    pages = [BASE + book_url] + chapter_links(html, book_url)
    pages = pages[:MAX_PAGES_PER_BOOK]
    passages = []
    for i, url in enumerate(pages):
        page_html = html if url == BASE + book_url else get(url)
        if i > 0:
            time.sleep(CRAWL_DELAY)
        if not page_html:
            continue
        chunks = chunk_page(page_html, url, product, book_title)
        passages.extend(chunks)
        print(f"    {urlparse(url).path.split('/')[-1]}: {len(chunks)} passages")
    return passages


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--book", help="only crawl book(s) whose slug contains this substring, for testing")
    a = ap.parse_args()

    books = [b for b in BOOKS if not a.book or a.book in b[1]]
    if not books:
        sys.exit(f"no book matches --book {a.book!r}")

    all_passages: list[dict] = list(OFFICE_KNOWLEDGE) + list(PRODUCT_OVERVIEWS)
    for product, book_url, book_title in books:
        all_passages.extend(crawl_book(product, book_url, book_title))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(all_passages, ensure_ascii=False))

    by_product: dict[str, int] = {}
    for p in all_passages:
        by_product[p["product"]] = by_product.get(p["product"], 0) + 1
    print(f"\n{len(all_passages)} passages -> {OUT}")
    for product, n in sorted(by_product.items()):
        print(f"  {product}: {n}")


if __name__ == "__main__":
    main()
