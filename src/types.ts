export const SEVERITIES = ["SEV1", "SEV2", "SEV3", "SEV4", "unknown"] as const;
export const STATUSES = ["investigating", "identified", "mitigated", "resolved"] as const;

export type Severity = (typeof SEVERITIES)[number];
export type Status = (typeof STATUSES)[number];

export interface IncidentMeta {
  title: string;
  severity: Severity;
  status: Status;
  service: string;
}

export interface TimelineEvent {
  id: number;
  time: string;
  event: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export interface PostmortemJob {
  workflowId: string | null;
  stage: string | null;
  markdown: string | null;
  error: string | null;
}

export interface IncidentSnapshot {
  meta: IncidentMeta;
  timeline: TimelineEvent[];
  messages: ChatMessage[];
  postmortem: PostmortemJob;
}

/** What the extractor model is allowed to change after each user message. */
export interface Extraction {
  title?: string;
  severity?: Severity;
  status?: Status;
  service?: string;
  events: { time: string; event: string }[];
}
