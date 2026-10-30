import { DurableObject } from "cloudflare:workers";
import { createSseParser, deltaFromEvent, durationMs, resultContent, sanitizeExtraction } from "./lib";
import {
  EXTRACTION_SCHEMA,
  EXTRACTOR_SYSTEM_PROMPT,
  MODEL,
  chatSystemPrompt,
  extractorUserPrompt,
} from "./prompts";
import { MAX_RECOVERY_CHECKS, SEVERITIES, STATUSES } from "./types";
import type {
  ChatMessage,
  IncidentMeta,
  IncidentSnapshot,
  PostmortemJob,
  RecoveryWatch,
  Severity,
  StakeholderUpdate,
  Status,
  TimelineEvent,
  Verdict,
  WatchState,
} from "./types";

const CHAT_HISTORY_TURNS = 20;
const MAX_MESSAGE_CHARS = 8_000;
// Exact per-incident guards; the per-IP limiter in the Worker is best-effort.
const MAX_MESSAGES_PER_INCIDENT = 300;
const REPLY_LOCK_MS = 60_000;
export const VERDICT_EVENT = "recovery-verdict";

const utcNow = () => `${new Date().toISOString().slice(11, 16)} UTC`;

/**
 * One Durable Object per incident. It is the single source of truth for that
 * incident: chat history, the structured record (title, severity, status,
 * service), the timeline, stakeholder updates, and Workflow progress, all in
 * its SQLite storage. Every request for an incident is routed to the same
 * instance, so writes are serialized and the record never races with itself.
 *
 * It also owns the incident's status state machine: moving to "mitigated"
 * starts a RecoveryWatchWorkflow, and leaving "mitigated" (whether by a button,
 * a dropdown, or the extractor reading the chat) ends it with a verdict.
 */
export class IncidentRoom extends DurableObject<Env> {
  private sql: SqlStorage;
  private replyStartedAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS timeline (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        time TEXT NOT NULL,
        event TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        round INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  // ---------------------------------------------------------------- RPC API

  async getSnapshot(): Promise<IncidentSnapshot> {
    return this.snapshot();
  }

  /** Manual edits from the UI. A manually set field is locked against the extractor. */
  async updateMeta(
    incidentId: string,
    patch: { severity?: string; status?: string },
  ): Promise<IncidentSnapshot> {
    this.remember(incidentId);
    if (SEVERITIES.includes(patch.severity as Severity)) {
      this.setMeta({ severity: patch.severity!, severity_locked: "1" });
    }
    if (STATUSES.includes(patch.status as Status)) {
      this.setMeta({ status_locked: "1" });
      await this.transition(patch.status as Status);
    }
    return this.snapshot();
  }

  /** The engineer's answer to a recovery check-in. */
  async recordVerdict(incidentId: string, verdict: Verdict): Promise<IncidentSnapshot> {
    this.remember(incidentId);
    await this.transition(verdict === "recovered" ? "resolved" : "investigating");
    return this.snapshot();
  }

  async startPostmortem(workflowId: string): Promise<void> {
    this.setMeta({ pm_workflow: workflowId, pm_stage: "Queued", pm_markdown: null, pm_error: null });
  }

  async setPostmortemStage(stage: string): Promise<void> {
    this.setMeta({ pm_stage: stage });
  }

  async savePostmortem(markdown: string): Promise<void> {
    this.setMeta({ pm_markdown: markdown, pm_stage: "Complete", pm_error: null });
  }

  async failPostmortem(error: string): Promise<void> {
    this.setMeta({ pm_stage: "Failed", pm_error: error });
  }

  // Recovery watch callbacks. Each takes the caller's workflow ID so that a
  // superseded watch (incident re-mitigated, or cleared) can't write state.

  /** null while the watch is still live, otherwise why it should stop. */
  async watchOutcome(workflowId: string): Promise<WatchState | "superseded" | null> {
    const watch = this.watch();
    if (watch.workflowId !== workflowId) return "superseded";
    return watch.state === "waiting" || watch.state === "awaiting" ? null : watch.state;
  }

  async postCheckIn(workflowId: string, round: number, update: string, minutes: number): Promise<void> {
    if ((await this.watchOutcome(workflowId)) !== null) return;
    this.sql.exec(
      "INSERT INTO updates (round, content, created_at) VALUES (?, ?, ?)",
      round,
      update,
      Date.now(),
    );
    this.insertMessage(
      "assistant",
      `**Recovery check #${round}**: ${minutes} minute${minutes === 1 ? "" : "s"} since mitigation.\n\n` +
        "Are error rates, latency and saturation still at baseline? Answer with the buttons in the panel, " +
        "or just tell me what the dashboards show.\n\nI drafted a stakeholder update in the panel.",
    );
    this.setMeta({
      watch_state: "awaiting",
      watch_round: String(round),
      watch_next_at: String(Date.now() + durationMs(this.env.RECOVERY_CHECK_INTERVAL)),
    });
  }

  async watchExpired(workflowId: string): Promise<void> {
    if ((await this.watchOutcome(workflowId)) !== null) return;
    this.setMeta({ watch_state: "expired", watch_next_at: null });
    this.addTimelineEvent(utcNow(), "Recovery watch expired without confirmation");
    this.insertMessage(
      "assistant",
      "**Recovery watch expired.** Nobody confirmed recovery after the final check-in, so I'm leaving the incident " +
        "as *mitigated* rather than closing it. Verify the dashboards and resolve it manually when you're sure.",
    );
  }

  async reset(): Promise<void> {
    const watch = this.watch();
    if (watch.workflowId && (watch.state === "waiting" || watch.state === "awaiting")) {
      await this.env.RECOVERY.get(watch.workflowId)
        .then((instance) => instance.terminate())
        .catch(() => {});
    }
    this.sql.exec("DELETE FROM messages; DELETE FROM timeline; DELETE FROM updates; DELETE FROM meta;");
  }

  // ------------------------------------------------------- streaming chat

  /** POST {message} -> SSE stream of {type:"delta"|"state"|"done"|"error"} events. */
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const incidentId = new URL(request.url).pathname.split("/")[3];
    if (incidentId) this.remember(incidentId);

    const body = (await request.json().catch(() => null)) as { message?: unknown } | null;
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) return Response.json({ error: "message is required" }, { status: 400 });
    if (message.length > MAX_MESSAGE_CHARS) {
      return Response.json({ error: `message exceeds ${MAX_MESSAGE_CHARS} characters` }, { status: 413 });
    }
    // One model reply at a time per incident. The lock expires on its own in
    // case a client disconnects mid-stream and flush never runs.
    if (Date.now() - this.replyStartedAt < REPLY_LOCK_MS) {
      return Response.json({ error: "Wait for the current reply to finish." }, { status: 409 });
    }
    const { n } = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one();
    if (n >= MAX_MESSAGES_PER_INCIDENT) {
      return Response.json(
        { error: "This incident has reached its message limit. Start a new incident." },
        { status: 429 },
      );
    }
    this.replyStartedAt = Date.now();

