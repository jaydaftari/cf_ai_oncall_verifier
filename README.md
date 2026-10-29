# cf_ai_incident_copilot

An AI incident-response copilot that runs entirely on Cloudflare. You chat with it during a production incident. It helps you triage and keeps a structured incident record and timeline as you go. When the incident is over, it runs a durable multi-step Workflow that writes a blameless postmortem draft.

Built for the Cloudflare AI application assignment.

| Requirement | Implementation |
| --- | --- |
| **LLM** | Llama 3.3 70B (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) on **Workers AI**: streaming chat, JSON-schema extraction, postmortem writing |
| **Workflow / coordination** | **Cloudflare Workflows** (`PostmortemWorkflow`): a 5-step durable pipeline with per-step retries and checkpointing. A **Worker** routes requests at the edge |
| **User input (chat)** | Chat UI served as static assets by the Worker, with token streaming over Server-Sent Events |
| **Memory / state** | One SQLite-backed **Durable Object** per incident (`IncidentRoom`) holds chat history, the incident record, the timeline and postmortem progress |

## What it does

1. **Triage chat.** Describe symptoms, paste an alert or a log line. The copilot answers as a senior SRE: mitigate first, then gather evidence, then find root cause. It suggests concrete diagnostics (`kubectl`, PromQL, `pg_stat_activity`, Kafka consumer-group commands) and ranks its hypotheses.
2. **A live incident record.** Alongside every reply, a second Llama 3.3 call with a strict JSON schema pulls out the title, severity (SEV1–4), status, affected service and new timeline events. That output is validated and de-duplicated before it is written to the Durable Object. The updated record arrives as the last event of the same stream, so the side panel refreshes as soon as the reply finishes.
3. **Human override.** If you set severity or status by hand, that field is locked and the model won't overwrite it.
4. **Postmortem Workflow.** "Generate postmortem" starts a Workflow instance that runs these steps:
   `load incident → reconstruct timeline → analyze impact & root cause → draft action items → save`
   Each LLM step retries on its own (3 attempts, exponential backoff). Completed steps are checkpointed, so a model failure on step 3 does not re-run steps 1–2. The UI polls progress and renders the finished Markdown, which you can copy or download.

## Architecture

```
Browser (public/: index.html, app.js, styles.css)
   │  POST /api/incidents/:id/chat  (SSE stream)
   ▼
Worker (src/index.ts)  ── static assets served before the Worker runs
   │
   ├──► IncidentRoom Durable Object (src/incident-room.ts)    one instance per incident
   │       SQLite: messages · timeline · meta (record, locks, postmortem job)
   │       ├─ Workers AI: streaming chat reply     ─┐ run in parallel
   │       └─ Workers AI: JSON-schema extraction   ─┘ record update sent as final SSE event
   │
   └──► PostmortemWorkflow (src/postmortem-workflow.ts)
           step.do × 5, each LLM step with retries
           reads the transcript from and writes the result to the same Durable Object over RPC
```

Why this shape:

- **A Durable Object per incident** gives one place to coordinate every request about that incident. Chat turns, extractor writes and Workflow writes are serialized, with no external database and no write races.
- **A Workflow rather than one long request**: a postmortem is several model calls that can each fail. Workflows make it resumable and observable. The Durable Object holds the stage name so the UI can show progress.
- **LLM output is untrusted input.** Extraction results go through `sanitizeExtraction` (enum allow-lists, length caps, a 5-event cap, de-duplication) before they touch state.

## API

| Method & path | Description |
| --- | --- |
| `POST /api/incidents` | Create an incident ID |
| `GET /api/incidents/:id` | Full snapshot: record, timeline, messages, postmortem job |
| `PATCH /api/incidents/:id` | `{severity?, status?}`: manual override (locks the field) |
| `DELETE /api/incidents/:id` | Clear the incident |
| `POST /api/incidents/:id/chat` | `{message}` → SSE events: `delta`, then `state`, then `done` (or `error`) |
| `POST /api/incidents/:id/postmortem` | Start the postmortem Workflow (`409` if one is already running) |
| `GET /api/incidents/:id/postmortem` | Job stage, Workflow status and Markdown once complete |

## Running it

**Prerequisites:** Node.js 22+ (Wrangler 4 requires it) and a Cloudflare account (the free plan works; Workers AI calls use your account's quota).

```bash
git clone https://github.com/jaydaftari/cf_ai_incident_copilot.git
cd cf_ai_incident_copilot
npm install
npx wrangler login
```

### Local development

```bash
npm run dev
```

Open http://localhost:8787. The Durable Object, the Workflow and the static assets run locally in `workerd`. The Workers AI binding always runs remotely, which is why `wrangler login` is required even for local dev.

### Deploy

```bash
npm run deploy
```

Wrangler creates the Worker, the Durable Object namespace (SQLite migration `v1`) and the Workflow, then prints your `*.workers.dev` URL.

### Tests and type-check

```bash
npm test           # vitest: SSE parsing, extraction sanitizing, transcript budget, postmortem assembly
npm run typecheck  # tsc against types generated by `wrangler types`
```

## Try it

Click one of the starter prompts, or paste something like:

> PagerDuty: checkout-api p99 latency went from 180ms to 4.2s at 14:05 UTC, right after deploy v2.31 went out. Error rate is 6%.

Then follow up with what you find ("rolled back at 14:20, latency recovering", "root cause was a missing index in the new query") and watch the record and timeline fill in. Then click **Generate postmortem**.

## Project layout

```
src/
  index.ts                Worker: API routing
  incident-room.ts        Durable Object: state, streaming chat, extraction
  postmortem-workflow.ts  Workflow: durable postmortem pipeline
  prompts.ts              Every system/user prompt sent to the model
  lib.ts                  Pure helpers (SSE parser, sanitizer, transcript, assembly)
  types.ts
public/                   Chat UI (no build step)
test/lib.test.ts          Unit tests
wrangler.jsonc            Bindings: AI, Durable Object, Workflow, assets
PROMPTS.md                AI prompts used to build this project
```

## Limitations and next steps

- No authentication: anyone with an incident ID can open it. In production, put Cloudflare Access in front, or add per-user auth and scope incidents to a team.
- The sidebar's incident list is kept per browser in `localStorage`. A small index Durable Object or D1 table would let a team share it.
- Possible next steps: voice input via Realtime, Slack/PagerDuty webhooks feeding the timeline, and Vectorize retrieval over past postmortems ("have we seen this before?").
