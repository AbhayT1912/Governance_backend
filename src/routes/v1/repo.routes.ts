import { Router } from "express";
import { analyzeRepository, getDashboardSummary, getRepositoryStatus, getUserRepositories } from "../../controllers/repo.controller";
import { getCallGraph } from "../../controllers/graph.controller";
import { getFileGraph } from "../../controllers/fileGraph.controller";
import { getStructure } from "../../controllers/structure.controller";
import { analyzeRateLimiter } from "../../middleware/rateLimit.middleware";
import { askQuestion } from "../../controllers/ai.controller";
import { downloadExecutivePDF, getRepoHistory, getRepoReport } from "../../controllers/report.controller";
import { getImpactAnalysis } from "../../controllers/impactAnalysis.controller";
import { getRiskRanking } from "../../controllers/impactAnalysis.controller";
import { getLayerAnalysis } from "../../controllers/layerDetection.controller";
import { handleGitHubWebhook, getPRAnalysis, getReposPRAnalyses, getPRAnalysisSummary } from "../../controllers/pr.controller";
import { requireAuth } from "../../middleware/auth.middleware";
import { requireRepoOwnership } from "../../middleware/ownership.middleware";
import { deductCredits } from "../../middleware/credit.middleware";
import { deductCreditsOncePerRepoFeature } from "../../middleware/credit.middleware";
import { CREDIT_COSTS } from "../../config/creditCost.config";
import { getMe, patchMe } from "../../controllers/user.controller";
import { validate } from "../../middleware/validate.middleware";
import { patchMeBodySchema } from "../../validators/user.validator";

const router = Router();

router.post(
  "/analyze",
  analyzeRateLimiter,
  requireAuth,
  analyzeRepository,
);
router.get("/me", requireAuth, getMe);
router.patch("/me", requireAuth, validate({ body: patchMeBodySchema }), patchMe);
router.get("/:repoId/status", requireAuth, getRepositoryStatus);

router.get("/:repoId/graph", requireAuth, requireRepoOwnership,deductCreditsOncePerRepoFeature("graph", CREDIT_COSTS.GRAPH), getCallGraph);
router.get("/:repoId/file-graph", requireAuth, requireRepoOwnership, deductCreditsOncePerRepoFeature("file-graph", CREDIT_COSTS.FILE_GRAPH_ANALYSIS), getFileGraph);
router.get("/:repoId/structure", requireAuth, requireRepoOwnership,deductCreditsOncePerRepoFeature("structure", CREDIT_COSTS.STRUCTURE), getStructure);
router.post("/ask", requireAuth, deductCredits(CREDIT_COSTS.ASK_AI), askQuestion);
router.get("/:repoId/report", requireAuth, requireRepoOwnership, deductCreditsOncePerRepoFeature("report", CREDIT_COSTS.REPO_REPORT), getRepoReport);
router.get("/:repoId/impact/:fileId", requireAuth, requireRepoOwnership, deductCredits(CREDIT_COSTS.IMPACT_ANALYSIS), getImpactAnalysis);
router.get("/:repoId/risk-ranking", requireAuth, requireRepoOwnership, deductCreditsOncePerRepoFeature("risk-ranking", CREDIT_COSTS.RISK_RANKING), getRiskRanking);
router.get("/:repoId/layer-analysis", requireAuth, requireRepoOwnership, deductCreditsOncePerRepoFeature("layer-analysis", CREDIT_COSTS.LAYER_ANALYSIS), getLayerAnalysis);
router.get("/:repoId/report/pdf", requireAuth, requireRepoOwnership, deductCredits(CREDIT_COSTS.PDF_DOWNLOAD), downloadExecutivePDF);
router.get("/:repoId/history", requireAuth, requireRepoOwnership, getRepoHistory);
router.get("/my-repos", requireAuth, getUserRepositories);
router.get("/myrepo", requireAuth, getUserRepositories);
router.get("/dashboard-summary", requireAuth, getDashboardSummary);

/* =====================================================
   PR ANALYSIS ROUTES
===================================================== */

// Get all PR analyses for a repository
router.get("/:repoId/pr-analyses", requireAuth, requireRepoOwnership, getReposPRAnalyses);

// Get summary of PR analyses
router.get("/:repoId/pr-analyses/summary", requireAuth, requireRepoOwnership, getPRAnalysisSummary);

// Get specific PR analysis
router.get("/:repoId/pr/:prNumber", requireAuth, requireRepoOwnership, getPRAnalysis);

export default router;
