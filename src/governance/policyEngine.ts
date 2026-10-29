import { AgentModel, PolicyModel } from "../models/governance.model";
import {
  GovernanceDecision,
  GovernanceEvent,
  PolicyCondition,
  PolicyDefinition,
} from "./types";
import { redactSecrets, stripInstructionLikeText } from "./redaction";

function getField(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, source);
}

function matchesCondition(event: GovernanceEvent, condition: PolicyCondition) {
  const actual = getField(event, condition.field);
  switch (condition.op) {
    case "eq":
      return actual === condition.value;
    case "gt":
      return typeof actual === "number" && typeof condition.value === "number"
        ? actual > condition.value
        : false;
    case "in":
      return Array.isArray(condition.value) && condition.value.includes(actual);
    case "matches":
      return typeof actual === "string" && typeof condition.value === "string"
        ? new RegExp(condition.value).test(actual)
        : false;
  }
}

function conditionMatches(event: GovernanceEvent, conditions: PolicyCondition[]) {
  return (
    conditions.length === 0 ||
    conditions.every((condition) => matchesCondition(event, condition))
  );
}

function containsEvidence(payload: unknown) {
  if (!payload || typeof payload !== "object") return false;
  const evidence = (payload as Record<string, unknown>).evidence;
  return Array.isArray(evidence) && evidence.length > 0;
}

export async function evaluate(event: GovernanceEvent): Promise<GovernanceDecision> {
  const [policyRows, agents] = await Promise.all([
    PolicyModel.aggregate([
      { $sort: { policyId: 1, version: -1 } },
      { $group: { _id: "$policyId", policy: { $first: "$$ROOT" } } },
      { $replaceRoot: { newRoot: "$policy" } },
    ]),
    AgentModel.find({ status: "ACTIVE" }).lean(),
  ]);
  const policies = (policyRows as PolicyDefinition[]).filter((item) => item.enabled);
  return evaluateGovernanceEvent(event, policies, agents);
}

