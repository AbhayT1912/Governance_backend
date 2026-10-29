import { Request, Response } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler";
import { repoQueue, redisAvailable } from "../config/queue";
import { RepoModel } from "../models/repo.model";
import { normalizeRepoUrl, validateGithubRepoUrl } from "../utils/repoUrl.util";
import { AppError } from "../utils/AppError";
import { UsageModel } from "../models/usage.model";
import { RepoReportModel } from "../models/repoReport.model";
import { UserModel } from "../models/user.model";
import { deductUserCredits } from "../middleware/credit.middleware";
import { CREDIT_COSTS } from "../config/creditCost.config";
import { CREDITS_LIMIT } from "../config/creditPolicy.config";
import { logger } from "../config/logger";
import { setNoStoreHeaders } from "../utils/cacheControl.util";
import { getWorkerStatus, isWorkerReady } from "../workers/repo.worker";

const STUCK_TIMEOUT_MS = 90 * 1000;

const startDirectBackgroundProcessing = async (
  repoUrl: string,
  repoId: string,
  logContext: Record<string, unknown>
) => {
  const { processRepository } = await import("../services/repo.service");

  logger.warn("Falling back to direct background processing", {
    ...logContext,
    execution_path: "degraded_direct_background",
    worker_status: getWorkerStatus(),
    repo_id: repoId,
  });

  processRepository(repoUrl, repoId).catch((err: any) => {
    logger.error("Background processRepository failed", {
      repo_id: repoId,
      error: err?.message,
    });
  });
};

const dispatchRepositoryProcessing = async (
  repoUrl: string,
  repoId: string,
  logContext: Record<string, unknown>
) => {
  if (redisAvailable && repoQueue && isWorkerReady()) {
    const job = await repoQueue.add("process-repo", {
      repoUrl,
      repoId,
    });

    logger.info("Repository queued for worker processing", {
      ...logContext,
      execution_path: "queued_to_worker",
      queue_mode: "redis",
      worker_status: getWorkerStatus(),
      job_id: job.id,
      repo_id: repoId,
    });

    return;
  }

  await startDirectBackgroundProcessing(repoUrl, repoId, {
    ...logContext,
    queue_mode: redisAvailable ? "redis_unhealthy" : "degraded",
  });
};

export const analyzeRepository = asyncHandler(
  async (req: Request, res: Response) => {
    let { repo_url } = req.body;
    const userId = (req as any).auth.userId;

    if (!repo_url || typeof repo_url !== "string") {
      throw new AppError("Repository URL is required", 400);
    }

    repo_url = normalizeRepoUrl(repo_url);

    if (!validateGithubRepoUrl(repo_url)) {
      throw new AppError("Invalid GitHub repository URL format", 400);
    }

    const existingOwnedRepo = await RepoModel.findOne({
      repo_url,
      owner_id: userId,
      status: { $ne: "FAILED" },
    });

    if (existingOwnedRepo) {
      const isReady = existingOwnedRepo.status === "READY";
      const updatedAt = (existingOwnedRepo as any).updated_at as Date | undefined;
      const isStuck =
        !isReady &&
        updatedAt &&
        Date.now() - new Date(updatedAt).getTime() > STUCK_TIMEOUT_MS;

      if (isReady) {
        return res.status(200).json({
          success: true,
          repo_id: existingOwnedRepo._id,
          status: existingOwnedRepo.status,
          message: "Repository already processed.",
        });
      }

      if (isStuck) {
        logger.info("Re-processing previously stuck repo", {
          repo_id: existingOwnedRepo._id.toString(),
          stuck_status: existingOwnedRepo.status,
          stuck_since: updatedAt,
        });

        await RepoModel.findByIdAndUpdate(existingOwnedRepo._id, {
          status: "RECEIVED",
          error_message: undefined,
          started_at: undefined,
          completed_at: undefined,
        });

        const repoIdStr = existingOwnedRepo._id.toString();

        await dispatchRepositoryProcessing(repo_url, repoIdStr, {
          reprocess_reason: "stuck_repo_requeued",
          previous_status: existingOwnedRepo.status,
        });

        return res.status(202).json({
          success: true,
          repo_id: existingOwnedRepo._id,
          status: "RECEIVED",
          message: "Repository was stuck and re-processing has started.",
        });
      }

      return res.status(200).json({
        success: true,
        repo_id: existingOwnedRepo._id,
        status: existingOwnedRepo.status,
        message: "Repository is currently being processed.",
      });
    }

    const creditDeduction = await deductUserCredits(userId, CREDIT_COSTS.ANALYZE);

    if (!creditDeduction.ok) {
      return res.status(creditDeduction.status).json({
        message: creditDeduction.message,
      });
    }

    let repo;
    try {
      repo = await RepoModel.create({
        owner_id: userId,
        repo_url,
        status: "RECEIVED",
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        const conflictingRepo = await RepoModel.findOne({
          repo_url,
          owner_id: userId,
        })
          .select("_id owner_id status")
          .lean();

        if (conflictingRepo) {
          return res.status(200).json({
            success: true,
            repo_id: conflictingRepo._id,
            status: conflictingRepo.status,
            message: "Repository already being processed or ready.",
          });
        }
      }

      throw error;
    }

    await UsageModel.updateOne(
      { user_id: userId },
      { $inc: { analyses_count: 1 } },
      { upsert: true }
    );

    await dispatchRepositoryProcessing(repo_url, repo._id.toString(), {
      execution_reason: "new_analysis_request",
      owner_id: userId,
    });

    return res.status(202).json({
      success: true,
      repo_id: repo._id,
      status: "RECEIVED",
    });
  }
);

export const getRepositoryStatus = asyncHandler(
  async (req: any, res: Response) => {
    const { repoId } = req.params;
    const userId = req.auth.userId;

    if (!mongoose.Types.ObjectId.isValid(repoId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid repository ID",
      });
    }

    const repo = await RepoModel.findOne({
      _id: repoId,
      owner_id: userId,
    })
      .select("status error_message started_at completed_at updated_at repo_url")
      .lean();

    if (!repo) {
      return res.status(404).json({
        success: false,
        message: "Repository not found",
      });
    }

    setNoStoreHeaders(res);

    return res.status(200).json({
      success: true,
      data: {
        repo_id: repoId,
        repo_url: repo.repo_url,
        status: repo.status,
        error_message: repo.error_message ?? null,
        started_at: repo.started_at ?? null,
        completed_at: repo.completed_at ?? null,
        updated_at: repo.updated_at ?? null,
      },
    });
  }
);

