import { z } from "zod";

export const governanceJobBodySchema = z.object({
  repo_id: z.string().min(1),
  analysis_types: z.array(z.enum(["structure", "dependency", "dead-code", "security", "quality", "qa"])).default([]),
  question: z.string().trim().max(4000).optional(),
}).strict();

export const governancePolicyBodySchema = z.object({
  type: z.string().min(1).max(80),
  description: z.string().min(1).max(1000),
  when: z.object({ events: z.array(z.enum(["delegate", "message", "tool_call", "output"])).min(1) }).strict(),
  conditions: z.array(z.object({
    field: z.string().min(1),
    op: z.enum(["eq", "gt", "in", "matches"]),
    value: z.unknown(),
  }).strict().superRefine((condition, context) => {
    if (condition.op === "matches" && typeof condition.value === "string") {
      try { new RegExp(condition.value); } catch { context.addIssue({ code: "custom", message: "Invalid regular expression condition." }); }
    }
    if (condition.op === "gt" && typeof condition.value !== "number") context.addIssue({ code: "custom", message: "gt conditions require a numeric value." });
    if (condition.op === "in" && !Array.isArray(condition.value)) context.addIssue({ code: "custom", message: "in conditions require an array value." });
  })).default([]),
  effect: z.enum(["ALLOW", "DENY", "REDACT", "ESCALATE"]),
  message: z.string().min(1).max(1000),
  enabled: z.boolean(),
}).strict();

export const decisionApprovalBodySchema = z.object({ approved: z.boolean() }).strict();
