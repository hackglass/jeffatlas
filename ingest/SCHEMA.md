# Jeff data model (proposal)

Today the data is two flat files stitched at export time: `data/boston_people.csv`
(CRM-style roster, 381 people, 279 with a prose profile) and `data/redhat.db`
(GitHub repos + contribution counts, 166 people). Skills are inferred only from
GitHub, so leadership, product and GTM people have none, and the richest
evidence we have on many engineers (their DevConf, Summit and KubeCon talks)
is buried inside profile prose: 34 profiles mention DevConf, but none of that
is queryable.

The fix is to stop treating "skills" as a column and treat them as **claims
backed by evidence**, where a conference talk, a commit history, a role title
and a bio sentence are all just evidence of different kinds and weights.

## Core tables

```
person        id, name, section, role, location, manager_id?, start_date?, links{github, linkedin, rover, slack}
skill         id, label, parent_id?            e.g. "vLLM" under "AI / ML"; keep the 13 areas as the top level
event         id, name, series, year, city     e.g. DevConf.US 2026, Red Hat Summit 2025, KubeCon NA 2024
talk          id, event_id, title, abstract, url, kind{keynote, talk, workshop, lightning}
talk_speaker  talk_id, person_id
repo          full_name, org, language, topics
contribution  person_id, repo, commits, first_at, last_at, reviews?
evidence      id, person_id, skill_id, source, weight, ref, observed_at, text
```

`evidence.source` is an enum: `talk`, `commit`, `review`, `role`, `bio`,
`crm`, `manual`. `ref` points at the row it came from (a talk id, a repo
name, the CRM row). A person's skill score is a *derived* number:
sum of evidence weights, decayed by age, capped per source so one 2,000-commit
repo does not drown out three keynotes.

Suggested base weights (tune later):

| source | weight | why |
|---|---|---|
| talk (keynote/workshop) | 3.0 | curated by a program committee; strongest public signal of depth |
| talk (regular) | 2.0 | |
| commit (per log1p(n)) | 1.0 | today's signal; keep it |
| review | 0.8 | reviewing is ownership without commits |
| role title | 1.5 | "Principal Engineer, Storage" is a claim by the company |
| bio / profile sentence | 0.5 | self-reported, unverified |

## Why talks first

Conference programs are structured, public, and already tagged: every
DevConf / Summit / KubeCon session has a title, an abstract, a track, and a
speaker list. Tracks map cleanly onto the 13 skill areas (and give a second
level: "vLLM", "llm-d", "Ceph", "KubeVirt"). They also cover the people
GitHub misses: architects, product managers, leaders who keynote. Sources
worth pulling, in order:

1. DevConf.US / DevConf.CZ (pretalx JSON, public): Boston-heavy speaker pool.
2. Red Hat Summit + AnsibleFest session catalog (public web, needs scraping).
3. KubeCon / CloudNativeCon schedules (Sched has a JSON export).
4. AI_dev, PyCon, FOSDEM: smaller but they are where the AI and systems people show up.

Match speakers to `person` on name + company + city, then confirm against the
CRM roster; unmatched speakers go to a review queue rather than being dropped.

## Access tiers live on the schema, not in the app

Each table gets a `min_access` column (`new` < `manager` < `leader`), and each
evidence source has a default:

| data | new hire | manager | leader |
|---|---|---|---|
| name, section, role, Slack/Rover pointer | yes | yes | yes |
| skill areas (derived) | yes | yes | yes |
| talks (public) | yes | yes | yes |
| commit counts, repos | summary | yes | yes |
| evidence text, bios, LinkedIn | no | partial | yes |
| staffing impact, backfills, single points of failure | no | yes | yes |
| manager chain, start dates | no | own org | yes |

Today this is enforced in the browser (`src/app/page.tsx`, `Access`) and
told to Jeff through `{{access_level}}`; with a real backend the export
should just emit three JSON bundles, one per tier, so the low-tier bundle
never contains the fields at all.

## Migration in three steps

1. **Extract talks from what we already have.** A one-off pass over the 279
   profiles pulls "speaker at X 2026"-style sentences into `talk` rows with
   `source=bio` so nothing is lost, then real conference feeds replace them.
2. **Refactor `export_json.py`** to build `evidence` rows from all sources and
   derive `skills` from them. `people.json` and `graph.json` keep their shape
   (the app does not change), plus a `talks` array per person and `talk`
   nodes on the graph so Jeff can say "she keynoted DevConf on llm-d".
3. **Add `find_experts` evidence lines for talks** ("2 DevConf talks on
   inference serving") so the ranking explains itself the way it already does
   for commits.
