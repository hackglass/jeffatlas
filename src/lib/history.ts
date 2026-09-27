/**
 * Conversation history: every turn of every session, both sides.
 *
 * The site is a static export with no server, so history lives in
 * localStorage under one key, newest session last. Each turn carries who
 * said it (user / jeff / tool) and when. `downloadHistory` hands the whole
 * thing over as a JSON file so it can be moved somewhere durable.
 */

export type TurnRole = "user" | "jeff" | "tool";
export type Turn = { t: string; role: TurnRole; text: string };
export type Session = {
  id: string;
  startedAt: string;
  endedAt?: string;
  access: string;
  turns: Turn[];
};

const KEY = "jeff.history";
const MAX_SESSIONS = 200;
const MAX_BYTES = 4_000_000; // stay well under the usual 5 MB origin quota

function read(): Session[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session[]) : [];
  } catch {
    return [];
  }
}

function write(sessions: Session[]) {
  try {
    let list = sessions.slice(-MAX_SESSIONS);
    let raw = JSON.stringify(list);
    // Drop the oldest sessions until it fits.
    while (raw.length > MAX_BYTES && list.length > 1) {
      list = list.slice(1);
      raw = JSON.stringify(list);
    }
    localStorage.setItem(KEY, raw);
  } catch {
    /* private mode or quota: history is best-effort */
  }
}

export function startSession(access: string): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const sessions = read();
  sessions.push({ id, startedAt: new Date().toISOString(), access, turns: [] });
  write(sessions);
  return id;
}

export function appendTurn(sessionId: string | null, role: TurnRole, text: string) {
  if (!sessionId || !text.trim()) return;
  const sessions = read();
  const s = sessions.find((x) => x.id === sessionId);
  if (!s) return;
  s.turns.push({ t: new Date().toISOString(), role, text: text.trim() });
  write(sessions);
}

export function endSession(sessionId: string | null) {
  if (!sessionId) return;
  const sessions = read();
  const s = sessions.find((x) => x.id === sessionId);
  if (!s) return;
  s.endedAt = new Date().toISOString();
  write(sessions);
}

export function listSessions(): Session[] {
  return read();
}

export function historyStats(): { sessions: number; turns: number } {
  const sessions = read();
  return { sessions: sessions.length, turns: sessions.reduce((n, s) => n + s.turns.length, 0) };
}

/** Save the whole history as a JSON file (browser download). */
export function downloadHistory() {
  const sessions = read();
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), sessions }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `jeff-history-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function clearHistory() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
