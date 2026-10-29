import { Router, Request, Response } from "express";
import {
  getSecurityFindings,
  getSecuritySummary,
  getSecurityFinding,
  updateFindingStatus,
  getFileSecurityIssues,
  getCriticalVulnerabilities,
  exportSecurityReport,
} from "../../controllers/security.controller";
import { requireAuth } from "../../middleware/auth.middleware";

const router = Router();

// All security routes require authentication
router.use(requireAuth);

/**
 * @route   GET /api/v1/repos/:repoId/security/summary
 * @desc    Get security summary for a repository
 * @access  Private
 */
router.get("/:repoId/security/summary", getSecuritySummary);

/**
 * @route   GET /api/v1/repos/:repoId/security/findings
 * @desc    Get security findings for a repository with filtering
 * @access  Private
 * @query   severity, type, status, limit, skip
 */
router.get("/:repoId/security/findings", getSecurityFindings);

/**
 * @route   GET /api/v1/repos/:repoId/security/critical
 * @desc    Get critical and high severity vulnerabilities
 * @access  Private
 */
router.get("/:repoId/security/critical", getCriticalVulnerabilities);

/**
 * @route   GET /api/v1/repos/:repoId/security/findings/:findingId
 * @desc    Get a specific security finding
 * @access  Private
 */
router.get("/:repoId/security/findings/:findingId", getSecurityFinding);

/**
 * @route   GET /api/v1/repos/:repoId/security/file/:filePath
 * @desc    Get security issues for a specific file
 * @access  Private
 */
router.get("/:repoId/security/file/:filePath", getFileSecurityIssues);

/**
 * @route   PATCH /api/v1/repos/:repoId/security/findings/:findingId/status
 * @desc    Update finding status
 * @access  Private
 * @body    { status: "OPEN|ACKNOWLEDGED|MITIGATED|RESOLVED" }
 */
router.patch("/:repoId/security/findings/:findingId/status", updateFindingStatus);

/**
 * @route   GET /api/v1/repos/:repoId/security/export
 * @desc    Export security report as JSON
 * @access  Private
 */
router.get("/:repoId/security/export", exportSecurityReport);

export default router;
