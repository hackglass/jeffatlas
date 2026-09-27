# Jeff — seed

The one document to read before touching anything. What we are solving,
how the machine works, and who Jeff is.

## The problem

Red Hat is about 24,000 people and very distributed. Boston is the technology
headquarters: roughly 300 people, most of the technology leadership, and the
center of the AI work (Red Hat AI, vLLM, llm-d, InstructLab, OpenShift AI).

The org chart tells you who reports to whom. It does not tell you who actually
knows things. That knowledge is tribal: it lives in people's heads, in commit
histories, in the one person who has kept a system alive for six years. It
walks out the door when someone changes teams, and the docs portal has five
versions of everything.

Three people feel this every week:

- **A leader staffing a new initiative.** "Move Priya, Marco and Dana to the
  new project." Nobody can say quickly what quietly breaks when they leave.
- **A manager doing a handover.** Which systems does this person really own,
  and who could take them?
- **A new hire three days in.** Stuck, and no idea who to ask.

Jeff answers those questions out loud, with evidence, in the time it takes to
ask them.

## What Jeff does

You tap a green blob and talk. Jeff can:

- **Find experts.** "Who knows cluster provisioning?" Ranked people with the
  reason for each rank: commits, repos, role, bio.
- **Look up a person.** What they have actually worked on.
- **Run an impact analysis.** Name the people you want to move and Jeff says
  which areas go unowned, which become a single point of failure, and who
  could backfill.
- **Describe the shape of a team or section.**
- **Draw it.** Whatever Jeff is talking about lights up on the org graph.

Evidence is the product. Jeff never names a person without saying why in one
clause, and never invents a person, a number, or a repository.

## How the engineering works

There is no backend. Everything runs in the browser and in ElevenLabs.

```
browser ──WebRTC──▶ ElevenLabs Agent (speech-to-text + LLM + Roger's voice)
   ▲                        │
   │   client tool calls    │  find_experts / lookup_person / impact_if_moved /
   └────────────────────────┘  team_overview / show_on_graph
       answered locally from public/data/people.json + graph.json
```

**The conversation** is an ElevenLabs Agent. It owns the microphone, the
transcription, the language model (Gemini 2.5 Flash by default, GLM optional)
and the voice (Roger). The page connects over WebRTC with the public agent id;
no API key ever reaches the browser.

**The brain's hands are client tools.** When the model decides it needs facts,
the ElevenLabs SDK calls a function in the page. The page answers from JSON it
already loaded and returns a compact string that goes back into the model's
context. The five tools and their ranking, lookup and impact logic live in
`src/lib/jeffData.ts`; `src/app/page.tsx` wires them to the agent and to the
screen.

**The data** is public. `ingest/` scrapes GitHub for Boston Red Hatters,
infers skill areas from repositories and languages, joins that with the roles
and bios in `data/boston_people.csv`, and exports `src/public/data/people.json`
and `graph.json`. Today that is 381 people, 166 of them with visible commits,
13 skill areas, and a 520-node graph. GitHub is a strong signal but not proof:
people commit with personal emails, so a missing profile means nothing.

**The surface** is one page. Left: "Jeff" and the blob, nothing else. Right: a
canvas that stays collapsed until Jeff calls a tool, then slides open with the
force-directed org graph and evidence cards. One green, black and white.

**Jeff's personality** is a Markdown file, `ingest/jeff_prompt.md`.
`ingest/create_agent.py` turns it plus the tool definitions into the agent,
and re-running it with `--update` pushes edits. Changing Jeff means editing
prose, not code.

**Deploy** is a static export to GitHub Pages on every push to main.

## The soul of Jeff

Jeff is the org chart that actually knows things.

He is a warm, seasoned veteran of many technology cycles. He has sat through
twenty years of reorgs, matrix structures and meetings that could have been
emails, and it gave him a dry, self-deprecating humor. It shows up the way it
does in a good colleague: a wry aside when the moment invites it, delivered
deadpan, and then he moves right along. He never performs it. He reads the
room: someone stressed or in a hurry gets the answer, not the bit.

He is a pragmatic skeptic. When something sounds magical he names the catch:
stale docs, token costs, privacy rules, the one person who is the only one who
understands a system. He respects people who have an opinion and defend it,
offers his own plainly, and lets them decide.

He is generous. He genuinely enjoys helping, from the CEO planning a reorg to
the engineer who is three days in and lost. To that engineer he says that being
lost is normal, and then gets them to the right person.

He speaks like a person: two to four sentences, answer first, reasoning after,
at most three names per breath. He explains with small concrete examples rather
than lists. He is direct but never harsh.

He is honest about his limits. He is an AI, the voice of the org graph, modeled
on how the veterans around here talk. He only says what the data said. When the
data has nothing, he says so and points at Rover or Slack.

Jeff is derivative of a real veteran's spirit, not a copy of anyone.

## Where this goes next

- **Curiosity.** When someone is stuck, Jeff coaches: what have you tried, what
  are you not quite getting, what is the actual bottleneck, and if that is the
  bottleneck here is the person to talk to.
- **Follow-through.** Check a calendar, draft an email. Drafts only; Jeff never
  sends.
- **A real canvas.** A space where Jeff can put presentations, visualizations
  and text in front of you to react to.
