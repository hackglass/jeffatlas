"use client";

import { useState } from "react";

/**
 * A drafted Slack message for the user to send themselves — there is no real
 * Slack integration. Jeff writes the text; this just displays it and copies
 * it to the clipboard (best-effort: some browsers block clipboard writes
 * that don't originate from a direct click, so the Copy button is the
 * reliable fallback, not an afterthought).
 */
export function SlackDraftCard({ toName, message, autoCopied }: { toName: string; message: string; autoCopied: boolean }) {
  const [copied, setCopied] = useState(autoCopied);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard API unavailable; nothing more we can do from here */
    }
  };

  return (
    <div className="jeff-cards jeff-cards--person">
      <article className="jeff-card">
        <div className="jeff-card-rank">SLACK DRAFT · not sent</div>
        <h3>To {toName}</h3>
        <p className="jeff-slack-message">{message}</p>
        <div className="jeff-graph-card-actions">
          <button type="button" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        </div>
      </article>
    </div>
  );
}
