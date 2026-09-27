# Jeff

<B>Jeff</B> — the org chart that actually knows things

Built at Test Flight, the Glasswing Ventures hackathon, September 26 and 27, 2026.

Team: 
 - Yan (Stella) Si ([@sbel2](https://github.com/sbel2))
 - Sai Nellutla ([@SaiNel7](https://github.com/SaiNel7))
 - Hoang Dang ([@6namdang](https://github.com/6namdang))
 - Steve Strassmann ([@straz](https://github.com/straz))


## The problem

Jeff is a voice you talk to about Red Hat's Boston office. Ask who actually has
experience in something and he ranks people with the evidence (commits, repos,
role, bio). Tell him you want to move three people to a new project and he tells
you which systems would be left unowned, and who could backfill. Ask a technical
question — how to configure SELinux, install an OpenShift Operator, get started
with an Ansible playbook — and he answers from a curated slice of Red Hat's
official docs, plus points you at the Boston person who knows that area.


## Who pays

Jeff creates value by making organizational knowlege more accessible and more accurate. Use cases:
  - new employee onboarding
  - employees coming up to speed on projects
  - executive oversight, matching talent with projects
  
The main beneficiary are business owners at the director level and
above. HR is the natural purchasing customer, spending on behalf of
the business units.


## How it works

```
browser ──WebRTC──▶ ElevenLabs Agent (speech-to-text + LLM + Roger's voice)
   ▲                        │
   │   client tool calls    │  find_experts / lookup_person / impact_if_moved /
   └────────────────────────┘  team_overview / show_on_graph / search_docs
       answered locally from public/data/people.json + graph.json + docs.json
```

Everything runs in the page. The agent calls "client tools" that the browser
answers from the exported data, and the org graph on the right animates
whatever Jeff is talking about.

Jeff also has a whiteboard. `board_write` puts a list or a flow on it
directly; `board_explain` sends a one-line brief to a second brain
(`src/app/api/board/route.ts`, Claude via the Anthropic SDK) that designs an
animated step-by-step sketch, which the board plays while Jeff narrates.
That route needs a server, so it runs in `npm run dev` (or any Node host)
but not on the static GitHub Pages build, where Jeff falls back to
`board_write`. Preview the board without talking: `http://localhost:3000/?board=demo`.

Jeff can also show how he is being used. `show_usage` puts a Sankey of every
question from the saved transcripts on the canvas (who asked → kind of
question → topic → outcome) with a leaderboard of topics, so leadership can see
what people come to Jeff for and where he came up empty. Refresh it with
`python3 ingest/fetch_transcripts.py`, which reads the ElevenLabs transcripts
and writes `src/public/data/usage.json` (nothing else is kept on disk). Preview:
`http://localhost:3000/?view=usage`.

Everything is logged to PostHog from the browser (`src/lib/analytics.ts`), so
it works on the static Pages site too: each conversation (start, end and why),
every turn on both sides, every tool call with its parameters, result and
duration, every click on the canvas, every control press (start, mute,
interrupt, end, lens and view switches) and every feedback note Jeff files
with `record_feedback`. Events carry the ElevenLabs conversation id and belong
to the person named in the "you are" box. Set `NEXT_PUBLIC_POSTHOG_KEY` (and
optionally `NEXT_PUBLIC_POSTHOG_HOST`) in `src/.env.local` and as repo
Variables; blank means nothing is sent.

ElevenLabs keeps the full transcript of each session as well. `/xray` opens
that record (list by user with flags, each conversation turn by turn with tool
calls expanded) through `/api/convos`, which uses the server-side key, so it
works in `npm run dev` or on a Node host but not on the static Pages build.
Add `?dev` to the main page's URL to show the team-only footer with the link.

- `src/` — Next.js app (static export, deploys to GitHub Pages)
  - `app/page.tsx` — the page; wires the agent's client tools to the data
  - `components/JeffBlob.tsx` + `app/jeff.css` — the green blob (lifted from the Situent voice dock)
  - `components/OrgGraph.tsx` — animated skill/person graph
  - `components/Whiteboard.tsx` + `lib/board.ts` — Jeff's animated sketchpad and its scene format
  - `components/UsageSankey.tsx` — the usage Sankey and topic leaderboard
  - `lib/analytics.ts` — the PostHog log of everything that happens
  - `app/xray/page.tsx` + `app/api/convos/route.ts` + `lib/convos.ts` — the ElevenLabs conversation record and its viewer
  - `app/api/board/route.ts` — the drawing brain (needs `SCIFORIUM_API_KEY` or `ANTHROPIC_API_KEY`)
  - `lib/jeffData.ts` — ranking, person lookup, impact analysis
  - `lib/docsData.ts` — doc passage ranking (search_docs)
  - `lib/searchTerms.ts` — shared synonym/term expansion used by both
- `ingest/` — data collection and agent setup
  - `collect.py`, `fetch_people.py`, `skills.py` — GitHub scrape and skill inference
  - `export_json.py` — writes `src/public/data/*.json`
  - `fetch_docs.py` — crawls a curated slice of docs.redhat.com into `src/public/data/docs.json` (see `ingest/DOCS.md`)
  - `jeff_prompt.md` — Jeff's personality and rules
  - `create_agent.py` — creates/updates the ElevenLabs agent
  - `fetch_transcripts.py` — pulls conversation transcripts and classifies every question into `usage.json`
- `data/` — `boston_people.csv`, `redhat.db`


## What's real and what's mocked

All data in our demo is real. Nothing was mocked.

Our data sources, all public domain:
  - github (scraping repos owned by RedHat)
  - linkedin (scraping profiles of RedHat employees)
  - primed knowledge (personal communication with RedHat employees)
  - open source documentation (RedHat projects)
  - OpenAccelerator web site


## Running it

### Demo

Jeff is live at https://hackglass.github.io/jeffatlas/

### Configuration

1. **ElevenLabs API key** (one-time, only for creating the agent):
   elevenlabs.io → profile (bottom left) → *API Keys* → *Create API Key* with the
   Agents and Voices scopes. Put it in `src/.env.local`:
   ```
   ELEVENLABS_API_KEY=...
   ```
2. **Create Jeff's agent** (voice: Roger, brain: an ElevenLabs-hosted model):
   ```
   python3 ingest/create_agent.py
   ```
   To run the brain on GLM instead:
   ```
   python3 ingest/create_agent.py --glm-key "$GLM_API_KEY" --glm-model glm-4.6
   ```
   It prints an agent id. Add it to `src/.env.local`:
   ```
   NEXT_PUBLIC_ELEVENLABS_AGENT_ID=agent_...
   ```
   Re-run with `--update agent_...` after editing `jeff_prompt.md` or the tools.
3. **Whiteboard brain** (optional): put a key in `src/.env.local`. Hackathon weekend, use the Sciforium team key (OpenAI-compatible; GLM 5.3 Flash works well):
   ```
   SCIFORIUM_API_KEY=...
   SCIFORIUM_MODEL=<exact model string from compute setup>
   ```
   Or an Anthropic key (used when no Sciforium key is set):
   ```
   ANTHROPIC_API_KEY=...
   ```
   `BOARD_MODEL` overrides the Anthropic model (default `claude-opus-5`). Without either key, Jeff still draws with the quick `board_write` tool; only the animated `board_explain` sketches need a key. The GitHub Pages build has no server, so it never has the drawing brain.
4. **Run it**:
   ```
   cd src && npm install && npm run dev
   ```
5. **Deploy**: pushes to `main` build to GitHub Pages. Set the repo *Variable*
   `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` (Settings → Secrets and variables → Actions → Variables).

Regenerate the data after touching `data/`:
```
python3 ingest/export_json.py
```

Fetch (or refresh) the documentation slice — a manual, occasional job, see `ingest/DOCS.md`:
```
pip install -r ingest/requirements.txt
python3 ingest/fetch_docs.py
```

Jeff is live at https://hackglass.github.io/jeffatlas/

## Brought in from before the weekend

None.
