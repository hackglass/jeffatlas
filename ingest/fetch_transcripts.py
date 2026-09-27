"""Pull Jeff's conversation transcripts from ElevenLabs and turn them into usage data.

    python3 ingest/fetch_transcripts.py        (reads src/.env.local)

Writes
  src/public/data/usage.json                  one row per question, classified,
                                              which the Usage Sankey on the canvas reads

A "query" is one user turn. Each is classified by what Jeff did with it:
  kind     person | topic | staffing | team | region | suggestion | other
  topic    the thing asked about (find_experts topic, a name, a section)
  outcome  answered | nothing found | declined | no tool | cut off
plus the viewer's access level for the conversation. Filler turns ("...",
"Mm-hmm") are dropped. The classifier is heuristic; edit RULES below when a
new pattern shows up in the output.
"""
import json, os, re, urllib.request, datetime as dt, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
for line in (ROOT / "src/.env.local").read_text().splitlines():
    if "=" in line and not line.startswith("#"):
        k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip())
KEY, AGENT = os.environ["ELEVENLABS_API_KEY"], os.environ["NEXT_PUBLIC_ELEVENLABS_AGENT_ID"]
USAGE = ROOT / "src/public/data/usage.json"

TOOL_KIND = {"find_experts": "topic", "lookup_person": "person", "impact_if_moved": "staffing", "team_overview": "team", "record_feedback": "feedback"}
RULES = [  # (kind, regex on the user's words) tried in order when no data tool was called
    ("suggestion", r"\b(suggestion|feature|tool call|transcript|claude code|sankey)\b"),
    ("region", r"\b(region|office|country|countr|geograph|timezone|time zone|remote|raleigh|brno|bangalore|pune|europe|emea|apac|latam|where (is|are|does)|based in)\b"),
    ("staffing", r"\b(move|transfer|reassign|backfill|staff)\b"),
    ("topic", r"\b(who (knows|owns|should i talk|do i talk|can help)|expert|experience|in charge of|knowledgeable|lead)\b"),
    ("person", r"(?-i:\b(?:[Ww]ho is|[Ww]ho's|profile of|tell me about) [A-Z][a-z]+)"),
    ("team", r"\b(team|section|org|department|leadership)\b"),
]
FILLER = re.compile(r"^[\s.\-–…]*$|^(mm+|hmm+|um+|uh+|ok(ay)?|yes|yeah|no|i'm|so-?)[\s.,!]*$", re.I)


def get(path):
    r = urllib.request.Request("https://api.elevenlabs.io/v1" + path, headers={"xi-api-key": KEY})
    return json.load(urllib.request.urlopen(r))


def access_of(transcript):
    for t in transcript:
        for tr in t.get("tool_results") or []:
            m = re.search(r"Viewer access level: ([^(]+)\(", str(tr.get("result_value", "")))
            if m: return m.group(1).strip()
        if t["role"] == "user": break
    return "Unknown"


