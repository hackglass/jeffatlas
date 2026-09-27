/**
 * Conversation records: the shape the x-ray page, the usage export and the
 * /api/convos route share, plus the normaliser from an ElevenLabs
 * conversation record to it.
 */

export type ToolCall = { name: string; params: unknown; result: string | null; error: boolean };
export type XTurn = { role: "user" | "jeff"; text: string; at: number | null; tools: ToolCall[] };
export type Convo = {
  id: string;
  startedAt: string;
  seconds: number | null;
  userId: string | null;
  access: string | null;
  status: string;
  turns: XTurn[];
  toolCalls: number;
  questions: number;
};
export type ConvoSummary = Omit<Convo, "turns"> & { firstQuestion: string | null; flags: string[] };

type RawTurn = {
  role: string; message: string | null; time_in_call_secs: number | null;
  tool_calls?: { tool_name: string; params_as_json?: string }[] | null;
  tool_results?: { tool_name: string; result_value?: string; is_error?: boolean }[] | null;
};

/** Flatten an ElevenLabs conversation record into turns with their tool calls attached. */
export function normalise(raw: Record<string, unknown>): Convo {
  const transcript = (raw.transcript as RawTurn[] | undefined) ?? [];
  const meta = (raw.metadata as Record<string, unknown> | undefined) ?? {};
  const dyn = ((raw.conversation_initiation_client_data as Record<string, unknown> | undefined)?.dynamic_variables ?? {}) as Record<string, unknown>;
  // Results arrive on the turn after the call; pair them by tool name in order.
  const pending = new Map<string, ToolCall[]>();
  const turns: XTurn[] = [];
  let access: string | null = null;
  for (const t of transcript) {
    const tools: ToolCall[] = [];
    for (const r of t.tool_results ?? []) {
      const q = pending.get(r.tool_name);
      const call = q?.shift();
      const val = r.result_value ?? null;
      if (call) { call.result = val; call.error = !!r.is_error; }
      else tools.push({ name: r.tool_name, params: null, result: val, error: !!r.is_error });
      const m = /Viewer access level: ([^(]+)\(/.exec(val ?? "");
      if (m && !access) access = m[1].trim();
    }
    for (const c of t.tool_calls ?? []) {
      let params: unknown = null;
      try { params = c.params_as_json ? JSON.parse(c.params_as_json) : null; } catch { params = c.params_as_json; }
      const call: ToolCall = { name: c.tool_name, params, result: null, error: false };
      tools.push(call);
      pending.set(c.tool_name, [...(pending.get(c.tool_name) ?? []), call]);
    }
    const text = (t.message ?? "").trim();
    if (!text && !tools.length) continue;
    if (t.role === "user" && text.startsWith("[The viewer just sat down")) continue; // the page's hidden kickoff
    turns.push({ role: t.role === "user" ? "user" : "jeff", text, at: t.time_in_call_secs ?? null, tools });
  }
  // Attach late results (they land on a Jeff turn with no message) to the turn that made the call.
  const start = Number(meta.start_time_unix_secs ?? 0);
  const questions = turns.filter((t) => t.role === "user" && t.text.split(/\s+/).length >= 2 && !/^[\s.…-]*$/.test(t.text)).length;
  return {
    id: String(raw.conversation_id),
    startedAt: start ? new Date(start * 1000).toISOString() : "",
    seconds: (meta.call_duration_secs as number | undefined) ?? null,
    userId: (raw.user_id as string | null) ?? (dyn.user_name as string | undefined) ?? null,
    access: access ?? (dyn.access_level as string | undefined) ?? null,
    status: String(raw.status ?? ""),
    turns,
    toolCalls: turns.reduce((n, t) => n + t.tools.filter((c) => c.name !== "contextual_update").length, 0),
    questions,
  };
}

export function summarise(c: Convo): ConvoSummary {
  const { turns, ...rest } = c;
  const firstQuestion = turns.find((t) => t.role === "user" && t.text.split(/\s+/).length >= 3)?.text ?? null;
  const flags: string[] = [];
  const results = turns.flatMap((t) => t.tools.map((x) => x.result ?? ""));
  if (results.some((r) => /no matches|not found|"candidates":\[\]/.test(r))) flags.push("nothing found");
  if (results.some((r) => /blocked at|not available at this viewer/.test(r))) flags.push("declined");
  if (turns.some((t) => t.tools.some((x) => x.name === "record_feedback"))) flags.push("feedback");
  else if (turns.some((t) => t.role === "user" && /suggestion|feature|tool call/i.test(t.text))) flags.push("suggestion");
  if (turns.some((t) => t.tools.some((x) => x.error))) flags.push("tool error");
  return { ...rest, firstQuestion, flags };
}

