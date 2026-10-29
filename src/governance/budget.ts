import mongoose from "mongoose";
import { AnalysisJobModel, GovernanceTaskModel } from "../models/governance.model";

export const MAX_LLM_CALLS_PER_AGENT_TASK = 5;
export const MAX_TOKENS_PER_JOB = 20_000;

export async function getJobTokensUsed(jobId: string) {
  const job = await AnalysisJobModel.findById(jobId).select("tokensUsed").lean();
  return job?.tokensUsed || 0;
}

export async function getTaskLlmCalls(taskId: string) {
  const task = await GovernanceTaskModel.findById(taskId).select("llmCalls").lean();
  return task?.llmCalls || 0;
}

export async function reserveAgentLlmCall(jobId: string, taskId: string) {
  const task = await GovernanceTaskModel.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(taskId),
      jobId: new mongoose.Types.ObjectId(jobId),
      $or: [
        { llmCalls: { $exists: false } },
        { llmCalls: { $lt: MAX_LLM_CALLS_PER_AGENT_TASK } },
      ],
    },
    { $inc: { llmCalls: 1 } },
    { new: true },
  ).select("_id");
  if (!task) throw new Error("Agent LLM call budget exceeded or task is unavailable.");
}

export async function recordLlmTokenUsage(jobId: string, taskId: string, tokens: number) {
  const safeTokens = Number.isFinite(tokens) && tokens > 0 ? Math.ceil(tokens) : 0;
  if (!safeTokens) return;
  const job = await AnalysisJobModel.findOneAndUpdate(
    { _id: new mongoose.Types.ObjectId(jobId) },
    { $inc: { tokensUsed: safeTokens } },
    { new: true },
  ).select("_id");
  if (!job) throw new Error("Analysis job token budget exceeded or job is unavailable.");
  await GovernanceTaskModel.updateOne(
    { _id: new mongoose.Types.ObjectId(taskId), jobId: new mongoose.Types.ObjectId(jobId) },
    { $inc: { tokensUsed: safeTokens } },
  );
  const totalTokens = await getJobTokensUsed(jobId);
  if (totalTokens > MAX_TOKENS_PER_JOB) throw new Error("Analysis job token budget exceeded.");
}
