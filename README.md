# Jeff

<B>Jeff</B> — the org chart that actually knows things

Built at Test Flight, the Glasswing Ventures hackathon, September 26 and 27, 2026.

Team: 
 - Yan (Stella) Si (@sbel2)
 - Sai Nellutla (@SaiNel7)
 - Hoang Dang (@6namdang)
 - Steve Strassmann (@straz)


## The problem

Who inside a company has this problem, how often, and what it costs them today.


## Who pays

The buyer, the budget it comes out of, and why they would sign.


## How it works

```
browser ──WebRTC──▶ ElevenLabs Agent (speech-to-text + LLM + Roger's voice)
   ▲                        │
   │   client tool calls    │  find_experts / lookup_person / impact_if_moved /
   └────────────────────────┘  team_overview / show_on_graph
       answered locally from public/data/people.json + graph.json
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
- `ingest/` — data collection and agent setup
  - `collect.py`, `fetch_people.py`, `skills.py` — GitHub scrape and skill inference
  - `export_json.py` — writes `src/public/data/*.json`
  - `jeff_prompt.md` — Jeff's personality and rules
  - `create_agent.py` — creates/updates the ElevenLabs agent
  - `fetch_transcripts.py` — pulls conversation transcripts and classifies every question into `usage.json`
- `data/` — `boston_people.csv`, `redhat.db`


## What's real and what's mocked

Be specific. Which integrations are live, which data is synthetic, what would break at real scale.


## Running it

```bash
cp .env.example .env   # put your keys in .env, it never gets committed
# install and run steps here
```

This is live at https://hackglass.github.io/jeffatlas/

## Brought in from before the weekend

None.
