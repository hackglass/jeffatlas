# Jeff — the org chart that actually knows things

Hackathon entry for [Glasswing Test Flight](https://glasswing.vc/hackathon-2026/),
a two-day AI hackathon. Live: https://hackglass.github.io/jeffatlas/

Jeff is a voice you talk to about Red Hat's Boston office. Ask who actually has
experience in something and he ranks people with the evidence (commits, repos,
role, bio). Tell him you want to move three people to a new project and he tells
you which systems would be left unowned, and who could backfill.

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
`python3 ingest/fetch_transcripts.py`, which pulls the ElevenLabs transcripts
into `ingest/transcripts/` and writes `src/public/data/usage.json`. Preview:
`http://localhost:3000/?view=usage`.

Every conversation is recorded. ElevenLabs keeps the full transcript and every
tool call (name, parameters, result) for each session, and the page passes the
viewer's name or email (the "you are" box) as the session's user id.
`/xray` opens that record: the list of conversations by user, with flags for
the ones where Jeff found nothing, declined, or got a suggestion, and each one
turn by turn with the tool calls expanded. It reads `/api/convos`, which uses
the server-side ElevenLabs key and snapshots every record to
`ingest/transcripts/`, so it works in `npm run dev` or on a Node host but not
on the static Pages build.

- `src/` — Next.js app (static export, deploys to GitHub Pages)
  - `app/page.tsx` — the page; wires the agent's client tools to the data
  - `components/JeffBlob.tsx` + `app/jeff.css` — the green blob (lifted from the Situent voice dock)
  - `components/OrgGraph.tsx` — animated skill/person graph
  - `components/Whiteboard.tsx` + `lib/board.ts` — Jeff's animated sketchpad and its scene format
  - `components/UsageSankey.tsx` — the usage Sankey and topic leaderboard
  - `app/xray/page.tsx` + `app/api/convos/route.ts` + `lib/convos.ts` — the conversation record and its viewer
  - `app/api/board/route.ts` — the drawing brain (needs `SCIFORIUM_API_KEY` or `ANTHROPIC_API_KEY`)
  - `lib/jeffData.ts` — ranking, person lookup, impact analysis
- `ingest/` — data collection and agent setup
  - `collect.py`, `fetch_people.py`, `skills.py` — GitHub scrape and skill inference
  - `export_json.py` — writes `src/public/data/*.json`
  - `jeff_prompt.md` — Jeff's personality and rules
  - `create_agent.py` — creates/updates the ElevenLabs agent
  - `fetch_transcripts.py` — pulls conversation transcripts and classifies every question into `usage.json`
- `data/` — `boston_people.csv`, `redhat.db`

## Setup

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

## Contributors

 - Yan (Stella) Si
 - Sai Nellutla
 - Hoang Dang
 - Steve Strassmann
