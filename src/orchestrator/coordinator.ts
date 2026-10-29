import { createHash } from "crypto";
import mongoose from "mongoose";
import { RepoModel } from "../models/repo.model";
import {
  AnalysisJobModel,
  AgentModel,
  DecisionModel,
  DecisionDocument,
  FindingModel,
  GovernanceTaskModel,
} from "../models/governance.model";
import { getAgent, isPolicyActive, listActiveAgents as getRegisteredAgents } from "../governance/agentRegistry";
import { enforce } from "../governance/pep";
import { ActorIdentity } from "../governance/types";
import { publishAgentMessage } from "../memory/sharedMemory.service";
import { logger } from "../config/logger";
import { AppError } from "../utils/AppError";
import { indexGovernanceResults } from "../services/ai.service";
import { getJobTokensUsed } from "../governance/budget";
import { getRepositoryCommitSha } from "../services/git.service";
import { getRepoPath } from "../utils/repoPath.util";

const PLAN: Record<string, { agentId: string; requiredCapability: string }> = {
  structure: { agentId: "structure", requiredCapability: "structure_summary" },
  dependency: { agentId: "dependency", requiredCapability: "dependency_analysis" },
  "dead-code": { agentId: "dead-code", requiredCapability: "dead_code_analysis" },
  security: { agentId: "security", requiredCapability: "security_analysis" },
  quality: { agentId: "quality", requiredCapability: "quality_analysis" },
};
const SUPPORTED_TYPES = new Set([...Object.keys(PLAN), "qa"]);

export function buildTaskFingerprint(repoId: string, version: string, type: string, question = "") {
  return createHash("sha256")
    .update([repoId, version, type, question.trim()].join("\0"))
    .digest("hex");
}

