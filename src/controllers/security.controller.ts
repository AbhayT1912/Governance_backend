import { Request, Response } from "express";
import mongoose from "mongoose";
import { SecurityFindingModel } from "../models/securityFinding.model";
import { RepoModel } from "../models/repo.model";
import { asyncHandler } from "../utils/asyncHandler";
import { successResponse } from "../utils/response.util";
import { AppError } from "../utils/AppError";
import { logger } from "../config/logger";

/**
 * Get security findings for a repository
 */
export const getSecurityFindings = asyncHandler(async (req: Request, res: Response) => {
  const { repoId } = req.params;
  const { severity, type, status, limit = 50, skip = 0 } = req.query;
  const userId = (req as any).auth?.userId;

  if (!userId) {
    throw new AppError("Unauthorized", 401);
  }

  // Verify repo exists and user owns it
  const repo = await RepoModel.findById(repoId as string);
  if (!repo) {
    throw new AppError("Repository not found", 404);
  }

  if (repo.owner_id !== userId) {
    throw new AppError("Access denied", 403);
  }

  // Build query filter
  const filter: any = { repo_id: new mongoose.Types.ObjectId(repoId as string) };

  if (severity) {
    filter.severity = severity;
  }
  if (type) {
    filter.type = type;
  }
  if (status) {
    filter.status = status;
  }

  // Query findings
  const findings = await SecurityFindingModel.find(filter)
    .limit(parseInt(limit as string) || 50)
    .skip(parseInt(skip as string) || 0)
    .sort({ severity: -1, detected_at: -1 })
    .lean();

  const total = await SecurityFindingModel.countDocuments(filter);

  successResponse(res, {
    findings,
    pagination: {
      total,
      limit: parseInt(limit as string) || 50,
      skip: parseInt(skip as string) || 0,
      hasMore: (parseInt(skip as string) || 0) + (parseInt(limit as string) || 50) < total,
    },
  });
});

/**
 * Get security summary for a repository
 */
export const getSecuritySummary = asyncHandler(async (req: Request, res: Response) => {
  const { repoId } = req.params;
  const userId = (req as any).auth?.userId;

  if (!userId) throw new AppError("Unauthorized", 401);

  const repo = await RepoModel.findById(repoId as string);
  if (!repo) throw new AppError("Repository not found", 404);
  if (repo.owner_id !== userId) throw new AppError("Access denied", 403);

  const findings = await SecurityFindingModel.find({
    repo_id: new mongoose.Types.ObjectId(repoId as string),
  }).lean();

  const summary = {
    total_findings: findings.length,
    trust_score: repo.security_score || 100,
    critical_vulnerabilities: repo.critical_vulnerabilities || 0,
    by_type: {
      secrets: findings.filter(f => f.type === "SECRET").length,
      sast: findings.filter(f => f.type === "BAD_PRACTICE").length,
      dependencies: findings.filter(f => f.type === "CVE").length,
      malicious: findings.filter(f => f.type === "MALICIOUS_PATTERN").length,
      licenses: findings.filter(f => f.type === "LICENSE_ISSUE").length,
    },
    by_severity: {
      critical: findings.filter(f => f.severity === "CRITICAL").length,
      high: findings.filter(f => f.severity === "HIGH").length,
      medium: findings.filter(f => f.severity === "MEDIUM").length,
      low: findings.filter(f => f.severity === "LOW").length,
    },
    top_findings: findings
      .sort((a, b) => {
        const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
        return severityOrder[a.severity as keyof typeof severityOrder] -
          severityOrder[b.severity as keyof typeof severityOrder];
      })
      .slice(0, 10)
      .map(f => ({
        title: f.title,
        severity: f.severity,
        type: f.type,
        file_path: f.file_path,
      })),
  };

  successResponse(res, summary);
});

/**
 * Get a specific security finding
 */
export const getSecurityFinding = asyncHandler(async (req: Request, res: Response) => {
  const { findingId } = req.params;
  const userId = (req as any).auth?.userId;

  if (!userId) throw new AppError("Unauthorized", 401);

  const finding = await SecurityFindingModel.findById(findingId).lean();
  if (!finding) {
    throw new AppError("Finding not found", 404);
  }

  // Verify user owns the repo
  const repo = await RepoModel.findById(finding.repo_id);
  if (!repo || repo.owner_id !== userId) {
    throw new AppError("Access denied", 403);
  }

  successResponse(res, finding);
});

