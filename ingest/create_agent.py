#!/usr/bin/env python3
"""Create (or update) the Jeff agent on ElevenLabs.

    export ELEVENLABS_API_KEY=...            # or put it in src/.env.local
    python3 ingest/create_agent.py           # create -> prints the agent id
    python3 ingest/create_agent.py --update agent_xxx   # push prompt/tools/voice again
    python3 ingest/create_agent.py --update agent_xxx --llm gemini-2.5-flash-lite   # a faster brain

    # Optional: run Jeff's brain on GLM instead of an ElevenLabs-hosted model
    python3 ingest/create_agent.py --glm-key "$GLM_API_KEY" [--glm-model glm-4.6]

Then put the printed id in src/.env.local:
    NEXT_PUBLIC_ELEVENLABS_AGENT_ID=agent_xxx

The agent is public (no auth), so the browser connects with just the id.
The API key is only used here, never shipped to the page.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.elevenlabs.io/v1"
ROOT = Path(__file__).resolve().parent
PROMPT = (ROOT / "jeff_prompt.md").read_text()

# Roger: laid-back, casual, resonant, middle-aged American. Warm veteran who
# can land a dad joke without sounding like a cartoon.
VOICE_ID = "CwhRBWXzGAHq8TQ4Fs17"
DEFAULT_LLM = "gemini-2.5-flash"
GLM_URL = "https://open.bigmodel.cn/api/paas/v4"

# Jeff speaks the moment the line opens. A hidden kickoff turn proved
# unreliable (three silent openings in one feedback round), so the opener is a
# first_message the page fills in: it picks one of several lines in Jeff's
# voice per session and passes it as the {{greeting}} dynamic variable.
FIRST_MESSAGE = "{{greeting}}"

# Client tools: the browser answers these (see src/lib/jeffTools.ts).
TOOLS = [
    {
        "name": "find_experts",
        "description": "Rank Red Hat Boston people by real experience in a topic (e.g. 'cluster provisioning', 'vLLM inference', 'Keycloak auth'). Returns ranked candidates with the evidence (commits, repos, role, bio) behind each one. Call this whenever the user asks who knows, owns, or has experience with something.",
        "parameters": {
            "type": "object",
            "properties": {
                "topic": {"type": "string", "description": "The technology, system, or skill area to search for. Include synonyms if the user used jargon."},
                "limit": {"type": "integer", "description": "How many candidates to return (default 5)."},
            },
            "required": ["topic"],
        },
    },
    {
        "name": "lookup_person",
        "description": "Get the full profile of one person by name: role, section, skills, top repositories, bio, public profile.",
        "parameters": {
            "type": "object",
            "properties": {"name": {"type": "string", "description": "The person's name (partial names are fine)."}},
            "required": ["name"],
        },
    },
    {
        "name": "impact_if_moved",
        "description": "Analyze what breaks if these people are moved off their current work: which skill areas and repositories would be left unowned or as a single point of failure, who remains, and a suggested backfill for each risky area. ALWAYS call this before endorsing a staffing move.",
        "parameters": {
            "type": "object",
            "properties": {
                "names": {"type": "array", "items": {"type": "string", "description": "A person's full name."}, "description": "Names of the people being moved."}
            },
            "required": ["names"],
        },
    },
    {
        "name": "team_overview",
        "description": "Summarize the Boston org: sections, headcounts, notable people, and the dominant skills in each. Filter to one section by name or keyword (Leadership, AI / ML, OpenShift & Kubernetes, Linux & virtualization, Developer tools & runtimes, SRE, QA & automation, UX & design, Docs & learning, Product & programs, Sales & partners, Community & ops, Community & alumni; 'platform' covers the four engineering sections) to get everyone in it by name and have them all highlighted on the graph automatically. If the reply says no section matches, do not describe the whole office; use one of the names it lists.",
        "parameters": {
            "type": "object",
            "properties": {"section": {"type": "string", "description": "Optional section name or keyword to filter on."}},
            "required": [],
        },
    },
    {
        "name": "show_on_graph",
        "description": "Highlight people, a whole section, and/or skill areas on the org graph the user is looking at. Call it the moment a group or a set of people comes up, before or while you talk, so the screen moves with you. Pass section to light up everyone in a section (e.g. 'Leadership', all 57). With no people, section or skills it clears the highlight. The graph picks the lens that can show the people (someone with no GitHub footprint only appears in the People lens). Returns nothing useful; do not wait on it for facts.",
        "parameters": {
            "type": "object",
            "properties": {
                "people": {"type": "array", "items": {"type": "string", "description": "A person's full name."}, "description": "Names of people to highlight."},
                "skills": {"type": "array", "items": {"type": "string", "description": "A skill area name."}, "description": "Skill areas to highlight."},
                "section": {"type": "string", "description": "A section name (Leadership, AI/ML, Platform, Product, Community & alumni): highlights everyone in it."},
                "title": {"type": "string", "description": "A short caption for what is being shown, e.g. 'Cluster provisioning experts'."},
                "lens": {"type": "string", "enum": ["people", "skills"], "description": "Optional: force the People lens (everyone by section) or the Skills lens (technical, GitHub-derived)."},
            },
            "required": [],
        },
    },
    {
        "name": "graph_lens",
        "description": "Switch the org graph between the People lens (all 381 Boston people grouped into 11 sections plus Community & alumni: Leadership, AI / ML, OpenShift & Kubernetes, Linux & virtualization, Developer tools & runtimes, SRE, QA & automation, UX & design, Docs & learning, Product & programs, Sales & partners, Community & ops) and the Skills lens (the technical picture: skill areas and GitHub repos, only people with commits). Use People for org shape, leadership, and non-engineering questions; Skills for who-knows-what.",
        "parameters": {
            "type": "object",
            "properties": {"lens": {"type": "string", "enum": ["people", "skills"], "description": "Which lens to show."}},
            "required": ["lens"],
        },
    },
    # ── The whiteboard ──
    {
        "name": "board_explain",
        "description": "Sketch an explanation on the whiteboard with animation. Give a one-line brief of the picture you want (who, what, how it connects, in what order) and it is drawn step by step while you keep talking. Use it whenever a concept has parts: a dependency, a handover, a before/after, a risk map, a team shape. Returns immediately; the board will tell you when it is up so you can narrate it. Only use names and numbers that came from tools in this conversation.",
        "parameters": {
            "type": "object",
            "properties": {
                "brief": {"type": "string", "description": "What to draw, in one or two sentences, e.g. 'Cluster team: Bill and Priya own provisioning; if Priya moves, Marco backfills; arrow from Marco to provisioning; mark storage as risky.'"},
                "facts": {"type": "string", "description": "Names, numbers and repos from earlier tool results that the drawing may use, comma separated."},
            },
            "required": ["brief"],
        },
    },
    {
        "name": "board_write",
        "description": "Put a short list straight onto the whiteboard, one item at a time, with optional connections between items. Fast and simple: use it for options, names, steps, or a checklist you are talking through. Returns immediately.",
        "parameters": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Board title, a few words."},
                "items": {
                    "type": "array",
                    "description": "Up to 12 items in the order you will say them.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "label": {"type": "string", "description": "One to four words."},
                            "kind": {"type": "string", "enum": ["box", "note", "person", "label", "check", "cross"], "description": "box (default) for a thing, person for a named person, note for evidence or an aside, check/cross to mark good/risky."},
                            "detail": {"type": "string", "description": "Optional second line, e.g. '~900 commits'."},
                        },
                        "required": ["label"],
                    },
                },
                "connections": {
                    "type": "array",
                    "description": "Pairs of item labels to draw an arrow between, from first to second.",
                    "items": {"type": "array", "description": "A pair: [from label, to label].", "items": {"type": "string", "description": "An item label exactly as given in items."}},
                },
            },
            "required": ["title", "items"],
        },
    },
    {
        "name": "show_usage",
        "description": "Put the Usage view on the screen: a Sankey diagram of every question people have asked you so far (who asked, by access level -> kind of question: by topic, by person, staffing move, team shape, by region, suggestion, other -> what it was about -> what happened: answered, nothing found, declined) plus a leaderboard of the most-asked topics. Use it when someone asks how you are being used, what people ask about, what is popular, or wants a usage report for leadership. Returns a short summary you can narrate; the screen is interactive and the user can click a node to filter.",
        "parameters": {
            "type": "object",
            "properties": {"focus": {"type": "string", "description": "Optional node to highlight, e.g. a topic name, a kind ('by topic'), an outcome ('nothing found') or an access level ('New hire')."}},
            "required": [],
        },
    },
    {
        "name": "board_clear",
        "description": "Wipe the whiteboard and go back to the org graph. Use when changing subject.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
]

# Tools that draw or highlight never block Jeff: he keeps talking while the screen catches up.
FIRE_AND_FORGET = {"show_on_graph", "graph_lens", "board_explain", "board_write", "board_clear"}


def load_env_key() -> str:
    key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if key:
        return key
    env = ROOT.parent / "src" / ".env.local"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("ELEVENLABS_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("No ELEVENLABS_API_KEY. Export it or add it to src/.env.local (see README).")


def call(key: str, method: str, path: str, body=None):
    req = urllib.request.Request(
        f"{API}{path}", method=method,
        headers={"xi-api-key": key, "Content-Type": "application/json"},
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:1500]
        sys.exit(f"{method} {path} -> HTTP {e.code}\n{detail}")


def ensure_tools(key: str) -> list[str]:
    """Create each client tool (or reuse one with the same name) and return ids."""
    existing = {t.get("tool_config", {}).get("name"): t.get("id")
                for t in call(key, "GET", "/convai/tools").get("tools", [])}
    ids = []
    for tool in TOOLS:
        cfg = {"type": "client", "expects_response": tool["name"] not in FIRE_AND_FORGET,
               "response_timeout_secs": 8, **tool}
        tid = existing.get(tool["name"])
        if tid:
            call(key, "PATCH", f"/convai/tools/{tid}", {"tool_config": cfg})
            print(f"  updated tool {tool['name']} ({tid})")
        else:
            tid = call(key, "POST", "/convai/tools", {"tool_config": cfg})["id"]
            print(f"  created tool {tool['name']} ({tid})")
        ids.append(tid)
    return ids


def ensure_secret(key: str, name: str, value: str) -> str:
    for s in call(key, "GET", "/convai/secrets").get("secrets", []):
        if s.get("name") == name:
            return s["secret_id"]
    return call(key, "POST", "/convai/secrets", {"type": "new", "name": name, "value": value})["secret_id"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--update", metavar="AGENT_ID", help="patch an existing agent instead of creating one")
    ap.add_argument("--name", default="Jeff — Red Hat Boston")
    ap.add_argument("--llm", default=DEFAULT_LLM, help="ElevenLabs-hosted model id (ignored with --glm-key)")
    ap.add_argument("--glm-key", help="Zhipu GLM API key: run the brain on GLM via its OpenAI-compatible endpoint")
    ap.add_argument("--glm-model", default="glm-4.6")
    ap.add_argument("--glm-url", default=GLM_URL)
    a = ap.parse_args()
    key = load_env_key()

    print("tools:")
    tool_ids = ensure_tools(key)

    prompt_cfg = {"prompt": PROMPT, "tool_ids": tool_ids, "temperature": 0.6, "max_tokens": -1}
    if a.glm_key:
        secret_id = ensure_secret(key, "glm_api_key", a.glm_key)
        prompt_cfg["llm"] = "custom-llm"
        prompt_cfg["custom_llm"] = {"url": a.glm_url, "model_id": a.glm_model, "api_key": {"secret_id": secret_id}}
        print(f"brain: GLM {a.glm_model} via {a.glm_url}")
    else:
        prompt_cfg["llm"] = a.llm
        print(f"brain: {a.llm} (ElevenLabs-hosted)")

    config = {
        "name": a.name,
        "conversation_config": {
            "agent": {
                "first_message": FIRST_MESSAGE,
                "language": "en",
                "prompt": prompt_cfg,
            },
            "tts": {
                "voice_id": VOICE_ID,
                "model_id": "eleven_flash_v2",
                "stability": 0.4,
                "similarity_boost": 0.75,
                "speed": 1.05,
            },
            # Let people think. Feedback round 2026-09-27: Jeff cut in on "um"
            # and on pauses mid-thought. Patient turn-taking, and a long quiet
            # before he prompts. If the brain takes more than a beat, he says
            # something natural while thinking instead of going silent.
            "turn": {
                "turn_timeout": 12,
                "mode": "turn",
                "turn_eagerness": "patient",
                "soft_timeout_config": {
                    "timeout_seconds": 1.2,
                    "use_llm_generated_message": True,
                    "llm_generated_message_prompt_override": (
                        "Jeff is still thinking. Say one short natural aside in Jeff's voice that keeps the room warm while he looks something up: "
                        "a half-sentence reaction to what was just asked, a 'hang on, let me pull that up', or a wry beat. Under ten words. No question."
                    ),
                    "randomize_fillers": True,
                    "max_soft_timeouts_per_generation": 1,
                    "disable_until_first_user_message": True,
                },
            },
            "conversation": {"max_duration_seconds": 1200, "client_events": [
                "audio", "interruption", "user_transcript", "agent_response", "agent_response_correction",
                "client_tool_call", "vad_score", "agent_tool_response",
            ]},
        },
        "platform_settings": {"auth": {"enable_auth": False}},
    }

    if a.update:
        call(key, "PATCH", f"/convai/agents/{a.update}", config)
        print(f"updated agent {a.update}")
        agent_id = a.update
    else:
        agent_id = call(key, "POST", "/convai/agents/create", config)["agent_id"]
        print(f"created agent {agent_id}")

    print("\nNext: add this to src/.env.local and restart `npm run dev`:")
    print(f"  NEXT_PUBLIC_ELEVENLABS_AGENT_ID={agent_id}")


if __name__ == "__main__":
    main()
