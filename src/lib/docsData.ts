/**
 * Jeff's documentation layer, entirely in the browser — same shape as
 * jeffData.ts's people data.
 *
 * Data comes from /data/docs.json, exported by ingest/fetch_docs.py: a
 * curated, chunked slice of Red Hat product docs (OpenShift/Kubernetes,
 * RHEL, Ansible Automation Platform, OpenShift AI), not the whole of
 * docs.redhat.com. It's a dated snapshot from ingest time, not a live
 * fetch — see ingest/DOCS.md.
 */

import { terms, contains } from "@/lib/searchTerms";

export type DocProduct = "linux" | "kubernetes" | "ansible" | "ai" | "office";

export type DocPassage = {
  product: DocProduct;
  book: string;
  page_title: string;
  section: string;
  url: string;
  text: string;
};

let docsCache: DocPassage[] | null = null;

const base = () => (process.env.NEXT_PUBLIC_BASE_PATH ?? "");

export async function loadDocs(): Promise<DocPassage[]> {
  if (docsCache) return docsCache;
  const res = await fetch(`${base()}/data/docs.json`);
  docsCache = (await res.json()) as DocPassage[];
  return docsCache;
}

export type ScoredPassage = { passage: DocPassage; score: number };

// A literal "wifi"/"desk"/"meals" from a new hire almost always means the
// office, not a RHEL networking chapter or a sudoers doc that happens to
// contain the same word — office passages get a strong boost on these so
// a technical page with more chunks can't bury the actual office answer.
const OFFICE_TRIGGERS = new Set(["wifi", "wi-fi", "desk", "meals", "onboarding", "floor"]);

/** Rank doc passages for a topic. Section/title matches count more than body matches. */
export function rankDocs(passages: DocPassage[], topic: string, product?: string, limit = 5): ScoredPassage[] {
  const ts = terms(topic);
  if (!ts.length) return [];
  const wantProduct = product ? product.toLowerCase().trim() : null;
  const scored: ScoredPassage[] = [];
  const seenPerUrl = new Map<string, number>();
  for (const p of passages) {
    if (wantProduct && p.product !== wantProduct) continue;
    let score = 0;
    for (const t of ts) {
      if (contains(p.section, t)) score += 3;
      if (contains(p.page_title, t)) score += 2;
      if (contains(p.book, t)) score += 1;
      if (contains(p.text, t)) score += 1;
      if (p.product === t || contains(p.product, t)) score += 1.5;
      if (p.product === "office" && OFFICE_TRIGGERS.has(t)) score += 6;
    }
    if (score <= 0) continue;
    // A plain "what is X" is exactly what these hand-written overviews
    // answer; without a boost a task-guide chapter that happens to repeat
    // the product name outscores them on sheer chunk count.
    if (p.book === "Product overview") score += 4;
    // Cap chunks per page: one very relevant page shouldn't fill the whole
    // result list with near-duplicate text.
    const seen = seenPerUrl.get(p.url) ?? 0;
    if (seen >= 2) continue;
    seenPerUrl.set(p.url, seen + 1);
    scored.push({ passage: p, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function passageSummary(p: DocPassage): Record<string, unknown> {
  return {
    product: p.product,
    book: p.book,
    title: p.page_title,
    section: p.section,
    url: p.url,
    excerpt: p.text.length > 500 ? `${p.text.slice(0, 500)}…` : p.text,
  };
}