    const meta = this.meta();
    const timeline = this.timeline();
    const history = this.messages(CHAT_HISTORY_TURNS);
    const userMessageId = this.insertMessage("user", message);

    // Structured-record extraction runs alongside the chat reply; the updated
    // record is sent as the final event of the stream.
    const extraction = this.extractAndApply(message, meta, timeline).catch((err) =>
      console.error("extraction failed", err),
    );

    let upstream: ReadableStream<Uint8Array>;
    try {
      upstream = (await this.env.AI.run(MODEL, {
        messages: [
          { role: "system", content: chatSystemPrompt(meta, timeline) },
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: message },
        ],
        stream: true,
        max_tokens: 1024,
        temperature: 0.3,
      })) as ReadableStream<Uint8Array>;
    } catch (err) {
      console.error("chat model call failed", err);
      // Don't leave an unanswered turn in the history the next prompt is built from.
      this.sql.exec("DELETE FROM messages WHERE id = ?", userMessageId);
      this.replyStartedAt = 0;
      return Response.json({ error: "The model is unavailable, please retry." }, { status: 502 });
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let reply = "";
    let parser: ReturnType<typeof createSseParser>;
    const send = (controller: TransformStreamDefaultController<Uint8Array>, payload: unknown) =>
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

    const relay = new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        parser = createSseParser((data) => {
          const text = deltaFromEvent(data);
          if (!text) return;
          reply += text;
          send(controller, { type: "delta", text });
        });
      },
      transform(chunk) {
        parser.push(decoder.decode(chunk, { stream: true }));
      },
      flush: async (controller) => {
        parser.flush();
        if (reply.trim()) this.insertMessage("assistant", reply);
        else send(controller, { type: "error", error: "The model returned an empty reply." });
        await extraction;
        this.replyStartedAt = 0;
        send(controller, { type: "state", state: this.snapshot() });
        send(controller, { type: "done" });
      },
    });

    return new Response(upstream.pipeThrough(relay), {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      },
    });
  }

  // ------------------------------------------------------------- internals

  private async extractAndApply(message: string, meta: IncidentMeta, timeline: TimelineEvent[]) {
    const result = await this.env.AI.run(MODEL, {
      messages: [
        { role: "system", content: EXTRACTOR_SYSTEM_PROMPT },
        { role: "user", content: extractorUserPrompt(meta, timeline, message) },
      ],
      response_format: { type: "json_schema", json_schema: EXTRACTION_SCHEMA },
      max_tokens: 512,
      temperature: 0,
    });
    const update = sanitizeExtraction(resultContent(result), this.timeline());
    const locked = this.rawMeta();

    if (update.title && !meta.title) this.setMeta({ title: update.title });
    if (update.service) this.setMeta({ service: update.service });
    if (update.severity && !locked.severity_locked) this.setMeta({ severity: update.severity });
    for (const e of update.events) this.addTimelineEvent(e.time, e.event);
    if (update.status && !locked.status_locked) await this.transition(update.status);
  }

  /** The only place status changes, so the recovery watch can't drift out of sync. */
  private async transition(next: Status) {
    if (next === this.meta().status) return;
    this.setMeta({ status: next });

    const { state } = this.watch();
    const watching = state === "waiting" || state === "awaiting";
    if (next === "mitigated" && !watching) await this.startWatch();
    else if (next !== "mitigated" && watching) await this.endWatch(next === "resolved" ? "recovered" : "regressed");
  }

  private async startWatch() {
    const incidentId = this.rawMeta().incident_id;
    if (!incidentId) return console.error("cannot start recovery watch: incident id unknown");

    const interval = this.env.RECOVERY_CHECK_INTERVAL;
    const instance = await this.env.RECOVERY.create({ params: { incidentId } });
    this.setMeta({
      watch_workflow: instance.id,
      watch_state: "waiting",
      watch_round: "0",
      watch_started_at: String(Date.now()),
      watch_next_at: String(Date.now() + durationMs(interval)),
    });
    this.addTimelineEvent(utcNow(), `Impact mitigated; recovery watch started (first check in ${interval})`);
  }

  private async endWatch(verdict: Verdict) {
    const { workflowId } = this.watch();
    this.setMeta({ watch_state: verdict, watch_next_at: null });
    if (verdict === "recovered") {
      this.addTimelineEvent(utcNow(), "Recovery verified by on-call engineer; incident resolved");
      this.insertMessage("assistant", "**Recovery verified.** Marking the incident resolved. Generate the postmortem while it's fresh.");
    } else {
      this.addTimelineEvent(utcNow(), "Regression reported during recovery watch; incident reopened");
      this.insertMessage(
        "assistant",
        "**Regression reported, so the incident is reopened.** What changed? Paste the alert or the metric that moved and we'll pick the investigation back up.",
      );
    }
    // Wake the Workflow if it's blocked in waitForEvent. If it's sleeping, it
    // sees the verdict via watchOutcome() when it wakes.
    if (workflowId) {
      await this.env.RECOVERY.get(workflowId)
        .then((instance) => instance.sendEvent({ type: VERDICT_EVENT, payload: { verdict } }))
        .catch((err) => console.warn("could not signal recovery watch", err));
    }
  }

  private snapshot(): IncidentSnapshot {
    return {
      meta: this.meta(),
      timeline: this.timeline(),
      messages: this.messages(200),
      postmortem: this.postmortem(),
      watch: this.watch(),
      updates: this.updates(),
    };
  }

  private remember(incidentId: string) {
    if (!this.rawMeta().incident_id) this.setMeta({ incident_id: incidentId });
  }

  private rawMeta(): Record<string, string> {
    const rows = this.sql.exec<{ key: string; value: string }>("SELECT key, value FROM meta").toArray();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  private meta(): IncidentMeta {
    const m = this.rawMeta();
    return {
      title: m.title ?? "",
      severity: (m.severity as Severity) ?? "unknown",
      status: (m.status as Status) ?? "investigating",
      service: m.service ?? "",
    };
  }

  private postmortem(): PostmortemJob {
    const m = this.rawMeta();
    return {
      workflowId: m.pm_workflow ?? null,
      stage: m.pm_stage ?? null,
      markdown: m.pm_markdown ?? null,
      error: m.pm_error ?? null,
    };
  }

  private watch(): RecoveryWatch {
    const m = this.rawMeta();
    return {
      workflowId: m.watch_workflow ?? null,
      state: (m.watch_state as WatchState) ?? null,
      round: Number(m.watch_round ?? 0),
      maxChecks: MAX_RECOVERY_CHECKS,
      nextCheckAt: m.watch_next_at ? Number(m.watch_next_at) : null,
    };
  }

  private setMeta(values: Record<string, string | null>) {
    for (const [key, value] of Object.entries(values)) {
      if (value === null) {
        this.sql.exec("DELETE FROM meta WHERE key = ?", key);
      } else {
        this.sql.exec(
          "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          key,
          value,
        );
      }
    }
  }

  private timeline(): TimelineEvent[] {
    return this.sql
      .exec<{ id: number; time: string; event: string }>("SELECT id, time, event FROM timeline ORDER BY id")
      .toArray();
  }

  private addTimelineEvent(time: string, event: string) {
    this.sql.exec("INSERT INTO timeline (time, event) VALUES (?, ?)", time, event);
  }

  private updates(): StakeholderUpdate[] {
    return this.sql
      .exec<{ round: number; content: string; created_at: number }>(
        "SELECT round, content, created_at FROM updates ORDER BY id",
      )
      .toArray()
      .map((r) => ({ round: r.round, content: r.content, createdAt: r.created_at }));
  }

  private messages(limit: number): ChatMessage[] {
    return this.sql
      .exec<{ role: "user" | "assistant"; content: string; created_at: number }>(
        "SELECT role, content, created_at FROM (SELECT * FROM messages ORDER BY id DESC LIMIT ?) ORDER BY id",
        limit,
      )
      .toArray()
      .map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at }));
  }

  private insertMessage(role: ChatMessage["role"], content: string): number {
    return this.sql
      .exec<{ id: number }>(
        "INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?) RETURNING id",
        role,
        content,
        Date.now(),
      )
      .one().id;
  }
}
