import mongoose from "mongoose";
import {
  AgentModel,
  FindingModel,
} from "../models/governance.model";
import { enforce } from "../governance/pep";
import { FunctionModel } from "../models/function.model";
import { FileModel } from "../models/file.model";
import { SecurityFindingModel } from "../models/securityFinding.model";
import { ImportModel } from "../models/import.model";
import { CallModel } from "../models/call.model";

export function findCriticContradictions(
  findings: Array<{ _id: { toString(): string }; category: string; target: string; riskScore: number; confidence?: number; agentId?: string }>,
  functions: Array<{ _id: { toString(): string }; name: string; is_entry?: boolean }>,
  importedNames: Set<string>,
  weightByAgent: Map<string, number> = new Map(),
  secondRound = false,
) {
  const conflictingIds = new Set<string>();
  const structuralIds = new Set<string>();
  const refutedIds = new Set<string>();
  const threshold = secondRound ? 0.3 : 0.6;
  for (let i = 0; i < findings.length; i += 1) {
    for (let j = i + 1; j < findings.length; j += 1) {
      if (
        findings[i].category === findings[j].category &&
        findings[i].target === findings[j].target &&
        Math.abs(findings[i].riskScore - findings[j].riskScore) >= threshold
      ) {
        conflictingIds.add(findings[i]._id.toString());
        conflictingIds.add(findings[j]._id.toString());
        const leftQuality = (findings[i].confidence || 0) * (weightByAgent.get(findings[i].agentId || "") || 1);
        const rightQuality = (findings[j].confidence || 0) * (weightByAgent.get(findings[j].agentId || "") || 1);
        if (leftQuality < rightQuality) refutedIds.add(findings[i]._id.toString());
        else if (rightQuality < leftQuality) refutedIds.add(findings[j]._id.toString());
      }
    }
  }
  const functionsById = new Map(functions.map((fn) => [fn._id.toString(), fn]));
  for (const finding of findings) {
    if (finding.category !== "dead-code") continue;
    const fn = functionsById.get(finding.target);
    if (fn && (fn.is_entry || importedNames.has(fn.name))) {
      conflictingIds.add(finding._id.toString());
      structuralIds.add(finding._id.toString());
      refutedIds.add(finding._id.toString());
    }
  }
  return { conflictingIds, structuralIds, refutedIds };
}

async function evidenceExists(
  repoId: mongoose.Types.ObjectId,
  evidence: Array<{ kind: string; ref: string }>,
) {
  for (const item of evidence) {
    if (item.kind === "file") {
      if (await FileModel.exists({ repo_id: repoId, path: item.ref })) return true;
    } else if (item.kind === "function") {
      if (
        mongoose.Types.ObjectId.isValid(item.ref) &&
        await FunctionModel.exists({ repo_id: repoId, _id: item.ref })
      ) return true;
    } else if (item.kind === "security_finding") {
      if (
        mongoose.Types.ObjectId.isValid(item.ref) &&
        await SecurityFindingModel.exists({ repo_id: repoId, _id: item.ref })
      ) return true;
    } else if (item.kind === "finding") {
      if (
        mongoose.Types.ObjectId.isValid(item.ref) &&
        await FindingModel.exists({ repoId, _id: item.ref })
      ) return true;
    } else if (item.kind === "edge") {
      const [from, to] = item.ref.split("->");
      if (mongoose.Types.ObjectId.isValid(from) && mongoose.Types.ObjectId.isValid(to) &&
          await CallModel.exists({ repo_id: repoId, caller_function_id: from, callee_function_id: to })) return true;
    }
  }
  return false;
}

