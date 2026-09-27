# Jeff's documentation data

`ingest/fetch_docs.py` writes `src/public/data/docs.json`: a curated,
chunked slice of official Red Hat product documentation, not the whole of
docs.redhat.com (too large to ship to a browser). `src/lib/docsData.ts`
loads it client-side, same pattern as people data.

## Scope

A hand-picked `BOOKS` list in `fetch_docs.py`, ~5-8 books across four
product trees, tagged with the same product keys `src/lib/searchTerms.ts`
already uses for skill synonyms, so one query drives both doc ranking and
`rankExperts`:

| product key | tree |
|---|---|
| `linux` | RHEL |
| `kubernetes` | OpenShift / Kubernetes |
| `ansible` | Ansible Automation Platform |
| `ai` | OpenShift AI |
| `office` | Boston office logistics (Wi-Fi, meals, desk booking) — hand-authored, see below |

To add or swap a book, add a `(product, book_url, title)` tuple to `BOOKS`.
Pick the book's `/html/<slug>` landing page URL (not `/html-single/`,
disallowed by robots.txt) from docs.redhat.com's product index.

## Chunking

Each page is split by `h2`/`h3` heading into passages of roughly 40-320
words (`MIN_WORDS`/`MAX_WORDS` in `fetch_docs.py`), each tagged with its
product, book, page title, section heading, and source URL. Boilerplate
pages (legal notices, license text, feedback forms) are filtered by slug.

## Office tribal knowledge

`OFFICE_KNOWLEDGE` in `fetch_docs.py` is hand-authored, not crawled — there's
no public doc for Wi-Fi setup, meal ordering, or desk booking. It's tagged
`product: "office"` and always included in `docs.json` regardless of `--book`.
Most of these URLs are **synthetic placeholders** pointing at Source (Red
Hat's internal wiki) in the shape a real citation would take — they are not
live pages. Edit the list directly to correct or extend this; it's demo/seed
content for a hackathon build, not verified fact.

The Open Accelerator entry is the exception: it's a real initiative (Red
Hat's AI entrepreneurship program with IBM Ventures and the Commonwealth of
Massachusetts' MA AI Hub), sourced from and cited to the real public page
at https://the-open-accelerator.com/about-why.html.

## Re-running

```
pip install -r ingest/requirements.txt
python3 ingest/fetch_docs.py             # full run: ~5-8 books, tens of minutes
python3 ingest/fetch_docs.py --book selinux   # one book, for testing a change
python3 ingest/create_agent.py --update <agent_id>   # push the search_docs tool again if TOOLS changed
```

This is a manual, occasional job — like `enrich_github.py`, not CI. It
respects `docs.redhat.com/robots.txt`'s `Crawl-delay: 10` (one request
every 10 seconds), so a full run of ~13 books takes on the order of half
an hour.

**The data goes stale.** There's no live fetch — Jeff's docs answers are a
snapshot from whenever this was last run. Re-run it periodically (e.g.
before a demo, or when a book's content is known to have changed); the
prompt tells Jeff to flag that his copy may be dated when currency matters.
