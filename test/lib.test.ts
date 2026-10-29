import { describe, expect, it } from "vitest";
import {
  assemblePostmortem,
  buildTranscript,
  createSseParser,
  deltaFromEvent,
  resultText,
  sanitizeExtraction,
} from "../src/lib";

describe("createSseParser", () => {
  it("reassembles events split across network chunks", () => {
    const events: string[] = [];
    const parser = createSseParser((d) => events.push(d));
    parser.push('data: {"response":"Hel');
    parser.push('lo"}\n\ndata: {"response":" world"}\r\n');
    parser.push("data: [DONE]");
    parser.flush();
    expect(events).toEqual(['{"response":"Hello"}', '{"response":" world"}', "[DONE]"]);
  });
});

describe("deltaFromEvent", () => {
  it("reads native and OpenAI-style chunks and ignores noise", () => {
    expect(deltaFromEvent('{"response":"hi"}')).toBe("hi");
    expect(deltaFromEvent('{"choices":[{"delta":{"content":"yo"}}]}')).toBe("yo");
    expect(deltaFromEvent("[DONE]")).toBe("");
    expect(deltaFromEvent("not json")).toBe("");
    expect(deltaFromEvent('{"usage":{"total_tokens":5}}')).toBe("");
  });
});

describe("resultText", () => {
  it("handles string, object and chat-completion results", () => {
    expect(resultText({ response: "  ok " })).toBe("ok");
    expect(resultText({ response: { a: 1 } })).toBe('{"a":1}');
    expect(resultText({ choices: [{ message: { content: "done" } }] })).toBe("done");
  });
});

describe("sanitizeExtraction", () => {
  const existing = [{ id: 1, time: "14:05", event: "Deploy v2.3 rolled out" }];

  it("keeps valid fields and drops invalid enums", () => {
    const out = sanitizeExtraction(
      { title: "Checkout latency", severity: "SEV9", status: "mitigated", service: "checkout-api", events: [] },
      existing,
    );
    expect(out).toEqual({ title: "Checkout latency", status: "mitigated", service: "checkout-api", events: [] });
  });

  it("parses JSON strings and dedupes events against the timeline", () => {
    const out = sanitizeExtraction(
      JSON.stringify({
        severity: "SEV2",
        events: [
          { time: "14:05", event: "deploy v2.3 rolled out!" },
          { time: "", event: "p99 latency hit 4s" },
          { time: "14:20", event: "p99 latency hit 4s" },
          { event: "" },
        ],
      }),
      existing,
    );
    expect(out.severity).toBe("SEV2");
    expect(out.events).toEqual([{ time: "unspecified", event: "p99 latency hit 4s" }]);
  });

  it("caps events and string lengths", () => {
    const events = Array.from({ length: 9 }, (_, i) => ({ time: "t", event: `event ${i} ${"x".repeat(400)}` }));
    const out = sanitizeExtraction({ events }, []);
    expect(out.events).toHaveLength(5);
    expect(out.events[0]!.event.length).toBe(280);
  });

  it("returns an empty update for garbage", () => {
    expect(sanitizeExtraction("{oops", [])).toEqual({ events: [] });
    expect(sanitizeExtraction(null, [])).toEqual({ events: [] });
  });
});

describe("buildTranscript", () => {
  const messages = [
    { role: "user" as const, content: "first", createdAt: 1 },
    { role: "assistant" as const, content: "second", createdAt: 2 },
    { role: "user" as const, content: "third", createdAt: 3 },
  ];

  it("labels speakers in order", () => {
    expect(buildTranscript(messages)).toBe("Engineer: first\n\nCopilot: second\n\nEngineer: third");
  });

  it("keeps the most recent messages when over budget", () => {
    expect(buildTranscript(messages, 35)).toBe("Copilot: second\n\nEngineer: third");
  });
});

describe("assemblePostmortem", () => {
  it("puts sections in a stable order", () => {
    const doc = assemblePostmortem({
      meta: { title: "DB failover", severity: "SEV2", status: "resolved", service: "postgres" },
      timeline: "- **10:00**: alert",
      analysis: "## Summary\nok",
      actionItems: "| Action | Type | Priority |",
      generatedAt: new Date("2026-01-01T00:00:00Z"),
    });
    expect(doc.startsWith("# Postmortem: DB failover")).toBe(true);
    expect(doc.indexOf("## Summary")).toBeLessThan(doc.indexOf("## Timeline"));
    expect(doc.indexOf("## Timeline")).toBeLessThan(doc.indexOf("## Action items"));
  });
});
