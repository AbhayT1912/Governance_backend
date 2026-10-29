import app from "./app";
import { ENV } from "./config/env";
import { logger } from "./config/logger";
import { connectDB } from "./config/database";
import { initializeQueue, queueMode } from "./config/queue";
import { getWorkerStatus, initializeRepoWorker } from "./workers/repo.worker";
import { RepoModel } from "./models/repo.model";
import { processRepository } from "./services/repo.service";
import { seedAgentRegistry } from "./governance/agentRegistry";
import { initializeGovernanceWorkers } from "./workers/governance.worker";
import { retryPendingGovernanceIndexing, retryPendingTrustAdjustments } from "./orchestrator/coordinator";

/**
 * On startup, recover repos that got stuck mid-processing due to a previous
 * server crash or restart (e.g., Render free tier sleep/wake cycle).
 * Repos stuck in non-terminal states for more than 90 seconds are re-queued.
 */
const recoverStuckRepos = async () => {
  try {
    const STUCK_CUTOFF = new Date(Date.now() - 90 * 1000);

    const stuckRepos = await RepoModel.find({
      status: {
        $in: ["RECEIVED", "CLONING", "SCANNING", "PARSING", "GRAPHING", "INDEXING"],
      },
      updated_at: { $lt: STUCK_CUTOFF },
    }).lean();

    if (stuckRepos.length === 0) {
      logger.info("No stuck repos found on startup");
      return;
    }

    logger.info(`Found ${stuckRepos.length} stuck repo(s) on startup — re-processing`, {
      repo_ids: stuckRepos.map((r) => r._id.toString()),
    });

    for (const repo of stuckRepos) {
      const repoId = repo._id.toString();
      try {
        // Reset to RECEIVED so UI shows clean state
        await RepoModel.findByIdAndUpdate(repoId, { status: "RECEIVED", error_message: undefined });

        processRepository(repo.repo_url, repoId).catch((err: any) => {
          logger.error("Startup recovery processRepository failed", {
            repo_id: repoId,
            error: err?.message,
          });
        });
      } catch (err: any) {
        logger.error("Failed to recover stuck repo", {
          repo_id: repoId,
          error: err?.message,
        });
      }
    }
  } catch (err: any) {
    logger.warn("Startup repo recovery check failed", { error: err?.message });
  }
};

const repairQueryReadyRepos = async () => {
  try {
    const repairableRepos = await RepoModel.find({
      status: "FAILED",
      error_message: "Request failed with status code 500",
      file_count: { $gt: 0 },
      function_count: { $gt: 0 },
    })
      .select("_id")
      .lean();

    if (repairableRepos.length === 0) {
      logger.info("No stale ingest-only failures found on startup");
      return;
    }

    const repoIds = repairableRepos.map((repo) => repo._id.toString());

    await RepoModel.updateMany(
      { _id: { $in: repairableRepos.map((repo) => repo._id) } },
      {
        $set: {
          status: "READY",
          completed_at: new Date(),
        },
        $unset: {
          error_message: 1,
        },
      }
    );

    logger.warn("Repaired repositories that were queryable but marked failed by ingest response", {
      repo_ids: repoIds,
      repaired_count: repoIds.length,
    });
  } catch (err: any) {
    logger.warn("Startup repair for query-ready repos failed", {
      error: err?.message,
    });
  }
};

const startServer = async () => {
  try {
    await initializeQueue();
    await initializeRepoWorker();
    await connectDB();
    await seedAgentRegistry();
    await initializeGovernanceWorkers();
    void retryPendingGovernanceIndexing().catch((error) => {
      logger.warn("Could not retry pending governance indexing", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    void retryPendingTrustAdjustments().catch((error) => {
      logger.warn("Could not retry pending trust adjustments", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    logger.info("Analysis processing mode", {
      queue_mode: queueMode,
      redis_configured: Boolean(ENV.REDIS_URL),
    });

    logger.info("Repo worker health at startup", {
      worker_status: getWorkerStatus(),
      queue_mode: queueMode,
    });

    if (!ENV.REDIS_URL) {
      logger.warn("REDIS_URL is not configured. Production analysis will run in degraded synchronous mode.");
    }

    if (ENV.REDIS_URL && queueMode !== "redis") {
      logger.warn(
        "REDIS_URL is configured but queue mode is degraded. New analyses will fall back to direct background processing."
      );
    }

    // Recover repos stuck from previous server instance
    await recoverStuckRepos();
    await repairQueryReadyRepos();

    app.listen(ENV.PORT, () => {
      logger.info(`Server running on port ${ENV.PORT}`);
    });
  } catch (error) {
    logger.error("Failed to start server");
    process.exit(1);
  }
};

startServer();
