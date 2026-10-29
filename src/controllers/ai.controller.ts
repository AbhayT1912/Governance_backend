import { Response } from "express";
import mongoose from "mongoose";
import { RepoModel } from "../models/repo.model";
import { asyncHandler } from "../utils/asyncHandler";
import { AppError } from "../utils/AppError";
import { sanitizeQuestion } from "../utils/question.util";
import { askAIService } from "../services/ai.service";
import { UsageModel } from "../models/usage.model";
import { CREDIT_COSTS } from "../config/creditCost.config";

const extractTotalTokens = (usage: any): number => {
  const candidates = [
    usage?.totalTokens,
    usage?.total_tokens,
    usage?.totalTokenCount,
    usage?.promptTokens != null && usage?.completionTokens != null
      ? Number(usage.promptTokens) + Number(usage.completionTokens)
      : undefined,
    usage?.prompt_tokens != null && usage?.completion_tokens != null
      ? Number(usage.prompt_tokens) + Number(usage.completion_tokens)
      : undefined,
  ];
  const value = Number(candidates.find((c) => c != null));
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value);
};

export const askQuestion = asyncHandler(
  async (req: any, res: Response) => {
    const { repo_id, question } = req.body;

    // Validate repo_id
    if (!repo_id || !mongoose.Types.ObjectId.isValid(repo_id)) {
      throw new AppError("Invalid repository ID", 400);
    }

    // Sanitize question
    let sanitizedQuestion: string;
    try {
      sanitizedQuestion = sanitizeQuestion(question);
    } catch (error: any) {
      throw new AppError(error?.message || "Invalid question", 400);
    }

    // Check repo exists
    const repo = await RepoModel.findById(repo_id);
    if (!repo) {
      throw new AppError("Repository not found", 404);
    }
    if (String(repo.owner_id) !== String(req.auth.userId)) {
      throw new AppError("Repository access denied", 403);
    }

    // Check repo is ready
    if (repo.status !== "READY") {
      return res.status(200).json({
        success: false,
        message: "Repository not ready for queries",
        data: {
          repo_id,
          status: repo.status,
        },
      });
    }

    // 🔥 Forward to external RAG service with proper error handling
    let aiResponse;
    try {
      aiResponse = await askAIService(repo_id, sanitizedQuestion);
    } catch (ragError: any) {
      const isTimeout =
        ragError?.code === "ECONNABORTED" ||
        ragError?.message?.includes("timeout");
      const statusCode = ragError?.response?.status || (isTimeout ? 504 : 500);
      const errorMessage =
        ragError?.response?.data?.error ||
        ragError?.response?.data?.message ||
        ragError?.message ||
        "RAG service is temporarily unavailable";

      throw new AppError(
        `AI Analysis: ${errorMessage}${isTimeout ? " (Service is warming up, please retry)" : ""}`,
        statusCode
      );
    }

    const answer = aiResponse.answer;
    const usage = aiResponse.usage;
    const modelTokenIncrement = extractTotalTokens(usage);
    const aiCostIncrement = CREDIT_COSTS.ASK_AI;

    await UsageModel.updateOne(
      { user_id: req.auth.userId },
      {
        $inc: {
          ai_tokens_used: aiCostIncrement,
          ai_queries_count: 1,
          ai_model_tokens_used: modelTokenIncrement,
        },
        $set: { ai_usage_metric_version: 2 },
      },
      { upsert: true }
    );

    return res.status(200).json({
      success: true,
      data: {
        repo_id,
        question: sanitizedQuestion,
        answer,
        usage: usage || {
          totalTokens: modelTokenIncrement,
          promptTokens: 0,
          completionTokens: 0,
        },
      },
    });
  }
);