export const getUserRepositories = asyncHandler(
  async (req: any, res: Response) => {
    const userId = req.auth.userId;

    const repos = await RepoModel.find({
      owner_id: userId,
    })
      .sort({ created_at: -1 })
      .lean();

    const repoIds = repos.map((r) => r._id);

    const latestReports = await RepoReportModel.aggregate([
      { $match: { repo_id: { $in: repoIds } } },
      { $sort: { version: -1 } },
      {
        $group: {
          _id: "$repo_id",
          architecture_health_score: { $first: "$architecture_health_score" },
          version: { $first: "$version" },
          created_at: { $first: "$created_at" },
        },
      },
    ]);

    const reportMap = new Map();
    latestReports.forEach((r) => {
      reportMap.set(r._id.toString(), r);
    });

    const response = repos.map((repo) => {
      const latest = reportMap.get(repo._id.toString());

      return {
        repo_id: repo._id,
        repo_url: repo.repo_url,
        repo_name: repo.repo_url.split("/").pop() || "unknown",
        analyzed_at: latest?.created_at ?? null,
        latest_version: latest?.version ?? null,
        architecture_score: latest?.architecture_health_score ?? null,
      };
    });

    res.status(200).json({
      success: true,
      data: response,
    });
  }
);

export const getDashboardSummary = asyncHandler(
  async (req: any, res: Response) => {
    const userId = req.auth.userId;

    const [usage, user, repoCount, savedAnalyses] = await Promise.all([
      UsageModel.findOne({ user_id: userId }).lean(),
      UserModel.findOne({ clerk_user_id: userId }).lean(),
      RepoModel.countDocuments({ owner_id: userId }),
      RepoReportModel.aggregate([
        {
          $lookup: {
            from: "repositories",
            localField: "repo_id",
            foreignField: "_id",
            as: "repo",
          },
        },
        { $unwind: "$repo" },
        { $match: { "repo.owner_id": userId } },
        { $count: "count" },
      ]),
    ]);

    const creditsLeft = user?.credits ?? 0;
    const aiUsageMetricVersion = Number(usage?.ai_usage_metric_version ?? 1);
    const aiTokensUsed = aiUsageMetricVersion >= 2 ? usage?.ai_tokens_used ?? 0 : 0;
    const totalUsedCredits = Math.max(0, CREDITS_LIMIT - creditsLeft);
    const totalSavedAnalyses = savedAnalyses[0]?.count ?? 0;

    return res.status(200).json({
      success: true,
      data: {
        repos_analyzed: repoCount,
        analyses_saved: totalSavedAnalyses,
        ai_tokens_used: aiTokensUsed,
        ai_model_tokens_used: usage?.ai_model_tokens_used ?? 0,
        ai_queries_count: usage?.ai_queries_count ?? 0,
        credits_left: creditsLeft,
        credits_used: totalUsedCredits,
        credits_limit: CREDITS_LIMIT,
      },
    });
  }
);
