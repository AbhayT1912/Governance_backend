import { appendAudit } from "./auditLogger";
import { evaluate } from "./policyEngine";
import { GovernanceDecision, GovernanceEvent } from "./types";

export class PolicyViolationError extends Error {
  constructor(
    message: string,
    public readonly policyIds: string[],
  ) {
    super(message);
    this.name = "PolicyViolationError";
  }
}

export async function enforce(event: GovernanceEvent): Promise<GovernanceDecision> {
  const decision = await evaluate(event);
  await appendAudit(event, decision);

  if (decision.effect === "DENY") {
    throw new PolicyViolationError(
      decision.reason || "Blocked by governance policy.",
      decision.policyIds,
    );
  }
  return decision;
}