export async function startGovernanceJob(input: {
  repoId: string;
  analysisTypes: string[];
  question?: string;
  actor: ActorIdentity;
}) {
  if (!mongoose.Types.ObjectId.isValid(input.repoId)) {
    throw new AppError("Invalid repository ID.", 400);
  }
  const repo = await RepoModel.findById(input.repoId);
  if (!repo) throw new AppError("Repository not found.", 404);
  if (String(repo.owner_id) !== input.actor.id) {
    throw new AppError("Forbidden: repository is not owned by this user.", 403);
  }
  if (repo.status !== "READY") throw new AppError("Repository is not READY.", 409);

  const selectedTypes = input.analysisTypes.length
    ? Array.from(new Set(input.analysisTypes))
    : ["structure", "dependency", "dead-code", "security", "quality"];
  const unsupported = selectedTypes.filter((type) => !SUPPORTED_TYPES.has(type));
  if (unsupported.length > 0) {
    throw new AppError(`Unsupported analysis type(s): ${unsupported.join(", ")}`, 400);
  }
  if (input.question && !selectedTypes.includes("qa")) selectedTypes.push("qa");
  if (selectedTypes.includes("qa") && !input.question?.trim()) {
    throw new AppError("The Q&A agent requires a non-empty question.", 400);
  }

  const job = await AnalysisJobModel.create({
    repoId: repo._id,
    requestedBy: input.actor.id,
    analysisTypes: selectedTypes,
    question: input.question,
    status: "PLANNING",
    plan: [],
  });
  let repoVersion = repo.completed_at?.toISOString() || repo._id.toString();
  try {
    repoVersion = await getRepositoryCommitSha(getRepoPath(input.repoId));
  } catch (error) {
    logger.warn("Could not read repository commit; using READY version timestamp for task cache", {
      repo_id: input.repoId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const plannedTasks: Array<{
    task: InstanceType<typeof GovernanceTaskModel>;
    agentId: string;
    reused: boolean;
  }> = [];
  const planItems: Array<{ type: string; agentId: string; taskId: mongoose.Types.ObjectId }> = [];
  try {
    const duplicateReuseEnabled = await isPolicyActive("POL-DUP-001", "ALLOW");
    for (const type of selectedTypes) {
      const taskPlan = type === "qa"
        ? { agentId: "qa", requiredCapability: "repository_question_answering" }
        : PLAN[type];
      const agent = await getAgent(taskPlan.agentId);
      if (!agent) throw new Error(`Required agent ${taskPlan.agentId} is unavailable.`);

      await enforce({
        type: "delegate",
        jobId: job._id.toString(),
        repoId: input.repoId,
        agentId: "coordinator",
        role: "coordinator",
        action: taskPlan.agentId,
        payload: { jobId: job._id.toString(), repoId: input.repoId, requiredCapability: taskPlan.requiredCapability },
        context: { depth: 1, repoId: input.repoId, tokensUsed: 0, delegationChain: ["coordinator"] },
      });

      const taskFingerprint = buildTaskFingerprint(
        input.repoId,
        repoVersion,
        type,
        type === "qa" ? input.question : "",
      );
      const cachedTask = duplicateReuseEnabled ? await GovernanceTaskModel.findOne({
        repoId: repo._id,
        fingerprint: taskFingerprint,
        status: "COMPLETED",
      }).sort({ updatedAt: -1 }) : null;

      const task = await GovernanceTaskModel.create({
        jobId: job._id,
        repoId: repo._id,
        type,
        assignedAgent: taskPlan.agentId,
        delegatedBy: "coordinator",
        depth: 1,
        fingerprint: taskFingerprint,
        question: type === "qa" ? input.question : undefined,
        status: cachedTask ? "REUSED" : "QUEUED",
        reusedFromTaskId: cachedTask?._id,
      });
      if (cachedTask) {
        const cachedFindings = await FindingModel.find({
          taskId: cachedTask._id,
        }).lean();
        if (cachedFindings.length > 0) {
          await FindingModel.insertMany(
            cachedFindings.map(({ _id, createdAt, updatedAt, ...finding }) => ({
              ...finding,
              _id: new mongoose.Types.ObjectId(),
              jobId: job._id,
              taskId: task._id,
            })),
          );
        }
      }

      planItems.push({ type, agentId: taskPlan.agentId, taskId: task._id });
      plannedTasks.push({ task, agentId: taskPlan.agentId, reused: Boolean(cachedTask) });
      if (cachedTask) {
        await publishAgentMessage({
          jobId: job._id.toString(),
          repoId: input.repoId,
          from: "coordinator",
          topic: "duplicate-work-reused",
          body: `Reused completed ${type} analysis for the same repository version.`,
        }).catch((error) => {
          logger.warn("Could not write duplicate-task memory message", {
            job_id: job._id.toString(),
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }

    await AnalysisJobModel.updateOne(
      { _id: job._id },
      { $set: { status: "RUNNING", plan: planItems } },
    );

    for (const item of plannedTasks) {
      if (item.reused) continue;
      const { enqueueAgentTask } = await import("../workers/governance.worker");
      await enqueueAgentTask(item.agentId, item.task._id.toString());
    }

    await finalizeJobIfReady(job._id.toString());
    return AnalysisJobModel.findById(job._id).lean();
  } catch (error) {
    await GovernanceTaskModel.updateMany(
      { jobId: job._id, status: "QUEUED" },
      { $set: { status: "FAILED", error: "Job planning or task dispatch failed." } },
    );
    await AnalysisJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: "FAILED",
          error: error instanceof Error ? error.message : String(error),
          completedAt: new Date(),
        },
      },
    );
    throw error;
  }
}

export async function indexGovernanceJob(jobId: string) {
  const job = await AnalysisJobModel.findById(jobId);
  if (!job || !["COMPLETED", "ESCALATED"].includes(job.status)) return false;
  await AnalysisJobModel.updateOne(
    { _id: job._id },
    { $set: { ragIndexingStatus: "PENDING" }, $unset: { ragIndexingError: 1 } },
  );
  try {
    await enforce({
      type: "tool_call",
      jobId: job._id.toString(),
      repoId: job.repoId.toString(),
      agentId: "coordinator",
      role: "coordinator",
      action: "index_rag",
      payload: { jobId: job._id.toString(), repoId: job.repoId.toString() },
      context: {
        depth: 0,
        repoId: job.repoId.toString(),
        tokensUsed: 0,
      },
    });
    const [findings, decisions] = await Promise.all([
      FindingModel.find({ jobId: job._id, reviewStatus: { $ne: "REJECTED" } }).lean(),
      DecisionModel.find({ jobId: job._id }).lean(),
    ]);
    await indexGovernanceResults(
      job.repoId.toString(),
      job._id.toString(),
      findings.map((finding) => ({
        id: finding._id.toString(),
        category: finding.category,
        target: finding.target,
        claim: finding.claim,
        riskScore: finding.riskScore,
        confidence: finding.confidence,
        evidence: finding.evidence,
      })),
      decisions.map((decision) => ({
        id: decision._id.toString(),
        category: decision.category,
        target: decision.target,
        score: decision.score,
        agreement: decision.agreement,
        status: decision.status,
        findingIds: decision.findingIds.map(String),
        dissentIds: decision.dissentIds.map(String),
      })),
      { agentId: "coordinator", jobId: job._id.toString() },
    );
    await AnalysisJobModel.updateOne({ _id: job._id }, { $set: { ragIndexingStatus: "INDEXED" } });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await AnalysisJobModel.updateOne(
      { _id: job._id },
      { $set: { ragIndexingStatus: "FAILED", ragIndexingError: message } },
    );
    logger.warn("Governance results could not be indexed in RAG", {
      job_id: job._id.toString(),
      error: message,
    });
    return false;
  }
}

export async function retryPendingGovernanceIndexing() {
  const jobs = await AnalysisJobModel.find({
    status: { $in: ["COMPLETED", "ESCALATED"] },
    ragIndexingStatus: { $ne: "INDEXED" },
  }).select("_id").limit(20).lean();
  return Promise.allSettled(jobs.map((job) => indexGovernanceJob(job._id.toString())));
}

export async function finalizeJobIfReady(jobId: string) {
  const tasks = await GovernanceTaskModel.find({
    jobId: new mongoose.Types.ObjectId(jobId),
  }).select("status").lean();
  if (tasks.some((task) => task.status === "QUEUED" || task.status === "RUNNING")) return;
  if (tasks.some((task) => task.status === "FAILED")) {
    await failJobIfNecessary(jobId);
    return;
  }

  const job = await AnalysisJobModel.findOneAndUpdate(
    { _id: new mongoose.Types.ObjectId(jobId), status: "RUNNING" },
    { $set: { status: "AWAITING_CONSENSUS" } },
    { new: true },
  );
  if (!job) return;

  const { reviewJobFindings } = await import("../agents/criticAgent");
  const { makeConsensusDecision } = await import("../consensus/consensusEngine");
  try {
    await reviewJobFindings(jobId);
    const result = await makeConsensusDecision(jobId, job.repoId.toString());
    await AnalysisJobModel.updateOne(
      { _id: job._id, status: "AWAITING_CONSENSUS" },
      {
        $set: {
          status: result.escalated ? "ESCALATED" : "COMPLETED",
          completedAt: new Date(),
        },
      },
    );
    await indexGovernanceJob(jobId);
  } catch (error) {
    await AnalysisJobModel.updateOne(
      { _id: job._id, status: "AWAITING_CONSENSUS" },
      {
        $set: {
          status: "FAILED",
          error: error instanceof Error ? error.message : String(error),
          completedAt: new Date(),
        },
      },
    );
    throw error;
  }
}

export async function failJobIfNecessary(jobId: string) {
  const [job, tasks] = await Promise.all([
    AnalysisJobModel.findById(jobId),
    GovernanceTaskModel.find({ jobId: new mongoose.Types.ObjectId(jobId) })
      .select("status")
      .lean(),
  ]);
  if (!job || tasks.some((task) => task.status === "QUEUED" || task.status === "RUNNING")) return;
  const failed = tasks.filter((task) => task.status === "FAILED").length;
  if (failed > 0) {
    await AnalysisJobModel.updateOne(
      { _id: job._id, status: { $in: ["RUNNING", "PLANNING"] } },
      {
        $set: {
          status: "FAILED",
          error: `${failed} agent task(s) failed.`,
          completedAt: new Date(),
        },
      },
    );
  }
}

export async function approveGovernanceDecision(input: {
  decisionId: string;
  actorId: string;
  approved: boolean;
}) {
  if (!mongoose.Types.ObjectId.isValid(input.decisionId)) {
    throw new AppError("Invalid decision ID.", 400);
  }
  const decision = await DecisionModel.findById(input.decisionId);
  if (!decision) throw new AppError("Decision not found.", 404);
  const repo = await RepoModel.findById(decision.repoId);
  if (!repo || String(repo.owner_id) !== input.actorId) {
    throw new AppError("Forbidden: repository is not owned by this user.", 403);
  }
  if (decision.status !== "ESCALATED") {
    throw new AppError("Only escalated decisions can be approved or rejected.", 409);
  }
  await enforce({
    type: "message",
    jobId: decision.jobId.toString(),
    repoId: decision.repoId.toString(),
    agentId: `user:${input.actorId}`,
    role: "user",
    action: "decision_approval",
    payload: {
      jobId: decision.jobId.toString(),
      repoId: decision.repoId.toString(),
      decisionId: decision._id.toString(),
      approved: input.approved,
    },
    context: {
      depth: 0,
      repoId: decision.repoId.toString(),
      tokensUsed: await getJobTokensUsed(decision.jobId.toString()),
    },
  });
  const updatedDecision = await DecisionModel.findOneAndUpdate(
    { _id: decision._id, status: "ESCALATED" },
    {
      $set: {
        status: input.approved ? "ACCEPTED" : "REJECTED",
        approvedBy: input.actorId,
        approval: input.approved ? "APPROVED" : "REJECTED",
      },
    },
    { new: true },
  );
  if (!updatedDecision) throw new AppError("Decision was already reviewed.", 409);
  const remainingEscalations = await DecisionModel.countDocuments({
    jobId: updatedDecision.jobId,
    status: "ESCALATED",
  });
  await AnalysisJobModel.updateOne({ _id: updatedDecision.jobId }, {
    $set: { status: remainingEscalations === 0 ? "COMPLETED" : "ESCALATED" },
  });
  if (input.approved) await adjustTrustWeightsForDecision(updatedDecision);
  return updatedDecision;
}

async function adjustTrustWeightsForDecision(decision: Pick<DecisionDocument, "_id" | "jobId" | "repoId" | "findingIds" | "dissentIds">) {
  const [supporters, dissenters] = await Promise.all([
    FindingModel.find({ _id: { $in: decision.findingIds } }).distinct("agentId"),
    FindingModel.find({ _id: { $in: decision.dissentIds } }).distinct("agentId"),
  ]);
  const adjustments = [
    ...supporters.map((agentId) => ({ agentId, delta: 0.05 })),
    ...dissenters.filter((agentId) => !supporters.includes(agentId)).map((agentId) => ({ agentId, delta: -0.05 })),
  ];
  if (!adjustments.length) {
    await DecisionModel.updateOne({ _id: decision._id }, { $set: { trustAdjustedAt: new Date() } });
    return;
  }
  try {
    await enforce({
      type: "message",
      jobId: decision.jobId.toString(),
      repoId: decision.repoId.toString(),
      agentId: "coordinator",
      role: "coordinator",
      action: "trust_weight_update",
      payload: { jobId: decision.jobId.toString(), repoId: decision.repoId.toString(), decisionId: decision._id.toString(), adjustments },
      context: { depth: 0, repoId: decision.repoId.toString(), tokensUsed: 0 },
    });

    for (const adjustment of adjustments) {
      await AgentModel.updateOne(
        {
          agentId: adjustment.agentId,
          trustAdjustmentDecisionIds: { $ne: decision._id.toString() },
        },
        [{
          $set: {
            trustWeight: {
              $max: [0.5, { $min: [1.5, { $add: [{ $ifNull: ["$trustWeight", 1] }, adjustment.delta] }] }],
            },
            trustAdjustmentDecisionIds: {
              $setUnion: [{ $ifNull: ["$trustAdjustmentDecisionIds", []] }, [decision._id.toString()]],
            },
          },
        }],
      );
    }
    await DecisionModel.updateOne({ _id: decision._id }, { $set: { trustAdjustedAt: new Date() } });
  } catch (error) {
    logger.warn("Trust weight adjustment will be retried", {
      decision_id: decision._id.toString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function retryPendingTrustAdjustments() {
  const decisions = await DecisionModel.find({ approval: "APPROVED", trustAdjustedAt: { $exists: false } })
    .limit(20)
    .lean();
  return Promise.allSettled(decisions.map((decision) => adjustTrustWeightsForDecision(decision)));
}

export async function listActiveAgents() {
  return getRegisteredAgents();
}