export async function reviewJobFindings(jobId: string, findingIds?: string[], secondRound = false) {
  const filter: Record<string, unknown> = { jobId: new mongoose.Types.ObjectId(jobId) };
  if (findingIds) filter._id = { $in: findingIds.map((id) => new mongoose.Types.ObjectId(id)) };
  else filter.reviewStatus = { $in: ["PENDING", "NOT_REQUIRED"] };
  const findings = await FindingModel.find(filter).lean();
  const jobRepoId = findings[0]?.repoId;
  if (!jobRepoId) return;

  const critic = await AgentModel.findOne({
    agentId: "critic",
    status: "ACTIVE",
  }).lean();
  if (!critic) throw new Error("Critic agent is not registered.");

  await enforce({
    type: "tool_call",
    jobId,
    repoId: jobRepoId.toString(),
    agentId: critic.agentId,
    role: critic.role,
    action: "read_findings",
    payload: { jobId, repoId: jobRepoId.toString() },
    context: { depth: 1, repoId: jobRepoId.toString(), tokensUsed: 0 },
  });

  const validById = new Map<string, boolean>();
  for (const finding of findings) {
    validById.set(
      finding._id.toString(),
      await evidenceExists(jobRepoId, finding.evidence),
    );
  }

  const supportingFunctions: Array<{ _id: mongoose.Types.ObjectId; name: string; is_entry?: boolean }> = [];
  const importedNamesForConflict = new Set<string>();
  const deadCodeFindings = findings.filter((finding) => finding.category === "dead-code");
  if (deadCodeFindings.length > 0) {
    await Promise.all([
      enforce({
        type: "tool_call", jobId, repoId: jobRepoId.toString(), agentId: critic.agentId,
        role: critic.role, action: "read_functions",
        payload: { jobId, repoId: jobRepoId.toString() },
        context: { depth: 1, repoId: jobRepoId.toString(), tokensUsed: 0 },
      }),
      enforce({
        type: "tool_call", jobId, repoId: jobRepoId.toString(), agentId: critic.agentId,
        role: critic.role, action: "read_imports",
        payload: { jobId, repoId: jobRepoId.toString() },
        context: { depth: 1, repoId: jobRepoId.toString(), tokensUsed: 0 },
      }),
    ]);
    const [functions, imports] = await Promise.all([
      FunctionModel.find({ repo_id: jobRepoId }).select("name is_entry").lean(),
      ImportModel.find({ repo_id: jobRepoId }).select("specifiers").lean(),
    ]);
    const importedNames = new Set(imports.flatMap((item) => item.specifiers));
    importedNames.forEach((name) => importedNamesForConflict.add(name));
    supportingFunctions.push(...functions);
  }

  const weightRows = await AgentModel.find({ status: "ACTIVE" }).select("agentId trustWeight").lean();
  const weightByAgent = new Map(weightRows.map((item) => [item.agentId, item.trustWeight]));
  const { conflictingIds, structuralIds, refutedIds } = findCriticContradictions(
    findings,
    supportingFunctions,
    importedNamesForConflict,
    weightByAgent,
    secondRound,
  );

  for (const finding of findings) {
    const id = finding._id.toString();
    const valid = validById.get(id) === true;
    const hasConflict = conflictingIds.has(id);
    await enforce({
      type: "tool_call",
      jobId,
      repoId: jobRepoId.toString(),
      agentId: critic.agentId,
      role: critic.role,
      action: "write_review",
      payload: { jobId, repoId: jobRepoId.toString(), findingId: id },
      context: { depth: 1, repoId: jobRepoId.toString(), tokensUsed: 0 },
    });

    await FindingModel.updateOne(
      { _id: finding._id, jobId: new mongoose.Types.ObjectId(jobId) },
      {
        $set: {
          reviewStatus: valid ? "ACCEPTED" : "REJECTED",
          criticVerdict: !valid
            ? "Rejected: evidence no longer resolves to repository data."
            : hasConflict
              ? structuralIds.has(id)
                ? "Contradiction: graph marks the function dead, but it is an entry point or imported symbol."
              : refutedIds.has(id)
                ? secondRound
                  ? "Second review: lower-confidence dissent refuted; confidence reduced."
                  : "Reviewed: lower-confidence contradictory finding refuted."
                : secondRound
                  ? "Second review: conflicting assessments retained as dissent."
                  : "Reviewed: conflicting assessments retained as dissent."
              : "Accepted: evidence reference resolves.",
          ...(refutedIds.has(id) && valid ? { confidence: finding.confidence * 0.3 } : {}),
        },
      },
    );
  }
}