export function evaluateGovernanceEvent(
  event: GovernanceEvent,
  policies: PolicyDefinition[],
  agents: Array<{ agentId: string; role?: string; allowedTools: string[]; capabilities: string[] }>,
): GovernanceDecision {
  const applicable = policies.filter(
    (policy) =>
      policy.when?.events?.includes(event.type) &&
      conditionMatches(event, policy.conditions || []),
  );
  const policyIds: string[] = [];
  const policy = (id: string) => policies.find((item) => item.policyId === id);
  const enabled = (id: string) => policy(id)?.enabled === true;
  const policyEffect = (id: string) => policy(id)?.effect;

  const reject = (policyId: string, reason: string): GovernanceDecision => ({
    effect: "DENY",
    policyIds: Array.from(new Set([...policyIds, policyId])),
    reason,
  });

  if (event.type === "tool_call") {
    const executionAction =
      /(^|[_:])(exec|execute|spawn|shell|run_code)(_|:|$)/i.test(event.action);
    if (executionAction) {
      return reject("POL-EXEC-001", "Repository code execution is not permitted.");
    }

    const agent = agents.find((item) => item.agentId === event.agentId);
    if ((!agent || !agent.allowedTools.includes(event.action)) && policyEffect("POL-TOOL-001") === "DENY") {
      return reject("POL-TOOL-001", policy("POL-TOOL-001")?.message || "Tool is not permitted for this agent.");
    }
    if (enabled("POL-TOOL-001")) policyIds.push("POL-TOOL-001");
  }

  const payloadObject =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : {};
  if (
    event.context.repoId !== event.repoId ||
    (payloadObject.repoId !== undefined && payloadObject.repoId !== event.repoId) ||
    (payloadObject.jobId !== undefined && payloadObject.jobId !== event.jobId)
  ) {
    return reject("POL-SCOPE-001", policy("POL-SCOPE-001")?.message || "Agent action is outside its assigned repository or job scope.");
  }
  if (event.type !== "delegate" && enabled("POL-SCOPE-001")) policyIds.push("POL-SCOPE-001");

  if (event.type === "tool_call" && event.action === "ask_rag" && enabled("POL-BUDGET-001")) {
    policyIds.push("POL-BUDGET-001");
  }

  if (event.type === "delegate") {
    const chain = event.context.delegationChain || [];
    if (policyEffect("POL-DELEG-001") === "DENY" && (event.context.depth > 3 || chain.includes(event.action))) {
      return reject(
        "POL-DELEG-001",
        policy("POL-DELEG-001")?.message || "Delegation depth or cycle policy was violated.",
      );
    }
    const targetAgent = agents.find((item) => item.agentId === event.action);
    const requiredCapability = payloadObject.requiredCapability;
    if (policyEffect("POL-DELEG-001") === "DENY" && (
      !targetAgent ||
      (typeof requiredCapability === "string" &&
        !targetAgent.capabilities.includes(requiredCapability))
    )) {
      return reject(
        "POL-DELEG-001",
        policy("POL-DELEG-001")?.message || "Target agent does not have the required capability.",
      );
    }
    if (enabled("POL-DELEG-001")) policyIds.push("POL-DELEG-001");
    if (policyEffect("POL-DUP-001") === "ALLOW") policyIds.push("POL-DUP-001");
  }

  if (event.type === "output" && policyEffect("POL-EVID-001") === "DENY" && !containsEvidence(event.payload)) {
    return reject(
      "POL-EVID-001",
      policy("POL-EVID-001")?.message || "Finding requires at least one evidence reference.",
    );
  }
  if (event.type === "output" && enabled("POL-EVID-001")) policyIds.push("POL-EVID-001");

  const matchingBudgetRule = applicable.find((item) => item.policyId === "POL-BUDGET-001");
  if (matchingBudgetRule?.effect === "DENY") {
    return reject(matchingBudgetRule.policyId, matchingBudgetRule.message);
  }

  let payload = event.payload;
  let injectionStripped = false;
  if (event.type === "tool_call" || event.type === "message") {
    const visit = (value: unknown): unknown => {
      if (typeof value === "string") {
        const { safeText, strippedLines } = stripInstructionLikeText(value);
        if (strippedLines.length > 0) {
          injectionStripped = true;
          policyIds.push("POL-INJECT-001");
        }
        return safeText;
      }
      if (Array.isArray(value)) return value.map(visit);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, visit(item)]),
        );
      }
      return value;
    };
    payload = visit(payload);
  }

  const redactions: string[] = [];
  if (event.type === "output" || event.type === "message") {
    const result = redactSecrets(payload);
    payload = result.value;
    redactions.push(...result.redactions);
    if (redactions.length > 0 && enabled("POL-DATA-001")) {
      policyIds.push("POL-DATA-001");
      if (policyEffect("POL-DATA-001") === "DENY") {
        return reject("POL-DATA-001", policy("POL-DATA-001")?.message || "Sensitive output is blocked by policy.");
      }
    }
  }

  if (
    event.type === "output" &&
    ["HIGH", "CRITICAL"].includes(String(payloadObject.severity || ""))
  ) {
    if (enabled("POL-REVIEW-001")) {
      policyIds.push("POL-REVIEW-001");
      if (policyEffect("POL-REVIEW-001") === "DENY") {
        return reject("POL-REVIEW-001", policy("POL-REVIEW-001")?.message || "Finding is blocked by review policy.");
      }
    }
  }

  if (injectionStripped && policyEffect("POL-INJECT-001") === "DENY") {
    return reject("POL-INJECT-001", policy("POL-INJECT-001")?.message || "Instruction-like repository content is blocked.");
  }

  const builtInPolicyIds = new Set([
    "POL-TOOL-001", "POL-DELEG-001", "POL-DUP-001", "POL-DATA-001",
    "POL-EVID-001", "POL-REVIEW-001", "POL-BUDGET-001", "POL-SCOPE-001",
    "POL-INJECT-001", "POL-EXEC-001",
  ]);
  for (const policy of applicable.filter((item) => !builtInPolicyIds.has(item.policyId))) {
    if (
      policy.conditions?.length &&
      conditionMatches(event, policy.conditions) &&
      policy.effect === "DENY"
    ) {
      return reject(policy.policyId, policy.message);
    }
  }

  const reviewRequired =
    (policyIds.includes("POL-REVIEW-001") && policyEffect("POL-REVIEW-001") === "ESCALATE") ||
    (redactions.length > 0 && policyEffect("POL-DATA-001") === "ESCALATE") ||
    (injectionStripped && policyEffect("POL-INJECT-001") === "ESCALATE") ||
    applicable.some((item) => !builtInPolicyIds.has(item.policyId) && item.effect === "ESCALATE");
  const customRedaction = applicable.some((item) => !builtInPolicyIds.has(item.policyId) && item.effect === "REDACT");
  const decisionEffect = reviewRequired
    ? "ESCALATE"
    : redactions.length > 0 || injectionStripped || customRedaction
      ? "REDACT"
      : "ALLOW";

  return {
    effect: decisionEffect,
    policyIds: Array.from(new Set(policyIds)),
    reason:
      redactions.length > 0
        ? `Sensitive values redacted: ${redactions.join(", ")}`
        : injectionStripped
          ? "Instruction-like untrusted text was stripped."
        : reviewRequired
          ? "High-risk finding requires Critic review."
          : undefined,
    redactedPayload: payload,
    redactions,
  };
}
