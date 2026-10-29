import { Request, Response } from "express";
import mongoose from "mongoose";
import { ENV } from "../config/env";
import {
  AnalysisJobModel,
  AuditLogModel,
  DecisionModel,
  FindingModel,
  GovernanceTaskModel,
  PolicyModel,
} from "../models/governance.model";
import { RepoModel } from "../models/repo.model";
import { verifyChain } from "../governance/auditLogger";
import { startGovernanceJob, approveGovernanceDecision } from "../orchestrator/coordinator";
import { asyncHandler } from "../utils/asyncHandler";
import { AppError } from "../utils/AppError";
import { successResponse } from "../utils/response.util";
import {
  decisionApprovalBodySchema,
  governanceJobBodySchema,
  governancePolicyBodySchema,
} from "../validators/governance.validator";
import { isGovernanceAdmin } from "../governance/access";
import { enforce } from "../governance/pep";

const objectId = (id: string, label = "ID") => {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new AppError(`Invalid ${label}.`, 400);
};

const routeParam = (value: string | string[] | undefined, label: string) => {
  if (typeof value !== "string") throw new AppError(`Invalid ${label}.`, 400);
  return value;
};

async function ownedJob(jobId: string, userId: string) {
  objectId(jobId, "job ID");
  const job = await AnalysisJobModel.findById(jobId).lean();
  if (!job) throw new AppError("Analysis job not found.", 404);
  const repo = await RepoModel.findOne({ _id: job.repoId, owner_id: userId }).select("_id").lean();
  if (!repo) throw new AppError("Analysis job not found.", 404);
  return job;
}

export const createGovernanceJob = asyncHandler(async (req: Request, res: Response) => {
  const parsed = governanceJobBodySchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(parsed.error.issues.map((issue) => issue.message).join("; "), 400);
  objectId(parsed.data.repo_id, "repository ID");
  const job = await startGovernanceJob({
    repoId: parsed.data.repo_id,
    analysisTypes: parsed.data.analysis_types,
    question: parsed.data.question,
    actor: { id: (req as any).auth.userId, type: "user" },
  });
  return successResponse(res, job, 202, "Governance analysis started.");
});

export const getGovernanceJob = asyncHandler(async (req: Request, res: Response) => {
  const job = await ownedJob(routeParam(req.params.jobId, "job ID"), (req as any).auth.userId);
  const tasks = await GovernanceTaskModel.find({ jobId: job._id }).select("type assignedAgent status error createdAt updatedAt").sort({ createdAt: 1 }).lean();
  return successResponse(res, { ...job, tasks });
});

export const getGovernanceFindings = asyncHandler(async (req: Request, res: Response) => {
  const job = await ownedJob(routeParam(req.params.jobId, "job ID"), (req as any).auth.userId);
  const filter: Record<string, unknown> = { jobId: job._id };
  if (typeof req.query.agent === "string") filter.agentId = req.query.agent;
  if (typeof req.query.category === "string") filter.category = req.query.category;
  const findings = await FindingModel.find(filter).sort({ createdAt: 1 }).lean();
  return successResponse(res, findings);
});

export const getGovernanceDecision = asyncHandler(async (req: Request, res: Response) => {
  const job = await ownedJob(routeParam(req.params.jobId, "job ID"), (req as any).auth.userId);
  const decisions = await DecisionModel.find({ jobId: job._id }).sort({ category: 1, target: 1 }).lean();
  if (decisions.length === 0 && job.status !== "COMPLETED" && job.status !== "ESCALATED") {
    return successResponse(res, { status: job.status, decisions: [] }, 202);
  }
  const ids = Array.from(new Set(decisions.flatMap((decision) => [...decision.findingIds, ...decision.dissentIds]).map(String)));
  const findings = await FindingModel.find({ _id: { $in: ids } }).lean();
  const byId = new Map(findings.map((finding) => [finding._id.toString(), finding]));
  return successResponse(res, {
    status: job.status,
    decisions: decisions.map((decision) => ({
      ...decision,
      findings: decision.findingIds.map((id) => byId.get(id.toString())).filter(Boolean),
      dissent: decision.dissentIds.map((id) => byId.get(id.toString())).filter(Boolean),
    })),
  });
});

