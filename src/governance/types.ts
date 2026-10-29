export type GovernanceEventType =
  | "delegate"
  | "message"
  | "tool_call"
  | "output";

export type PolicyEffect = "ALLOW" | "DENY" | "REDACT" | "ESCALATE";

export interface ActorIdentity {
  id: string;
  type: "user" | "agent" | "system";
}

export type FindingEvidence = {
  kind: "file" | "function" | "edge" | "security_finding" | "finding";
  ref: string;
};

export interface GovernanceEvent {
  type: GovernanceEventType;
  jobId: string;
  repoId: string;
  agentId: string;
  role: string;
  action: string;
  payload?: unknown;
  context: {
    depth: number;
    repoId: string;
    tokensUsed: number;
    llmCalls?: number;
    durationMs?: number;
    delegationChain?: string[];
  };
}

export interface GovernanceDecision {
  effect: PolicyEffect;
  policyIds: string[];
  reason?: string;
  redactedPayload?: unknown;
  redactions?: string[];
}

export interface AgentTaskContext {
  jobId: string;
  repoId: string;
  taskId: string;
  agentId: string;
  role: string;
  depth: number;
  question?: string;
  sharedMessages?: Array<{ from: string; topic: string; body: string }>;
  signal?: AbortSignal;
}

export interface FindingInput {
  category: string;
  target: string;
  claim: string;
  riskScore: number;
  confidence: number;
  evidence: FindingEvidence[];
  severity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
}

export interface PolicyCondition {
  field: string;
  op: "eq" | "gt" | "in" | "matches";
  value: unknown;
}

export interface PolicyDefinition {
  policyId: string;
  version: number;
  type: string;
  description: string;
  when: { events: GovernanceEventType[] };
  conditions?: PolicyCondition[];
  effect: PolicyEffect;
  message: string;
  enabled: boolean;
}
