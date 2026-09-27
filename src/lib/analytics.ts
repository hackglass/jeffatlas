/**
 * Everything that happens with Jeff goes to PostHog: each conversation, each
 * turn on both sides, each tool call with its parameters and result, each
 * click on the canvas and each control press. Runs in the browser, so it
 * works on the static Pages site with no server or database.
 *
 * Off (a silent no-op) when NEXT_PUBLIC_POSTHOG_KEY is not set.
 */

import posthog from "posthog-js";

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "";
const HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";

let ready = false;
let conversationId: string | null = null;
let turnIndex = 0;

export function initAnalytics() {
  if (ready || !KEY || typeof window === "undefined") return;
  posthog.init(KEY, {
    api_host: HOST,
    defaults: "2025-05-24",
    person_profiles: "identified_only",
    autocapture: false, // every interaction is tracked by name below, not by DOM guesswork
    capture_pageview: true,
    capture_pageleave: true,
  });
  ready = true;
}

export const analyticsOn = () => !!KEY;

/** The viewer typed a name or email: from here on, events belong to that person. */
export function identifyViewer(user: string) {
  if (!ready) return;
  const u = user.trim();
  if (u) posthog.identify(u, { name: u });
}

/** Start/end of a conversation: every event in between carries its id. */
export function beginConversation(id: string | null) {
  conversationId = id;
  turnIndex = 0;
}
export function endConversation() { conversationId = null; }

export function track(event: string, props: Record<string, unknown> = {}) {
  if (!ready) return;
  try {
    posthog.capture(event, { conversation_id: conversationId, ...props });
  } catch { /* analytics never breaks the page */ }
}

/** One side of the dialogue. */
export function trackTurn(role: "user" | "jeff", text: string) {
  track("turn", { role, text, turn_index: turnIndex++, chars: text.length });
}

/** A client tool Jeff called, with what he sent and what came back. */
export function trackTool(name: string, params: unknown, result: unknown, ms: number) {
  const r = typeof result === "string" ? result : JSON.stringify(result ?? null);
  track("tool_call", { tool: name, params, result: r.slice(0, 4000), result_chars: r.length, ms });
}
