/**
 * POST /api/board — Jeff's drawing brain.
 *
 * The voice agent stays fast and light; this route does the slow, heavy
 * part. It takes a one-line brief from Jeff ("show how the Keycloak team
 * backs up the cluster team, three steps") plus whatever is on screen, and
 * asks a model for a whiteboard scene: boxes, people, arrows, groups, in the
 * order they should appear. The page animates it while Jeff keeps talking.
 *
 * Providers (first one with a key wins):
 *   1. Sciforium (hackathon, OpenAI-compatible): SCIFORIUM_API_KEY,
 *      SCIFORIUM_MODEL, optional SCIFORIUM_BASE_URL. JSON mode + zod check,
 *      one retry with the validation error fed back.
 *   2. Anthropic: ANTHROPIC_API_KEY, optional BOARD_MODEL. Structured output.
 *
 * Not available on the static GitHub Pages build; the page falls back to
 * Jeff's direct board_write tool when this returns an error.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { PostHog } from "posthog-node";
import { z } from "zod";
import { SceneSchema, BOARD_W, BOARD_H, type Scene } from "@/lib/board";
import { serverLog } from "@/lib/serverLog";

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST;

if ((!posthogKey || !posthogHost) && process.env.NODE_ENV !== "production") {
  const missingVariable = posthogKey ? "NEXT_PUBLIC_POSTHOG_HOST" : "NEXT_PUBLIC_POSTHOG_KEY";
  throw new Error(`${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`);
}

const posthog = posthogKey && posthogHost
  ? new PostHog(posthogKey, { host: posthogHost, privacyMode: false, flushAt: 1, flushInterval: 0 })
  : null;
const aiSessionId = `board-server-${process.pid}`;

const SYSTEM = `You are the whiteboard hand of Jeff, a veteran engineer at Red Hat Boston who explains things by sketching while he talks. Turn his brief into a whiteboard scene that a person in the room would find clear at a glance.

Board: ${BOARD_W} wide by ${BOARD_H} tall. Leave a 60px margin. Shapes are placed by centre.

Design rules:
- 3 to 6 steps. Each step adds one idea: a few elements, never the whole board at once. Steps read left to right or top to bottom in the order Jeff would say them.
- Use "person" for a named person (text = their name, e.g. "Bill Burke"). Use "box" for a system, team, or concept. Use "note" for a short aside or evidence ("~900 commits to Keycloak"). Use "group" (drawn behind, with its title) to fence a team or an area; place the members inside its rectangle. Use "arrow" for a relationship, flow, or dependency between two element ids. Use "check" / "cross" beside an item to mark good / risky. Use "label" for a free-standing heading.
- Keep text to 1 to 5 words per element. Names exactly as given in the brief; never invent people, numbers, or systems that are not in the brief.
- Typical sizes: box 200x80, note 220x70, group large enough to contain its members with 30px padding. Space elements so nothing overlaps; arrows need room to be seen.
- Every step should have a one-line caption in Jeff's plain spoken voice, no jargon, no lists, no "Step 1:" prefixes. Refer to people by name, not by pronoun.
- Use highlight to spotlight the elements the caption is about.
- Emphasis "strong" for the single point of the drawing, "muted" for context.`;

/** Plain-language schema for JSON-mode providers that cannot take a JSON schema. */
const JSON_SHAPE = `Reply with ONLY a JSON object, no prose, no markdown fences, shaped exactly like:
{
  "title": string,
  "steps": [
    {
      "caption": string,
      "add": [
        {
          "id": string (unique, short, e.g. "priya"),
          "kind": "box" | "note" | "person" | "group" | "label" | "arrow" | "check" | "cross",
          "text": string | null,
          "x": number, "y": number   (arrows: 0, 0),
          "w": number | null, "h": number | null,
          "from": string | null, "to": string | null   (element ids; arrows only),
          "emphasis": "strong" | "normal" | "muted" | null
        }
      ],
      "highlight": string[] | null   (element ids)
    }
  ]
}
Every key must be present on every element (use null when it does not apply). Arrows must reference ids added in the same or an earlier step.`;

function userMessage(brief: string, context: string) {
  return `Jeff's brief: ${brief}${context ? `\n\nWhat is on screen / known facts (use only these names and numbers):\n${context}` : ""}`;
}

// ---------- Sciforium (OpenAI-compatible) ----------

