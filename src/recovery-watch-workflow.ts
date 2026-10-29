import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowSleepDuration, WorkflowStep } from "cloudflare:workers";
import { VERDICT_EVENT } from "./incident-room";
import { buildTranscript, durationMs, resultText } from "./lib";
import { MODEL, STATUS_UPDATE_SYSTEM_PROMPT, describeIncident, statusUpdatePrompt } from "./prompts";
import { MAX_RECOVERY_CHECKS } from "./types";
import type { Verdict } from "./types";

export interface RecoveryWatchParams {
  incidentId: string;
}

/**
 * "Mitigated" is not "resolved". This Workflow starts when an incident is
 * mitigated and keeps the on-call engineer honest about verifying recovery:
 *
 *   sleep(interval)
 *   repeat up to MAX_RECOVERY_CHECKS times:
 *     draft a stakeholder update (LLM) and post a check-in to the chat
 *     waitForEvent("recovery-verdict", timeout = interval)
 *       recovered: incident resolved  /  regressed: incident reopened
 *   no answer after the last check: watch expires and the incident stays mitigated
 *
 * A Workflow is the right tool here because the whole thing can run for an
 * hour or more while costing nothing between check-ins: durable sleeps and
 * event waits survive deploys and restarts, which a setTimeout in a Worker or
 * Durable Object would not. The Durable Object applies the verdict to the
 * incident; this Workflow only decides when to ask and when to stop.
 */
export class RecoveryWatchWorkflow extends WorkflowEntrypoint<Env, RecoveryWatchParams> {
  async run(event: WorkflowEvent<RecoveryWatchParams>, step: WorkflowStep) {
    const workflowId = event.instanceId;
    const room = this.env.INCIDENT.get(this.env.INCIDENT.idFromName(event.payload.incidentId));
    const interval = this.env.RECOVERY_CHECK_INTERVAL as WorkflowSleepDuration & string;
    const intervalMinutes = Math.round(durationMs(interval) / 60_000);

    await step.sleep("wait before first check", interval);

    for (let round = 1; round <= MAX_RECOVERY_CHECKS; round++) {
      // The verdict may have arrived while we were sleeping (not yet waiting
      // for the event), or the watch may have been superseded.
      const outcome = await step.do(`check watch before round ${round}`, async () =>
        room.watchOutcome(workflowId),
      );
      if (outcome) return { outcome, checks: round - 1 };

      let update: string;
      try {
        update = await step.do(
          `draft stakeholder update ${round}`,
          { retries: { limit: 2, delay: "5 seconds", backoff: "exponential" }, timeout: "2 minutes" },
          async () => {
            const snap = await room.getSnapshot();
            const result = await this.env.AI.run(MODEL, {
              messages: [
                { role: "system", content: STATUS_UPDATE_SYSTEM_PROMPT },
                {
                  role: "user",
                  content: statusUpdatePrompt(
                    describeIncident(snap.meta, snap.timeline),
                    buildTranscript(snap.messages, 12_000),
                    round * intervalMinutes,
                    interval,
                  ),
                },
              ],
              max_tokens: 300,
              temperature: 0.2,
            });
            const text = resultText(result);
            if (!text) throw new Error("Model returned an empty status update");
            return text;
          },
        );
      } catch {
        // A missing summary must not stop the watch itself.
        update = `**Status:** Mitigated, verifying recovery.\n**Next update:** in ${interval}.`;
      }

      await step.do(`post check-in ${round}`, async () =>
        room.postCheckIn(workflowId, round, update, round * intervalMinutes),
      );

      try {
        const answer = await step.waitForEvent<{ verdict: Verdict }>(`await verdict after check ${round}`, {
          type: VERDICT_EVENT,
          timeout: interval,
        });
        return { outcome: answer.payload.verdict, checks: round };
      } catch {
        // Timed out with no answer: go round again (or expire below).
      }
    }

    await step.do("expire watch", async () => room.watchExpired(workflowId));
    return { outcome: "expired", checks: MAX_RECOVERY_CHECKS };
  }
}
