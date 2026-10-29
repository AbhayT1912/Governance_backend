import { RepoModel } from "../models/repo.model";
import { cloneRepository } from "./git.service";
import { enforceRepoSizeLimit } from "../utils/repoSize.util";
import { cleanupRepo } from "../utils/repoCleanup";
import { getRepoPath } from "../utils/repoPath.util";
import { scanRepository } from "./scanner.service";
import { parseRepository } from "./parser.service";
import { logger } from "../config/logger";
import { ingestRepoToRAG } from "./rag.service";
import { generateRepoReport } from "./report.service";
import { performSecurityAnalysis } from "./security.service";

const logStageDuration = (
  repoId: string,
  stage: string,
  startedAt: number,
  extra: Record<string, unknown> = {}
) => {
  logger.info("Repository stage completed", {
    repo_id: repoId,
    stage,
    duration_ms: Date.now() - startedAt,
    ...extra,
  });
};

export const processRepository = async (repoUrl: string, repoId: string) => {
  const repoPath = getRepoPath(repoId);
  const pipelineStartedAt = Date.now();

  try {
    logger.info("Repository processing started", {
      repo_id: repoId,
      repo_url: repoUrl,
    });

    await RepoModel.findByIdAndUpdate(repoId, {
      status: "CLONING",
      started_at: new Date(),
    });

    let stageStartedAt = Date.now();
    await cloneRepository(repoUrl, repoPath, repoId);
    logStageDuration(repoId, "clone", stageStartedAt);

    await RepoModel.findByIdAndUpdate(repoId, {
      status: "SCANNING",
    });

    stageStartedAt = Date.now();
    enforceRepoSizeLimit(repoPath);
    const totalFiles = await scanRepository(repoPath, repoId);
    logStageDuration(repoId, "scan", stageStartedAt, {
      total_files: totalFiles,
    });

    await RepoModel.findByIdAndUpdate(repoId, {
      file_count: totalFiles,
    });

    await RepoModel.findByIdAndUpdate(repoId, {
      status: "PARSING",
    });

    stageStartedAt = Date.now();
    const totalFunctions = await parseRepository(repoId);
    logStageDuration(repoId, "parse", stageStartedAt, {
      total_functions: totalFunctions,
    });

    await RepoModel.findByIdAndUpdate(repoId, {
      function_count: totalFunctions,
    });

    await RepoModel.findByIdAndUpdate(repoId, {
      status: "GRAPHING",
    });

    stageStartedAt = Date.now();
    const { buildCallGraph } = await import("./graph.service");
    await buildCallGraph(repoId);
    logStageDuration(repoId, "graph", stageStartedAt);

    stageStartedAt = Date.now();
    try {
      const { findings, trustScore } = await performSecurityAnalysis(repoPath, repoId);
      const criticalCount = findings.filter((f) => f.severity === "CRITICAL").length;

      await RepoModel.findByIdAndUpdate(repoId, {
        security_score: trustScore,
        security_findings_count: findings.length,
        critical_vulnerabilities: criticalCount,
      });

      logger.info("Security analysis completed", {
        repo_id: repoId,
        trust_score: trustScore,
        findings: findings.length,
      });

      logStageDuration(repoId, "security", stageStartedAt, {
        findings: findings.length,
        trust_score: trustScore,
      });
    } catch (secError: any) {
      logger.warn("Security analysis failed, continuing with report generation", {
        repo_id: repoId,
        error: secError?.message,
        duration_ms: Date.now() - stageStartedAt,
      });
    }

    stageStartedAt = Date.now();
    await generateRepoReport(repoId);
    logStageDuration(repoId, "report_generation", stageStartedAt);

    await RepoModel.findByIdAndUpdate(repoId, {
      status: "INDEXING",
    });

    stageStartedAt = Date.now();
    let ragIngestionError: string | undefined;
    try {
      await ingestRepoToRAG(repoPath, repoId, repoUrl);
      logStageDuration(repoId, "rag_ingestion", stageStartedAt);
    } catch (error: any) {
      ragIngestionError = error?.message || "RAG ingestion failed";
      logger.warn("RAG ingestion failed after repository processing completed", {
        repo_id: repoId,
        error: ragIngestionError,
        duration_ms: Date.now() - stageStartedAt,
      });
    }

    await RepoModel.findByIdAndUpdate(repoId, {
      status: "READY",
      completed_at: new Date(),
      error_message: ragIngestionError,
    });

    logger.info("Repository ready", {
      repo_id: repoId,
      total_duration_ms: Date.now() - pipelineStartedAt,
    });
  } catch (error: any) {
    await RepoModel.findByIdAndUpdate(repoId, {
      status: "FAILED",
      error_message: error.message,
      completed_at: new Date(),
    });

    await cleanupRepo(repoPath, repoId);

    throw error;
  }
};