async function chatCompletion(messages: { role: string; content: string }[], traceId: string) {
  const startedAt = Date.now();
  const base = (process.env.SCIFORIUM_BASE_URL ?? "https://api.sciforium.com/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.SCIFORIUM_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.SCIFORIUM_MODEL,
      messages,
      temperature: 0.4,
      max_tokens: 4000,
      response_format: { type: "json_object" },
      // DeepSeek on this endpoint reasons for ~8s before answering; the
      // layout is good enough without it. SCIFORIUM_THINKING=1 turns it back on.
      ...(process.env.SCIFORIUM_THINKING ? {} : { chat_template_kwargs: { thinking: false } }),
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`Sciforium ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text: string = data?.choices?.[0]?.message?.content ?? "";
  posthog?.capture({
    distinctId: aiSessionId,
    event: "$ai_generation",
    properties: {
      $ai_trace_id: traceId,
      $ai_session_id: aiSessionId,
      $process_person_profile: false,
      $ai_provider: "sciforium",
      $ai_model: process.env.SCIFORIUM_MODEL,
      $ai_input: messages,
      $ai_output_choices: [{ role: "assistant", content: text }],
      $ai_input_tokens: data?.usage?.prompt_tokens,
      $ai_output_tokens: data?.usage?.completion_tokens,
      $ai_latency: (Date.now() - startedAt) / 1000,
    },
  });
  return { text, usage: data?.usage };
}

function extractJson(text: string): unknown {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(stripped); } catch { /* fall through */ }
  const a = stripped.indexOf("{"), b = stripped.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(stripped.slice(a, b + 1));
  throw new Error("no JSON object in reply");
}

/** Fill in what a JSON-mode model tends to leave out: nulls for unused keys, 0,0 for arrows. */
function normalize(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const scene = raw as { steps?: unknown };
  if (!Array.isArray(scene.steps)) return raw;
  for (const step of scene.steps as Record<string, unknown>[]) {
    if (!step || typeof step !== "object") continue;
    if (!("highlight" in step)) step.highlight = null;
    if (!Array.isArray(step.add)) continue;
    for (const el of step.add as Record<string, unknown>[]) {
      if (!el || typeof el !== "object") continue;
      for (const k of ["text", "w", "h", "from", "to", "emphasis"]) if (!(k in el)) el[k] = null;
      if (el.kind === "arrow") { el.x = typeof el.x === "number" ? el.x : 0; el.y = typeof el.y === "number" ? el.y : 0; }
    }
  }
  return raw;
}

async function sceneViaSciforium(brief: string, context: string): Promise<{ scene: Scene; usage?: unknown }> {
  const messages = [
    { role: "system", content: `${SYSTEM}\n\n${JSON_SHAPE}` },
    { role: "user", content: userMessage(brief, context) },
  ];
  const traceId = randomUUID();
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, usage } = await chatCompletion(messages, traceId);
    try {
      const parsed = SceneSchema.safeParse(normalize(extractJson(text)));
      if (parsed.success) return { scene: parsed.data, usage };
      lastErr = z.prettifyError(parsed.error);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    messages.push({ role: "assistant", content: text });
    messages.push({ role: "user", content: `That JSON did not validate:\n${lastErr}\n\nReturn the corrected JSON object only.` });
  }
  throw new Error(`Could not parse a scene: ${lastErr}`);
}

// ---------- Anthropic ----------

async function sceneViaAnthropic(brief: string, context: string): Promise<{ scene: Scene; usage?: unknown }> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.BOARD_MODEL ?? "claude-opus-5";
  const messages = [{ role: "user" as const, content: userMessage(brief, context) }];
  const traceId = randomUUID();
  const startedAt = Date.now();
  const response = await anthropic.messages.parse({
    model,
    max_tokens: 6000,
    system: SYSTEM,
    output_config: { effort: "low", format: zodOutputFormat(SceneSchema) },
    messages,
  });
  posthog?.capture({
    distinctId: aiSessionId,
    event: "$ai_generation",
    properties: {
      $ai_trace_id: traceId,
      $ai_session_id: aiSessionId,
      $process_person_profile: false,
      $ai_provider: "anthropic",
      $ai_model: model,
      $ai_input: [{ role: "system", content: SYSTEM }, ...messages],
      $ai_output_choices: [{ role: "assistant", content: response.content }],
      $ai_input_tokens: response.usage.input_tokens,
      $ai_output_tokens: response.usage.output_tokens,
      $ai_latency: (Date.now() - startedAt) / 1000,
    },
  });
  if (response.stop_reason === "refusal") throw new Error("The drawing brain declined this one.");
  if (!response.parsed_output) throw new Error("Could not parse a scene.");
  return { scene: response.parsed_output, usage: response.usage };
}

// ---------- Route ----------

export async function POST(req: Request) {
  const provider = process.env.SCIFORIUM_API_KEY ? "sciforium" : process.env.ANTHROPIC_API_KEY ? "anthropic" : null;
  if (!provider) return NextResponse.json({ error: "No drawing-brain key set (SCIFORIUM_API_KEY or ANTHROPIC_API_KEY)." }, { status: 503 });
  if (provider === "sciforium" && !process.env.SCIFORIUM_MODEL) return NextResponse.json({ error: "SCIFORIUM_MODEL is not set." }, { status: 503 });

  let body: { brief?: string; context?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Bad JSON" }, { status: 400 }); }
  const brief = String(body.brief ?? "").trim();
  if (!brief) return NextResponse.json({ error: "brief is required" }, { status: 400 });
  const context = String(body.context ?? "").trim();

  try {
    const t0 = Date.now();
    const { scene, usage } = provider === "sciforium" ? await sceneViaSciforium(brief, context) : await sceneViaAnthropic(brief, context);
    const ms = Date.now() - t0;
    serverLog("board scene drawn", { route: "/api/board", provider, brief, ms, steps: scene.steps.length });
    return NextResponse.json({ scene, usage, provider, ms });
  } catch (err) {
    const msg = err instanceof Anthropic.APIError ? `${err.status} ${err.message}` : err instanceof Error ? err.message : "unknown error";
    console.error(`[board:${provider}]`, msg);
    serverLog("board scene failed", { route: "/api/board", provider, brief, error: msg }, "error");
    return NextResponse.json({ error: msg }, { status: 502 });
  } finally {
    await posthog?.flush();
  }
}
