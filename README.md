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

Everything runs in the page. There is no backend: the agent calls "client
tools" that the browser answers from the exported data, and the org graph on
the right animates whatever Jeff is talking about.

- `src/` — Next.js app (static export, deploys to GitHub Pages)
  - `app/page.tsx` — the page; wires the agent's client tools to the data
  - `components/JeffBlob.tsx` + `app/jeff.css` — the green blob (lifted from the Situent voice dock)
  - `components/OrgGraph.tsx` — animated skill/person graph
  - `lib/jeffData.ts` — ranking, person lookup, impact analysis
- `ingest/` — data collection and agent setup
  - `collect.py`, `fetch_people.py`, `skills.py` — GitHub scrape and skill inference
  - `export_json.py` — writes `src/public/data/*.json`
  - `jeff_prompt.md` — Jeff's personality and rules
  - `create_agent.py` — creates/updates the ElevenLabs agent
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
3. **Run it**:
   ```
   cd src && npm install && npm run dev
   ```
4. **Deploy**: pushes to `main` build to GitHub Pages. Set the repo *Variable*
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
