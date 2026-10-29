import { DurableObject } from "cloudflare:workers";
import { createSseParser, deltaFromEvent, resultContent, sanitizeExtraction } from "./lib";
import {
  EXTRACTION_SCHEMA,
  EXTRACTOR_SYSTEM_PROMPT,
  MODEL,
  chatSystemPrompt,
  extractorUserPrompt,
} from "./prompts";
import { SEVERITIES, STATUSES } from "./types";
import type {
  ChatMessage,
  IncidentMeta,
  IncidentSnapshot,
  PostmortemJob,
  Severity,
  Status,
  TimelineEvent,
} from "./types";

const CHAT_HISTORY_TURNS = 20;
const MAX_MESSAGE_CHARS = 8_000;

/**
 * One Durable Object per incident. It is the single source of truth for that
 * incident: chat history, the structured record (title, severity, status,
 * service), the timeline, and postmortem progress, all in its SQLite storage.
 * Because every request for an incident is routed to the same instance, writes
 * are serialized and the record never races with itself.
 */
export class IncidentRoom extends DurableObject<Env> {
  private sql: SqlStorage;

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
  async updateMeta(patch: { severity?: string; status?: string }): Promise<IncidentSnapshot> {
    if (SEVERITIES.includes(patch.severity as Severity)) {
      this.setMeta({ severity: patch.severity!, severity_locked: "1" });
    }
    if (STATUSES.includes(patch.status as Status)) {
      this.setMeta({ status: patch.status!, status_locked: "1" });
    }
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

  async reset(): Promise<void> {
    this.sql.exec("DELETE FROM messages; DELETE FROM timeline; DELETE FROM meta;");
  }

  // ------------------------------------------------------- streaming chat

  /** POST {message} -> SSE stream of {type:"delta"|"state"|"done"|"error"} events. */
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

    const body = (await request.json().catch(() => null)) as { message?: unknown } | null;
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    if (!message) return Response.json({ error: "message is required" }, { status: 400 });
    if (message.length > MAX_MESSAGE_CHARS) {
      return Response.json({ error: `message exceeds ${MAX_MESSAGE_CHARS} characters` }, { status: 413 });
    }

    const meta = this.meta();
    const timeline = this.timeline();
    const history = this.messages(CHAT_HISTORY_TURNS);
    this.insertMessage("user", message);

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
    if (update.status && !locked.status_locked) this.setMeta({ status: update.status });
    for (const e of update.events) {
      this.sql.exec("INSERT INTO timeline (time, event) VALUES (?, ?)", e.time, e.event);
    }
  }

  private snapshot(): IncidentSnapshot {
    return {
      meta: this.meta(),
      timeline: this.timeline(),
      messages: this.messages(200),
      postmortem: this.postmortem(),
    };
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

  private messages(limit: number): ChatMessage[] {
    return this.sql
      .exec<{ role: "user" | "assistant"; content: string; created_at: number }>(
        "SELECT role, content, created_at FROM (SELECT * FROM messages ORDER BY id DESC LIMIT ?) ORDER BY id",
        limit,
      )
      .toArray()
      .map((r) => ({ role: r.role, content: r.content, createdAt: r.created_at }));
  }

  private insertMessage(role: ChatMessage["role"], content: string) {
    this.sql.exec(
      "INSERT INTO messages (role, content, created_at) VALUES (?, ?, ?)",
      role,
      content,
      Date.now(),
    );
  }
}
