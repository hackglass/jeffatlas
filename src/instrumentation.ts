/**
 * Server-side logs go to PostHog Logs over OpenTelemetry (OTLP/HTTP), next to
 * the browser events from src/lib/analytics.ts. Next.js calls register() once
 * when the server starts (npm run dev or any Node host); the static GitHub
 * Pages build has no server, so this never runs there.
 *
 * Same project key and host as the browser. Off (no exporter) when
 * NEXT_PUBLIC_POSTHOG_KEY is not set. Routes log through lib/serverLog.ts.
 */

import { logs } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "";
const HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";

export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !KEY) return;
  const provider = new LoggerProvider({
    resource: resourceFromAttributes({ "service.name": "jeff-server" }),
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({
          url: `${HOST.replace(/\/+$/, "")}/i/v1/logs`,
          headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        }),
      }),
    ],
  });
  logs.setGlobalLoggerProvider(provider);
}
