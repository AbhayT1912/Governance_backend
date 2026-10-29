import mongoose from "mongoose";
import {
  AgentMessageModel,
  AgentModel,
} from "../models/governance.model";
import { enforce } from "../governance/pep";
import { getJobTokensUsed } from "../governance/budget";

export async function publishAgentMessage(input: {
  jobId: string;
  repoId: string;
  from: string;
  to?: string;
  topic: string;
  body: string;
  visibility?: "job" | "role" | "private";
  roles?: string[];
}) {
  const agent = await AgentModel.findOne({
    agentId: input.from,
    status: "ACTIVE",
  }).lean();
  if (!agent) throw new Error(`Unknown message author ${input.from}.`);

  const decision = await enforce({
    type: "message",
    jobId: input.jobId,
    repoId: input.repoId,
    agentId: input.from,
    role: agent.role,
    action: input.topic,
    payload: {
      jobId: input.jobId,
      repoId: input.repoId,
      body: input.body,
    },
    context: { depth: 0, repoId: input.repoId, tokensUsed: await getJobTokensUsed(input.jobId) },
  });
  const payload = decision.redactedPayload as { body?: string } | undefined;

  return AgentMessageModel.create({
    ...input,
    jobId: new mongoose.Types.ObjectId(input.jobId),
    repoId: new mongoose.Types.ObjectId(input.repoId),
    body: payload?.body || input.body,
    visibility: input.visibility || "job",
    roles: input.roles || [],
    policyDecision: decision.effect,
  });
}

export async function readAgentMessages(input: {
  jobId: string;
  repoId: string;
  agentId: string;
  role: string;
}) {
  const decision = await enforce({
    type: "tool_call",
    jobId: input.jobId,
    repoId: input.repoId,
    agentId: input.agentId,
    role: input.role,
    action: "read_messages",
    payload: { jobId: input.jobId, repoId: input.repoId },
    context: { depth: 1, repoId: input.repoId, tokensUsed: await getJobTokensUsed(input.jobId) },
  });

  if (decision.effect === "DENY") return [];
  return AgentMessageModel.find({
    jobId: new mongoose.Types.ObjectId(input.jobId),
    repoId: new mongoose.Types.ObjectId(input.repoId),
    $or: [
      { visibility: "job" },
      { visibility: "role", roles: input.role },
      { visibility: "private", $or: [{ from: input.agentId }, { to: input.agentId }] },
    ],
  })
    .select("from to topic body visibility createdAt")
    .lean();
}
