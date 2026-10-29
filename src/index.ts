export { IncidentRoom } from "./incident-room";
export { PostmortemWorkflow } from "./postmortem-workflow";
export { RecoveryWatchWorkflow } from "./recovery-watch-workflow";

const INCIDENT_ROUTE = /^\/api\/incidents\/([A-Za-z0-9-]{8,64})(\/[a-z]+)?$/;

const json = (data: unknown, status = 200) => Response.json(data, { status });

/**
 * Edge router. Static UI files in ./public are served by Workers Assets before
 * this code runs; everything under /api lands here and is forwarded to the
 * incident's Durable Object or to the postmortem Workflow.
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { method } = request;

    if (url.pathname === "/api/incidents" && method === "POST") {
      return json({ id: crypto.randomUUID() }, 201);
    }

    const match = url.pathname.match(INCIDENT_ROUTE);
    if (!match) return json({ error: "Not found" }, 404);

    const [, id, action = ""] = match as [string, string, string?];
    const room = env.INCIDENT.get(env.INCIDENT.idFromName(id));

    switch (`${method} ${action}`) {
      case "GET ":
        return json({ id, ...(await room.getSnapshot()) });

      case "DELETE ":
        await room.reset();
        return json({ ok: true });

      case "PATCH ": {
        const patch = (await request.json().catch(() => ({}))) as { severity?: string; status?: string };
        return json({ id, ...(await room.updateMeta(id, patch)) });
      }

      case "POST /verdict": {
        const { verdict } = (await request.json().catch(() => ({}))) as { verdict?: string };
        if (verdict !== "recovered" && verdict !== "regressed") {
          return json({ error: 'verdict must be "recovered" or "regressed"' }, 400);
        }
        return json({ id, ...(await room.recordVerdict(id, verdict)) });
      }

      case "POST /chat":
        // Streams Server-Sent Events straight from the Durable Object.
        return room.fetch(request);

      case "POST /postmortem": {
        const snapshot = await room.getSnapshot();
        if (snapshot.messages.length === 0) {
          return json({ error: "Describe the incident in the chat before generating a postmortem" }, 400);
        }
        const current = snapshot.postmortem;
        if (current.workflowId && current.stage !== "Complete" && current.stage !== "Failed") {
          return json({ error: "A postmortem is already being generated" }, 409);
        }
        const instance = await env.POSTMORTEM.create({ params: { incidentId: id } });
        await room.startPostmortem(instance.id);
        return json({ workflowId: instance.id }, 202);
      }

      case "GET /postmortem": {
        const job = (await room.getSnapshot()).postmortem;
        if (!job.workflowId) return json({ ...job, workflowStatus: null });
        const instance = await env.POSTMORTEM.get(job.workflowId);
        const { status } = await instance.status();
        return json({ ...job, workflowStatus: status });
      }

      default:
        return json({ error: "Not found" }, 404);
    }
  },
} satisfies ExportedHandler<Env>;