def classify(user_text, reply):
    """reply: the agent turns up to the next user turn. Returns (kind, topic, outcome, tool)."""
    calls = [(tc.get("tool_name"), tc.get("params_as_json") or "{}") for t in reply for tc in (t.get("tool_calls") or [])]
    results = {tr.get("tool_name"): str(tr.get("result_value", "")) for t in reply for tr in (t.get("tool_results") or [])}
    said = " ".join(t.get("message") or "" for t in reply)
    for name, params in calls:
        if name in TOOL_KIND:
            try: p = json.loads(params)
            except Exception: p = {}
            topic = p.get("topic") or p.get("name") or p.get("section") or ", ".join(p.get("names") or []) or "(unspecified)"
            res = results.get(name, "")
            if name == "record_feedback":
                return "feedback", (p.get("kind") or "suggestion"), "filed", name
            if "blocked" in res or "not available at this viewer" in res: outcome = "declined"
            elif '"candidates":[]' in res or "no matches" in res or "not found" in res or "result" in res[:20]: outcome = "nothing found"
            elif not res: outcome = "cut off"
            else: outcome = "answered"
            return TOOL_KIND[name], topic.strip(), outcome, name
    text = user_text.strip()
    for kind, rx in RULES:
        if re.search(rx, text, re.I):
            topic = re.sub(r"^(who (is|should i talk to|knows|'s)|what|tell me|can you|jeff,?)\s*(about|on|the)?\s*", "", text, flags=re.I)
            topic = re.sub(r"[?.!].*$", "", topic).strip()[:60] or kind
            outcome = "cut off" if not said.strip() else ("declined" if re.search(r"\b(can't|cannot|not something i can|my tools)\b", said, re.I) else "no tool")
            return kind, topic, outcome, None
    outcome = "cut off" if not said.strip() else ("declined" if re.search(r"\b(can't|cannot|not sure what you mean)\b", said, re.I) else "no tool")
    return "other", re.sub(r"[?.!].*$", "", text).strip()[:60] or "(chit-chat)", outcome, None


def feedback_of(transcript):
    """Every record_feedback call: what people told Jeff about Jeff."""
    out = []
    for t in transcript:
        for tc in t.get("tool_calls") or []:
            if tc.get("tool_name") != "record_feedback": continue
            try: p = json.loads(tc.get("params_as_json") or "{}")
            except Exception: p = {}
            if p.get("note"): out.append({"kind": p.get("kind") or "suggestion", "note": p["note"], "t": t.get("time_in_call_secs")})
    return out


def queries_of(conv, transcript):
    out = []
    for i, t in enumerate(transcript):
        if t["role"] != "user": continue
        text = (t.get("message") or "").strip()
        if not text or FILLER.match(text) or len(text.split()) < 2 or text.startswith("[The viewer just sat down"): continue
        reply = []
        for u in transcript[i + 1:]:
            if u["role"] == "user": break
            reply.append(u)
        kind, topic, outcome, tool = classify(text, reply)
        out.append({"kind": kind, "topic": topic, "outcome": outcome, "tool": tool, "text": text[:200],
                    "t": t.get("time_in_call_secs")})
    return out


def main():
    convs = get(f"/convai/conversations?agent_id={AGENT}&page_size=100")["conversations"]
    usage = []
    for c in convs:
        cid = c["conversation_id"]
        if not c.get("message_count"): continue
        d = get(f"/convai/conversations/{cid}")
        tr = d.get("transcript", [])
        started = dt.datetime.fromtimestamp(c["start_time_unix_secs"])
        access = access_of(tr)
        qs = queries_of(c, tr)
        dyn = (d.get("conversation_initiation_client_data") or {}).get("dynamic_variables") or {}
        user = d.get("user_id") or dyn.get("user_name") or None
        fb = feedback_of(tr)
        usage.append({"id": cid, "startedAt": started.isoformat(timespec="minutes"), "seconds": c.get("call_duration_secs"),
                      "access": access, "user": user, "queries": qs, "feedback": fb})
    n_fb = sum(len(u["feedback"]) for u in usage)
    USAGE.write_text(json.dumps({"exportedAt": dt.datetime.now().isoformat(timespec="minutes"), "source": "elevenlabs",
                                 "conversations": usage}, indent=1))
    n = sum(len(u["queries"]) for u in usage)
    print(f"{len(usage)} conversations, {n} queries, {n_fb} feedback notes → {USAGE.relative_to(ROOT)}")
    for u in usage:
        for f in u["feedback"]:
            print(f"  FEEDBACK {f['kind']:10} {u['user'] or 'anonymous'}: {f['note']}")
    for u in usage:
        for q in u["queries"]:
            print(f"  {u['startedAt'][5:]} {u['access']:14} {q['kind']:10} {q['outcome']:14} {q['topic'][:40]!r}")


if __name__ == "__main__":
    main()
