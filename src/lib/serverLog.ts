/**
 * One log line from an API route to PostHog Logs, through the global logger
 * that instrumentation.ts registers. A silent no-op when it registered none.
 * Call only inside a request: the flush is scheduled with after(), so the
 * line is sent once the response is out.
 */

import { logs, SeverityNumber, type AnyValueMap } from "@opentelemetry/api-logs";
import { after } from "next/server";

export function serverLog(body: string, attributes: AnyValueMap = {}, level: "info" | "error" = "info") {
  logs.getLogger("jeff-server").emit({
    body,
    severityNumber: level === "error" ? SeverityNumber.ERROR : SeverityNumber.INFO,
    severityText: level.toUpperCase(),
    attributes,
  });
  after(async () => {
    const provider = logs.getLoggerProvider() as { forceFlush?: () => Promise<void> };
    await provider.forceFlush?.();
  });
}
