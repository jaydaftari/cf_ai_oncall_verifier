import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { assemblePostmortem, buildTranscript, resultText } from "./lib";
import {
  MODEL,
  POSTMORTEM_SYSTEM_PROMPT,
  actionItemsPrompt,
  analysisPrompt,
  describeIncident,
  timelinePrompt,
} from "./prompts";

export interface PostmortemParams {
  incidentId: string;
}

// LLM steps are the flaky part (capacity errors, timeouts), so each one retries
// independently. Completed steps are checkpointed and never re-run.
const LLM_STEP: WorkflowStepConfig = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "3 minutes",
};

/**
 * Turns an incident's chat history into a blameless postmortem draft:
 * load the record, then timeline, then analysis, then action items, then save.
 * Each stage is a durable step, so a failure mid-way resumes from the last
 * completed step instead of starting over (and re-paying for) the whole chain.
 */
export class PostmortemWorkflow extends WorkflowEntrypoint<Env, PostmortemParams> {
  async run(event: WorkflowEvent<PostmortemParams>, step: WorkflowStep) {
    const room = this.env.INCIDENT.get(this.env.INCIDENT.idFromName(event.payload.incidentId));

    try {
      const loaded = await step.do("load incident", async () => {
        await room.setPostmortemStage("Loading incident record");
        const snap = await room.getSnapshot();
        if (snap.messages.length === 0) throw new NonRetryableError("Incident has no conversation yet");
        return {
          meta: snap.meta,
          watch: snap.watch,
          incident: describeIncident(snap.meta, snap.timeline),
          transcript: buildTranscript(snap.messages),
        };
      });

      const timeline = await step.do("reconstruct timeline", LLM_STEP, async () => {
        await room.setPostmortemStage("Reconstructing timeline");
        return this.complete(timelinePrompt(loaded.incident, loaded.transcript));
      });

      const analysis = await step.do("analyze impact and root cause", LLM_STEP, async () => {
        await room.setPostmortemStage("Analyzing impact and root cause");
        return this.complete(analysisPrompt(loaded.incident, loaded.transcript, timeline));
      });

      const actionItems = await step.do("draft action items", LLM_STEP, async () => {
        await room.setPostmortemStage("Drafting action items");
        return this.complete(actionItemsPrompt(loaded.incident, analysis));
      });

      const markdown = await step.do("save postmortem", async () => {
        const doc = assemblePostmortem({
          meta: loaded.meta,
          timeline,
          analysis,
          actionItems,
          watch: loaded.watch,
          generatedAt: new Date(),
        });
        await room.savePostmortem(doc);
        return doc;
      });

      return { characters: markdown.length };
    } catch (err) {
      // Retries are exhausted at this point; surface the failure to the UI.
      const message = err instanceof Error ? err.message : String(err);
      await step.do("record failure", async () => room.failPostmortem(message));
      throw err;
    }
  }

  private async complete(prompt: string): Promise<string> {
    const result = await this.env.AI.run(MODEL, {
      messages: [
        { role: "system", content: POSTMORTEM_SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      max_tokens: 1500,
      temperature: 0.2,
    });
    const text = resultText(result);
    if (!text) throw new Error("Model returned an empty response");
    return text;
  }
}