/**
 * Update finding status (mark as resolved, acknowledged, etc.)
 */
export const updateFindingStatus = asyncHandler(async (req: Request, res: Response) => {
  const { findingId } = req.params;
  const { status } = req.body;
  const userId = (req as any).auth?.userId;

  if (!userId) throw new AppError("Unauthorized", 401);

  if (!["OPEN", "ACKNOWLEDGED", "MITIGATED", "RESOLVED"].includes(status)) {
    throw new AppError("Invalid status", 400);
  }

  const finding = await SecurityFindingModel.findById(findingId);
  if (!finding) {
    throw new AppError("Finding not found", 404);
  }

  // Verify user owns the repo
  const repo = await RepoModel.findById(finding.repo_id);
  if (!repo || repo.owner_id !== userId) {
    throw new AppError("Access denied", 403);
  }

  finding.status = status;
  if (status === "RESOLVED") {
    finding.resolved_at = new Date();
  }

  await finding.save();

  successResponse(res, {
    message: "Finding status updated",
    finding,
  });
});

/**
 * Get security findings by file
 */
export const getFileSecurityIssues = asyncHandler(async (req: Request, res: Response) => {
  const { repoId, filePath } = req.params;
  const userId = (req as any).auth?.userId;

  if (!userId) throw new AppError("Unauthorized", 401);

  const repo = await RepoModel.findById(repoId);
  if (!repo || repo.owner_id !== userId) {
    throw new AppError("Access denied", 403);
  }

  const findings = await SecurityFindingModel.find({
    repo_id: new mongoose.Types.ObjectId(repoId as string),
    file_path: filePath as string,
  })
    .sort({ line_number: 1 })
    .lean();

  successResponse(res, { file_path: filePath, findings });
});

/**
 * Get critical vulnerabilities only
 */
export const getCriticalVulnerabilities = asyncHandler(async (req: Request, res: Response) => {
  const { repoId } = req.params;
  const userId = (req as any).auth?.userId;

  if (!userId) throw new AppError("Unauthorized", 401);

  const repo = await RepoModel.findById(repoId);
  if (!repo || repo.owner_id !== userId) {
    throw new AppError("Access denied", 403);
  }

  const findings = await SecurityFindingModel.find({
    repo_id: new mongoose.Types.ObjectId(repoId as string),
    severity: { $in: ["CRITICAL", "HIGH"] },
  })
    .sort({ severity: -1, detected_at: -1 })
    .lean();

  successResponse(res, {
    count: findings.length,
    findings,
  });
});

/**
 * Export security report as JSON
 */
export const exportSecurityReport = asyncHandler(async (req: Request, res: Response) => {
  const { repoId } = req.params;
  const userId = (req as any).auth?.userId;

  if (!userId) throw new AppError("Unauthorized", 401);

  const repo = await RepoModel.findById(repoId);
  if (!repo || repo.owner_id !== userId) {
    throw new AppError("Access denied", 403);
  }

  const findings = await SecurityFindingModel.find({
    repo_id: new mongoose.Types.ObjectId(repoId as string),
  }).lean();

  const report = {
    repository: {
      id: repoId,
      url: repo.repo_url,
      analyzed_at: new Date(),
    },
    summary: {
      total_findings: findings.length,
      trust_score: repo.security_score || 100,
      critical_vulnerabilities: repo.critical_vulnerabilities || 0,
    },
    findings: findings.map(f => ({
      type: f.type,
      severity: f.severity,
      title: f.title,
      description: f.description,
      file_path: f.file_path,
      line_number: f.line_number,
      impact: f.impact,
      remediation: f.remediation,
      cve_id: f.cve_id,
      affected_package: f.affected_package,
      detected_at: f.detected_at,
    })),
  };

  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="security-report-${repoId}-${Date.now()}.json"`
  );
  res.send(JSON.stringify(report, null, 2));
});
