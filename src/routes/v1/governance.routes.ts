import { Router } from "express";
import { requireAuth } from "../../middleware/auth.middleware";
import {
  approveGovernance,
  createGovernanceJob,
  downloadGovernanceReport,
  getGovernanceAgents,
  getGovernanceAudit,
  getGovernanceDecision,
  getGovernanceFindings,
  getGovernanceJob,
  getGovernancePolicies,
  getGovernanceViolations,
  updateGovernancePolicy,
  verifyGovernanceAudit,
} from "../../controllers/governance.controller";

const router = Router();
router.use(requireAuth);

router.post("/jobs", createGovernanceJob);
router.get("/jobs/:jobId", getGovernanceJob);
router.get("/jobs/:jobId/findings", getGovernanceFindings);
router.get("/jobs/:jobId/decision", getGovernanceDecision);
router.get("/jobs/:jobId/report.pdf", downloadGovernanceReport);
router.get("/agents", getGovernanceAgents);
router.get("/policies", getGovernancePolicies);
router.put("/policies/:id", updateGovernancePolicy);
router.get("/violations", getGovernanceViolations);
router.get("/audit/verify", verifyGovernanceAudit);
router.get("/audit", getGovernanceAudit);
router.post("/decisions/:id/approve", approveGovernance);

export default router;
