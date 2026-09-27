/**
 * GET /api/convos           — every conversation with Jeff (newest first)
 * GET /api/convos?id=conv_… — one conversation: who, every turn, every tool call
 *
 * The system of record is ElevenLabs: every session the agent runs is stored
 * there with the full transcript, the user id the page passed at start, and
 * each client-tool call with its parameters and result. This route reads it
 * with the server-side key (never shipped to the browser) and normalises it
 * into the shape the x-ray page uses. Nothing is written to disk; the
 * browser-side log of the same events lives in PostHog (src/lib/analytics.ts).
 *
 * Needs a server (npm run dev or any Node host); the static GitHub Pages
 * build has no API routes, so /xray tells the viewer to run it locally.
 */

import { NextResponse } from "next/server";
import { normalise, summarise } from "@/lib/convos";

const API = "https://api.elevenlabs.io/v1";
const KEY = process.env.ELEVENLABS_API_KEY ?? "";
const AGENT = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID ?? "";

export const dynamic = "force-dynamic";

async function el(pathname: string) {
  const r = await fetch(`${API}${pathname}`, { headers: { "xi-api-key": KEY }, cache: "no-store" });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status} on ${pathname}`);
  return r.json();
}


async function fetchConvo(id: string) {
  return normalise(await el(`/convai/conversations/${encodeURIComponent(id)}`));
}

export async function GET(req: Request) {
  if (!KEY || !AGENT) return NextResponse.json({ error: "ELEVENLABS_API_KEY / NEXT_PUBLIC_ELEVENLABS_AGENT_ID not set on the server" }, { status: 503 });
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  try {
    if (id) return NextResponse.json(await fetchConvo(id));
    const list = (await el(`/convai/conversations?agent_id=${AGENT}&page_size=100`)).conversations as Record<string, unknown>[];
    // Detail fetches run in parallel; empty (0-message) sessions are listed without a fetch.
    const convos = await Promise.all(list.map(async (c) => {
      const id = String(c.conversation_id);
      if (!c.message_count) {
        return summarise({ id, startedAt: new Date(Number(c.start_time_unix_secs) * 1000).toISOString(), seconds: (c.call_duration_secs as number) ?? 0,
          userId: null, access: null, status: String(c.status ?? ""), turns: [], toolCalls: 0, questions: 0 });
      }
      return summarise(await fetchConvo(id));
    }));
    return NextResponse.json({ fetchedAt: new Date().toISOString(), conversations: convos });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
