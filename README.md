# cf_ai_oncall_verifier

[![CI](https://github.com/jaydaftari/cf_ai_oncall_verifier/actions/workflows/ci.yml/badge.svg)](https://github.com/jaydaftari/cf_ai_oncall_verifier/actions/workflows/ci.yml)

**On-Call Verifier** is an AI on-call copilot, built entirely on Cloudflare, that won't let you close an incident until recovery is verified.

Most incident tools treat "the graphs look better" as the end of the incident. In practice, many incidents regress after a hasty rollback, a cache that refills, or a retry storm that returns once traffic picks up. On-Call Verifier pairs with the on-call engineer through triage. Once the incident is mitigated, a long-running **Cloudflare Workflow** keeps checking back:

- It asks whether error rate, latency and saturation are still at baseline.
- At each check-in it drafts a stakeholder status update.
- It closes the incident only when the engineer confirms recovery.
- It reopens the incident if the engineer reports a regression.
- If nobody answers, it refuses to mark the incident resolved.

When the incident is over, a second Workflow drafts a blameless postmortem that records how recovery was verified.

Built for the Cloudflare AI application assignment.

| Requirement | Implementation |
| --- | --- |
| **LLM** | Llama 3.3 70B (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) on **Workers AI**: streaming triage chat, JSON-schema record extraction, stakeholder updates, postmortem writing |
| **Workflow / coordination** | Two **Cloudflare Workflows**. `RecoveryWatchWorkflow` uses durable `step.sleep` + `step.waitForEvent` check-ins that run for up to an hour or more. `PostmortemWorkflow` is a 5-step pipeline with retries and checkpointing. A **Worker** routes requests at the edge |
| **User input (chat)** | Chat UI served as static assets by the Worker, with token streaming over Server-Sent Events |
| **Memory / state** | One SQLite-backed **Durable Object** per incident (`IncidentRoom`) holds chat history, the incident record, the timeline, stakeholder updates and the state of both Workflows. It also owns the incident's status state machine |

## How it works

### 1. Triage chat with a live incident record

Describe symptoms, paste an alert or a log line. The copilot answers as a senior SRE: mitigate first, then gather evidence, then find root cause. It suggests concrete diagnostics (`kubectl`, PromQL, `pg_stat_activity`, Kafka consumer-group commands) and ranks its hypotheses.

Alongside every reply, a second Llama 3.3 call with a strict JSON schema pulls out the title, severity (SEV1–4), status, affected service and new timeline events. That output is validated and de-duplicated before it touches state. The updated record arrives as the last event of the same stream. Setting severity or status by hand locks that field against the model.

### 2. Recovery watch (the main feature)

The status can become **Mitigated** in two ways: the model reads "we rolled back, errors are dropping" in the chat, or the engineer picks it from the dropdown. Either way, the Durable Object starts a `RecoveryWatchWorkflow`:

```
sleep(interval)                                   RECOVERY_CHECK_INTERVAL: 2 minutes for the demo, ~15 for real on-call
repeat up to 3 times:
  draft a stakeholder update (Llama 3.3, retried; falls back to a template)
  post a check-in to the chat: "still at baseline?"
  waitForEvent("recovery-verdict", timeout = interval)
    "recovered": status becomes resolved, recovery verified
    "regressed": status becomes investigating, incident reopened
no answer after the last check: watch expires and the incident stays mitigated
```

The engineer can answer with the panel buttons, or in plain words in the chat ("dashboards are flat, closing it out" / "errors are spiking again"). Every path changes status through one function in the Durable Object, and that function ends the watch with the right verdict.

Why a Workflow: the watch can run for an hour or more and costs nothing between check-ins. Durable sleeps and event waits survive deploys and restarts, which a `setTimeout` or an alarm-juggling Worker can't guarantee.

Edge cases handled (and exercised locally, see [Testing](#testing)):
- **A verdict arrives while the Workflow is sleeping, not waiting.** The Workflow checks `watchOutcome()` before every check-in and exits instead of posting.
- **Re-mitigation after a regression starts a new watch.** Every Workflow callback carries its instance ID, so the superseded watch can't write state.
- **Clearing an incident** terminates its active watch.
- **The stakeholder-update model call fails.** A fixed template is posted instead, so the watch keeps going.

### 3. Postmortem Workflow

`load incident → reconstruct timeline → analyze impact & root cause → draft action items → save`

Each LLM step retries on its own (3 attempts, exponential backoff). Completed steps are checkpointed, so a failure on step 3 does not re-run steps 1–2. The draft includes a **Recovery verification** section from the watch's outcome (verified, regressed, or never verified). You can copy it or download it as Markdown.

## Architecture

```
Browser (public/: index.html, app.js, styles.css)
   │  REST + SSE chat stream; polls while a Workflow is active
   ▼
Worker (src/index.ts)  ── static assets served before the Worker runs
   │
   ├──► IncidentRoom Durable Object (src/incident-room.ts)        one per incident
   │       SQLite: messages · timeline · updates · meta
   │       status state machine:  * → mitigated   starts the RecoveryWatch
   │                              mitigated → *   ends it with a verdict (sendEvent)
   │       ├─ Workers AI: streaming chat reply        ─┐ in parallel
   │       └─ Workers AI: JSON-schema extraction      ─┘
   │
   ├──► RecoveryWatchWorkflow (src/recovery-watch-workflow.ts)
   │       sleep → [stakeholder update (LLM) → check-in → waitForEvent] × 3 → expire
   │
   └──► PostmortemWorkflow (src/postmortem-workflow.ts)
           5 durable steps; reads from and writes to the Durable Object over RPC
```

Design notes:

- **A Durable Object per incident** gives one place to coordinate every request about that incident. Chat turns, extractor writes, check-ins and verdicts are serialized, with no external database and no races. The Workflows decide *when* things happen; the Durable Object decides *what the incident's state is*.
- **LLM output is untrusted input.** Extraction results go through `sanitizeExtraction` (enum allow-lists, length caps, a 5-event cap, de-duplication) before they're written.

## Production hardening

The public deployment is open to anyone, so it is built to survive that:

| Concern | What's in place |
| --- | --- |
| **Abuse and AI cost** | Per-IP rate limits using the Workers Rate Limiting binding: 12 requests/min on endpoints that call the model (`chat`, `postmortem`) and 60/min on other writes. Over the limit returns `429` with `Retry-After`. Request bodies are capped at 32 KB and chat messages at 8,000 characters |
| **Model failures** | Chat returns a clean `502` and rolls back the unanswered user turn so the history stays well-formed. Postmortem steps retry with exponential backoff. If the stakeholder update fails, the recovery watch falls back to a template instead of stopping. Deterministic failures use `NonRetryableError` |
| **Unexpected errors** | A top-level handler logs the error with its route and returns a generic `500`, so internals never leak to the client |
| **Untrusted content in the browser** | Model output is rendered as Markdown through DOMPurify. A strict Content-Security-Policy (`script-src 'self'`, `frame-ancestors 'none'`) plus `nosniff`, `X-Frame-Options` and `Referrer-Policy` headers are set in [`public/_headers`](public/_headers). Front-end libraries are self-hosted and version-pinned, so no third-party scripts load at runtime |
| **State integrity** | One Durable Object per incident serializes all writes. Workflow callbacks carry their instance ID so a superseded watch can't write state. Incident IDs are random UUIDs |
| **Operability** | `GET /api/health`. Workers Observability is enabled (logs and traces in the Cloudflare dashboard). Each Workflow step is named, so a stuck or failed instance shows exactly where it stopped |
| **CI** | GitHub Actions runs the type-check, unit tests and a `wrangler deploy --dry-run` bundle check on every push and PR |

## API

| Method & path | Description |
| --- | --- |
| `POST /api/incidents` | Create an incident ID |
| `GET /api/incidents/:id` | Full snapshot: record, timeline, messages, watch, stakeholder updates, postmortem job |
| `PATCH /api/incidents/:id` | `{severity?, status?}`: manual override (locks the field; `status: "mitigated"` starts the watch) |
| `POST /api/incidents/:id/verdict` | `{verdict: "recovered" \| "regressed"}`: answer a recovery check-in |
| `DELETE /api/incidents/:id` | Clear the incident (and terminate its watch) |
| `POST /api/incidents/:id/chat` | `{message}` → SSE events: `delta`, then `state`, then `done` (or `error`) |
| `POST /api/incidents/:id/postmortem` | Start the postmortem Workflow (`409` if one is running) |
| `GET /api/incidents/:id/postmortem` | Job stage, Workflow status and Markdown once complete |
| `GET /api/health` | Liveness check |

## Running it

**Prerequisites:** Node.js 22+ (Wrangler 4 requires it) and a Cloudflare account (the free plan works; Workers AI calls use your account's quota).

```bash
git clone https://github.com/jaydaftari/cf_ai_oncall_verifier.git
cd cf_ai_oncall_verifier
npm install
npx wrangler login
```

### Local development

```bash
npm run dev
```

Open http://localhost:8787. The Durable Object, both Workflows and the static assets run locally in `workerd`. The Workers AI binding always runs remotely, which is why `wrangler login` is required even for local dev.

To watch the recovery loop faster than the configured 2 minutes per check-in, shorten the interval:

```bash
npx wrangler dev --var RECOVERY_CHECK_INTERVAL:"30 seconds"
```

### Deploy

```bash
npm run deploy
```

Wrangler creates the Worker, the Durable Object namespace (SQLite migration `v1`) and both Workflows, then prints your `*.workers.dev` URL.

## Try it

1. Click a starter prompt, for example *"checkout-api p99 latency went from 180ms to 4.2s at 14:05 UTC, right after deploy v2.31…"*
2. Follow the copilot's suggestions, then report the fix: *"rolled back v2.31 at 14:20, p99 is back to 200ms"*. The status flips to **Mitigated** and the recovery watch starts.
3. At the check-in, click **Still healthy: resolve** (or type *"errors are spiking again"* to watch it reopen).
4. Click **Generate postmortem**.

## Testing

```bash
npm test           # vitest: SSE parsing, extraction sanitizing, transcript budget, durations, postmortem assembly
npm run typecheck  # tsc against types generated by `wrangler types`
```

The Durable Object and both Workflows were also exercised end to end under `wrangler dev`. A harness replaced Workers AI with a fake model and set a 5-second check interval. It covered these scenarios:
- Mitigation detected from the chat, then confirmed at check-in #1: the incident resolves and no further check-ins are posted.
- No answer: check-ins #1, #2 and #3 are posted, then the watch expires and the incident stays mitigated.
- A regression reported during the first sleep: the watch exits without posting.
- Re-mitigation after a regression: only the new watch posts.
- The incident cleared mid-watch.
- A forced model failure inside the postmortem Workflow: the step retries and the run resumes.

## Project layout

```
src/
  index.ts                    Worker: API routing
  incident-room.ts            Durable Object: state, status state machine, streaming chat, extraction
  recovery-watch-workflow.ts  Workflow: post-mitigation check-ins and stakeholder updates
  postmortem-workflow.ts      Workflow: durable postmortem pipeline
  prompts.ts                  Every prompt sent to the model
  lib.ts                      Pure helpers (SSE parser, sanitizer, transcript, durations, assembly)
  types.ts
public/                       Chat UI (no build step); _headers sets the CSP and security headers
public/vendor/                Self-hosted, pinned marked + DOMPurify
test/lib.test.ts              Unit tests
.github/workflows/ci.yml      CI: type-check, tests, bundle check
wrangler.jsonc                Bindings: AI, Durable Object, two Workflows, rate limiters, assets, check interval
PROMPTS.md                    AI prompts used to build this project
```

## Limitations and next steps

- No authentication. Incident IDs are unguessable UUIDs, but anyone holding one can open that incident. For a real team, put Cloudflare Access in front, or add per-user auth and scope incidents to a team.
- The engineer has to confirm recovery manually. The natural next step is for each check-in to query real signals (a Prometheus or Analytics Engine endpoint) and pre-fill the verdict, leaving the human to approve it.
- Stakeholder updates are drafted but not sent. A Slack or status-page webhook would be one more Workflow step.
- The sidebar's incident list is kept per browser in `localStorage`. A small index Durable Object or D1 table would let a team share it.
