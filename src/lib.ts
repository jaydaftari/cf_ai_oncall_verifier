// Pure helpers with no Workers runtime imports, so they can be unit-tested under Node.
import { SEVERITIES, STATUSES } from "./types";
import type {
  ChatMessage,
  Extraction,
  IncidentMeta,
  RecoveryWatch,
  Severity,
  Status,
  TimelineEvent,
} from "./types";

export function clip(value: string, max: number): string {
  const s = value.trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Incremental Server-Sent Events parser. Workers AI streams `data: {...}` lines,
 * and network chunks can split a line anywhere, so we buffer until a newline.
 */
export function createSseParser(onData: (data: string) => void) {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) onData(line.slice(5).trimStart());
      }
    },
    flush() {
      if (buffer.startsWith("data:")) onData(buffer.slice(5).trimStart());
      buffer = "";
    },
  };
}

/** Text delta from one Workers AI stream event (native or OpenAI-compatible shape). */
export function deltaFromEvent(data: string): string {
  if (!data || data === "[DONE]") return "";
  try {
    const event = JSON.parse(data);
    if (typeof event.response === "string") return event.response;
    const content = event.choices?.[0]?.delta?.content;
    return typeof content === "string" ? content : "";
  } catch {
    return "";
  }
}

/** Text (or parsed JSON) from a non-streaming Workers AI result. */
export function resultContent(result: unknown): unknown {
  const r = result as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
  if (r?.response !== undefined) return r.response;
  return r?.choices?.[0]?.message?.content ?? "";
}

export function resultText(result: unknown): string {
  const content = resultContent(result);
  return typeof content === "string" ? content.trim() : JSON.stringify(content);
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The extractor is an LLM, so treat its output as untrusted: parse leniently,
 * keep only known enum values, bound every string, and drop duplicate events.
 */
export function sanitizeExtraction(raw: unknown, existing: TimelineEvent[]): Extraction {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { events: [] };
    }
  }
  if (!value || typeof value !== "object") return { events: [] };
  const v = value as Record<string, unknown>;
  const out: Extraction = { events: [] };

  if (typeof v.title === "string" && v.title.trim()) out.title = clip(v.title, 80);
  if (typeof v.service === "string" && v.service.trim()) out.service = clip(v.service, 60);
  if (SEVERITIES.includes(v.severity as Severity) && v.severity !== "unknown") {
    out.severity = v.severity as Severity;
  }
  if (STATUSES.includes(v.status as Status)) out.status = v.status as Status;

  const seen = new Set(existing.map((e) => normalize(e.event)));
  for (const item of Array.isArray(v.events) ? v.events : []) {
    if (out.events.length >= 5) break;
    const event = typeof item?.event === "string" ? clip(item.event, 280) : "";
    const key = normalize(event);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const time = typeof item?.time === "string" && item.time.trim() ? clip(item.time, 40) : "unspecified";
    out.events.push({ time, event });
  }
  return out;
}

/** Most recent messages that fit in `maxChars`, oldest first. */
export function buildTranscript(messages: ChatMessage[], maxChars = 40_000): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const line = `${m.role === "user" ? "Engineer" : "Copilot"}: ${m.content}`;
    if (used + line.length > maxChars) break;
    lines.unshift(line);
    used += line.length + 2;
  }
  return lines.join("\n\n");
}

const DURATION_UNITS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

/** Milliseconds in a Workflows duration string such as "15 minutes" or "1 hour". */
export function durationMs(duration: string): number {
  const match = duration.trim().match(/^(\d+(?:\.\d+)?)\s*(second|minute|hour|day)s?$/i);
  if (!match) throw new Error(`Unsupported duration: ${duration}`);
  return Number(match[1]) * DURATION_UNITS[match[2]!.toLowerCase()]!;
}

const WATCH_OUTCOMES: Record<string, string> = {
  recovered: "Recovery verified by the on-call engineer",
  regressed: "Regression reported during the recovery watch; incident reopened",
  expired: "No confirmation received; recovery was never verified",
};

export function assemblePostmortem(input: {
  meta: IncidentMeta;
  timeline: string;
  analysis: string;
  actionItems: string;
  watch?: RecoveryWatch;
  generatedAt: Date;
}): string {
  const { meta, watch } = input;
  const verification =
    watch?.workflowId && watch.state
      ? [
          "## Recovery verification",
          "",
          `- Outcome: ${WATCH_OUTCOMES[watch.state] ?? "Watch still in progress"}`,
          `- Check-ins completed: ${watch.round}`,
          "",
        ]
      : [];
  return [
    `# Postmortem: ${meta.title || "Untitled incident"}`,
    "",
    `**Severity:** ${meta.severity} · **Status:** ${meta.status} · **Service:** ${meta.service || "Unknown"}`,
    "",
    input.analysis.trim(),
    "",
    "## Timeline",
    "",
    input.timeline.trim(),
    "",
    ...verification,
    "## Action items",
    "",
    input.actionItems.trim(),
    "",
    "---",
    `_Draft generated by On-Call Verifier on ${input.generatedAt.toISOString()}. Review before publishing._`,
  ].join("\n");
}
