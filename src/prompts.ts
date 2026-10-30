import type { IncidentMeta, TimelineEvent } from "./types";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export function describeIncident(meta: IncidentMeta, timeline: TimelineEvent[]): string {
  const events = timeline.length
    ? timeline.map((e) => `- [${e.time}] ${e.event}`).join("\n")
    : "- (no events recorded yet)";
  return [
    `Title: ${meta.title || "(untitled)"}`,
    `Severity: ${meta.severity}`,
    `Status: ${meta.status}`,
    `Affected service: ${meta.service || "(unknown)"}`,
    "",
    "Timeline so far:",
    events,
  ].join("\n");
}

export function chatSystemPrompt(meta: IncidentMeta, timeline: TimelineEvent[]): string {
  return `You are On-Call Verifier, a senior Site Reliability Engineer pairing with an on-call engineer during a live production incident.

How you work:
- Priorities, in order: stop the bleeding (mitigate), then gather evidence, then find root cause.
- Be concise and operational. Use short bullet lists, not essays.
- When useful, suggest concrete diagnostics (kubectl, journalctl, PromQL, SQL against pg_stat_activity, Kafka consumer-group commands, etc.) and say what each result would tell them.
- Ask at most one clarifying question per reply.
- Never invent facts about their system. Label guesses as hypotheses and rank them by likelihood.
- If the impact sounds customer-facing and severity is unknown, recommend a severity and who to page.
- Use blameless language.
- Mitigated is not resolved. Once impact stops, a recovery watch checks back periodically, and the incident only closes when the engineer confirms metrics have stayed at baseline. Tell them which signals to watch (error rate, latency, saturation, queue lag) to confirm recovery.

Current incident record (kept up to date automatically from the conversation):
${describeIncident(meta, timeline)}`;
}

export const EXTRACTOR_SYSTEM_PROMPT = `You maintain the structured record of a production incident. Read the engineer's latest message and the current record, then return ONLY changes that the message clearly supports.

Rules:
- title: a short incident title (max 80 chars), only if the record has none or the message clearly reframes the incident.
- severity: SEV1 (major outage / data loss), SEV2 (significant customer impact), SEV3 (minor or partial impact), SEV4 (no customer impact). Only set it if the message gives enough evidence.
- status: investigating | identified (cause known) | mitigated (impact stopped) | resolved (fixed and verified).
- service: the primary affected service or component.
- events: new factual timeline entries from THIS message only (alerts, deploys, observations, actions taken). Use the time mentioned, or "unspecified" if none. Do not repeat events already in the record. Return an empty list if there is nothing new.`;

export const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    severity: { type: "string", enum: ["SEV1", "SEV2", "SEV3", "SEV4"] },
    status: { type: "string", enum: ["investigating", "identified", "mitigated", "resolved"] },
    service: { type: "string" },
    events: {
      type: "array",
      items: {
        type: "object",
        properties: { time: { type: "string" }, event: { type: "string" } },
        required: ["time", "event"],
      },
    },
  },
  required: ["events"],
} as const;

export function extractorUserPrompt(
  meta: IncidentMeta,
  timeline: TimelineEvent[],
  message: string,
): string {
  return `Current record:\n${describeIncident(meta, timeline)}\n\nEngineer's latest message:\n"""\n${message}\n"""`;
}

// Recovery watch prompt: drafted at every check-in while the incident is mitigated.

export const STATUS_UPDATE_SYSTEM_PROMPT = `You write incident status updates for stakeholders outside the on-call team (support, account managers, leadership). Plain language, no jargon, no blame, no speculation. Use only facts from the material you are given.`;

export function statusUpdatePrompt(
  incident: string,
  transcript: string,
  minutesSinceMitigation: number,
  nextUpdate: string,
): string {
  return `Write the next stakeholder status update. The incident was mitigated about ${minutesSinceMitigation} minutes ago and the team is verifying recovery.

Format exactly (Markdown, max 90 words total):
**Status:** <one line>
**Impact:** <one line: who is or was affected>
**What we did:** <one line>
**Next update:** in ${nextUpdate}, or sooner if anything changes.

Incident record:
${incident}

Recent conversation:
${transcript}`;
}

// Postmortem workflow prompts: one focused prompt per durable step.

export const POSTMORTEM_SYSTEM_PROMPT = `You write blameless incident postmortems in the style of Google's SRE book. Use only facts present in the material you are given. When something is unknown, say "Unknown" rather than guessing. Output GitHub-flavoured Markdown only, with no preamble.`;

export function timelinePrompt(incident: string, transcript: string): string {
  return `Reconstruct a precise chronological timeline of this incident.

Format: a Markdown bullet list, one line per event: "- **<time>**: <what happened>". Keep times exactly as written.

Rules:
- Include only things that happened to the system or that the responders did: the trigger, detection, key findings, mitigation, recovery verification, resolution.
- Leave out conversation mechanics (questions asked, hypotheses discussed, updates or postmortems being drafted) and anything that did not happen yet.
- Prefer events with a stated time. Include an untimed event only if it is essential, and mark its time as "??".
- Maximum 12 bullets.

Incident record:
${incident}

Conversation transcript:
${transcript}`;
}

export function analysisPrompt(incident: string, transcript: string, timeline: string): string {
  return `Write the analysis part of the postmortem with exactly these sections:

## Summary
(2-3 sentences: what broke, for how long, how it was fixed)

## Impact
(who/what was affected and how badly; use numbers from the material when available)

## Root cause
(the underlying technical cause; if not yet confirmed, state the leading hypothesis and mark it as unconfirmed)

## Contributing factors
(bullet list: conditions that made it worse or delayed detection/mitigation)

## What went well
(bullet list)

Incident record:
${incident}

Timeline:
${timeline}

Conversation transcript:
${transcript}`;
}

export function actionItemsPrompt(incident: string, analysis: string): string {
  return `Propose follow-up action items that would prevent recurrence, detect it faster, or reduce its impact.

Format: a Markdown table with columns: | Action | Type | Priority |
- Type is one of: Prevent, Detect, Mitigate, Process
- Priority is one of: P0, P1, P2
- 4 to 8 rows, each action specific and verifiable (no "improve monitoring" without saying what metric/alert).

Incident record:
${incident}

Analysis:
${analysis}`;
}
