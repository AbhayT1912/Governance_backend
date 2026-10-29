import mongoose from "mongoose";
import {
  AgentModel,
  DecisionModel,
  FindingModel,
} from "../models/governance.model";
import { getAuditSequenceRange } from "../governance/auditLogger";

export type ConsensusInput = {
  riskScore: number;
  confidence: number;
  weight: number;
};

export function calculateConsensus(group: ConsensusInput[]) {
  const denominator = group.reduce((sum, item) => sum + item.weight * item.confidence, 0);
  if (!denominator) return { score: 0, agreement: 1 };
  const score = group.reduce(
    (sum, item) => sum + item.weight * item.confidence * item.riskScore,
    0,
  ) / denominator;
  const variance = group.reduce(
    (sum, item) => sum + item.weight * item.confidence * (item.riskScore - score) ** 2,
    0,
  ) / denominator;
  return {
    score,
    agreement: Math.max(0, Math.min(1, 1 - Math.sqrt(variance) / 0.5)),
  };
}

type FindingRow = {
  _id: mongoose.Types.ObjectId;
  category: string;
  target: string;
  riskScore: number;
  confidence: number;
  agentId: string;
  reviewStatus: string;
};

export async function makeConsensusDecision(jobId: string, repoId: string) {
  const id = new mongoose.Types.ObjectId(jobId);
  const [agentRows, auditStart] = await Promise.all([
    AgentModel.find({ status: "ACTIVE" }).select("agentId trustWeight").lean(),
    getAuditSequenceRange(jobId),
  ]);
  const weightByAgent = new Map(agentRows.map((agent) => [agent.agentId, agent.trustWeight]));
  const runGroups = async () => {
    const findings = await FindingModel.find({
      jobId: id,
      reviewStatus: { $ne: "REJECTED" },
    }).lean() as unknown as FindingRow[];
    const groups = new Map<string, FindingRow[]>();
    for (const finding of findings) {
      const key = `${finding.category}\0${finding.target}`;
      groups.set(key, [...(groups.get(key) || []), finding]);
    }
    return { findings, groups };
  };

  let { findings, groups } = await runGroups();
  const secondReviewIds = new Set<string>();
  for (const group of groups.values()) {
    const values = group.map((finding) => ({
      riskScore: finding.riskScore,
      confidence: finding.confidence,
      weight: weightByAgent.get(finding.agentId) || 1,
    }));
    if (calculateConsensus(values).agreement < 0.6) {
      group.forEach((finding) => secondReviewIds.add(finding._id.toString()));
    }
  }

  if (secondReviewIds.size > 0) {
    const { reviewJobFindings } = await import("../agents/criticAgent");
    await reviewJobFindings(jobId, Array.from(secondReviewIds), true);
    ({ findings, groups } = await runGroups());
  }

  const auditRange = await getAuditSequenceRange(jobId);
  const persistDecision = async (category: string, target: string, group: FindingRow[]) => {
    const { score, agreement } = calculateConsensus(group.map((finding) => ({
      riskScore: finding.riskScore,
      confidence: finding.confidence,
      weight: weightByAgent.get(finding.agentId) || 1,
    })));
    const status = agreement < 0.6 || score > 0.8 ? "ESCALATED" : "ACCEPTED";
    const findingIds: mongoose.Types.ObjectId[] = [];
    const dissentIds: mongoose.Types.ObjectId[] = [];
    for (const finding of group) {
      if (Math.abs(finding.riskScore - score) < 0.3) findingIds.push(finding._id);
      else dissentIds.push(finding._id);
    }
    await DecisionModel.updateOne(
      { jobId: id, category, target },
      {
        $set: {
          repoId: new mongoose.Types.ObjectId(repoId),
          score,
          agreement,
          status,
          findingIds,
          dissentIds,
          auditStartSeq: auditStart.start,
          auditEndSeq: auditRange.end,
        },
      },
      { upsert: true },
    );
    return { score, agreement, status };
  };

  let escalated = false;
  for (const [key, group] of groups) {
    const [category, target] = key.split("\0");
    const decision = await persistDecision(category, target, group);
    if (decision.status === "ESCALATED") escalated = true;
  }

  const summary = await persistDecision("overall", "repository", findings);
  if (summary.status === "ESCALATED") escalated = true;
  return { escalated, decisionCount: groups.size + 1 };
}