export const getGovernanceAgents = asyncHandler(async (_req: Request, res: Response) => {
  const { AgentModel } = await import("../models/governance.model");
  const agents = await AgentModel.find({ status: "ACTIVE" }).select("agentId role capabilities allowedTools trustWeight status").sort({ agentId: 1 }).lean();
  return successResponse(res, agents);
});

export const getGovernancePolicies = asyncHandler(async (_req: Request, res: Response) => {
  const policies = await PolicyModel.aggregate([
    { $sort: { policyId: 1, version: -1 } },
    { $group: { _id: "$policyId", policy: { $first: "$$ROOT" } } },
    { $replaceRoot: { newRoot: "$policy" } },
    { $sort: { policyId: 1 } },
  ]);
  return successResponse(res, policies.filter((policy) => policy.enabled));
});

export const updateGovernancePolicy = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req as any).auth.userId as string;
  if (!isGovernanceAdmin(userId, ENV.GOVERNANCE_ADMIN_USER_IDS)) throw new AppError("Administrator access required.", 403);
  const policyId = routeParam(req.params.id, "policy ID");
  if (!/^[A-Z0-9-]{3,80}$/.test(policyId)) throw new AppError("Invalid policy ID.", 400);
  const parsed = governancePolicyBodySchema.safeParse(req.body);
  if (!parsed.success) throw new AppError(parsed.error.issues.map((issue) => issue.message).join("; "), 400);
  const latest = await PolicyModel.findOne({ policyId }).sort({ version: -1 }).lean();
  if (!latest) throw new AppError("Policy not found.", 404);
  await enforce({
    type: "message",
    jobId: "system",
    repoId: "system",
    agentId: `user:${userId}`,
    role: "admin",
    action: "policy_update",
    payload: { policyId, nextVersion: latest.version + 1, policy: parsed.data },
    context: { depth: 0, repoId: "system", tokensUsed: 0 },
  });
  const policy = await PolicyModel.create({ policyId: latest.policyId, version: latest.version + 1, ...parsed.data });
  return successResponse(res, policy, 201, "Policy version created.");
});

export const getGovernanceViolations = asyncHandler(async (req: Request, res: Response) => {
  const filter: Record<string, unknown> = { decision: { $in: ["DENY", "REDACT", "ESCALATE"] } };
  if (typeof req.query.jobId === "string") {
    const job = await ownedJob(req.query.jobId, (req as any).auth.userId);
    filter.jobId = job._id.toString();
  } else {
    const repos = await RepoModel.find({ owner_id: (req as any).auth.userId }).select("_id").lean();
    const jobs = await AnalysisJobModel.find({ repoId: { $in: repos.map((repo) => repo._id) } }).select("_id").lean();
    filter.jobId = { $in: jobs.map((job) => job._id.toString()) };
  }
  const records = await AuditLogModel.find(filter).sort({ seq: -1 }).limit(200).lean();
  return successResponse(res, records);
});

export const getGovernanceAudit = asyncHandler(async (req: Request, res: Response) => {
  const filter: Record<string, unknown> = {};
  if (typeof req.query.jobId === "string") {
    const job = await ownedJob(req.query.jobId, (req as any).auth.userId);
    filter.jobId = job._id.toString();
  } else {
    const repos = await RepoModel.find({ owner_id: (req as any).auth.userId }).select("_id").lean();
    const jobs = await AnalysisJobModel.find({ repoId: { $in: repos.map((repo) => repo._id) } }).select("_id").lean();
    filter.jobId = { $in: jobs.map((job) => job._id.toString()) };
  }
  const records = await AuditLogModel.find(filter).sort({ seq: -1 }).limit(500).lean();
  return successResponse(res, records.reverse());
});

export const verifyGovernanceAudit = asyncHandler(async (_req: Request, res: Response) => {
  return successResponse(res, await verifyChain());
});

export const approveGovernance = asyncHandler(async (req: Request, res: Response) => {
  const parsed = decisionApprovalBodySchema.safeParse(req.body);
  if (!parsed.success) throw new AppError("Body must include approved: boolean.", 400);
  const decision = await approveGovernanceDecision({
    decisionId: routeParam(req.params.id, "decision ID"),
    actorId: (req as any).auth.userId,
    approved: parsed.data.approved,
  });
  return successResponse(res, decision, 200, parsed.data.approved ? "Decision approved." : "Decision rejected.");
});
