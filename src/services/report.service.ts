import { RepoModel } from "../models/repo.model";
import { FunctionModel } from "../models/function.model";
import { RepoReportModel } from "../models/repoReport.model";
import { SecurityFindingModel } from "../models/securityFinding.model";
import { FileModel } from "../models/file.model";
import { ImportModel } from "../models/import.model";
import { askAIService } from "./ai.service";
import mongoose from "mongoose";

/* =====================================================
   LAYER ORDER (Heuristic)
===================================================== */

const LAYER_ORDER = [
  "routes",
  "controllers",
  "services",
  "models",
  "utils",
  "components",
];

/* =====================================================
   MAIN REPORT GENERATION
===================================================== */

export const generateRepoReport = async (repoId: string) => {
  const repoObjectId = new mongoose.Types.ObjectId(repoId);
  const repo = await RepoModel.findById(repoId);
  if (!repo) throw new Error("Repo not found");

  const totalFunctions = await FunctionModel.countDocuments({
    repo_id: repoObjectId,
  });

  const deadFunctions = await FunctionModel.countDocuments({
    repo_id: repoObjectId,
    is_dead: true,
  });

  const entryPoints = await FunctionModel.find({
    repo_id: repoObjectId,
    is_entry: true,
  }).select("name");

  /* ================================
     COMPLEXITY METRICS
  ================================= */

  const complexityMetrics = await calculateComplexityMetrics(repoId);

  /* ================================
     FILE GRAPH DATA FOR LAYER + DENSITY
  ================================= */

  const files = await FileModel.find({
    repo_id: repoObjectId,
  }).lean();

  const imports = await ImportModel.find({
    repo_id: repoObjectId,
  }).lean();

  const edges: { from: string; to: string }[] = [];

  const normalizedPathMap = new Map<string, string>();

  for (const file of files) {
    const normalized = file.path
      .replace(/\\/g, "/")
      .replace(/\.ts$|\.js$/, "")
      .toLowerCase();

    normalizedPathMap.set(normalized, file._id.toString());
  }

  for (const imp of imports) {
    const fromFile = imp.file_id?.toString();
    if (!fromFile || !imp.source) continue;

    const normalizedImport = imp.source
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/^\.\.\//, "")
      .replace(/\.ts$|\.js$/, "")
      .toLowerCase();

    const matched = Array.from(normalizedPathMap.entries()).find(([filePath]) =>
      filePath.endsWith(normalizedImport),
    );

    if (!matched) continue;

    edges.push({
      from: fromFile,
      to: matched[1],
    });
  }

  /* ================================
     LAYER ANALYSIS
  ================================= */

  const layerAnalysis = analyzeLayerSeparation(files, edges);

  /* ================================
     DEPENDENCY DENSITY
  ================================= */

  const dependencyDensity = calculateDependencyDensity(files, edges);

  /* ================================
     AI ARCHITECTURE SUMMARY (optional — RAG service may be unavailable)
  ================================= */

  let architectureOverviewText = "";
  try {
    const aiResponse = await askAIService(
      repoId,
      "Provide a high level architecture overview of this repository.",
    );
    architectureOverviewText = aiResponse?.answer || "";
  } catch (aiErr: any) {
    const { logger } = require("../config/logger");
    logger.warn("AI architecture summary skipped (RAG service unavailable)", {
      repo_id: repoId,
      error: aiErr?.message,
    });
  }

  // 🔥 NEW — INVESTOR SUMMARY
  const investorSummary = buildInvestorSummary({
    totalFunctions,
    deadFunctions,
    complexityMetrics,
    layerAnalysis,
    dependencyDensity,
  });

  const architectureHealthScore = calculateArchitectureHealthScore({
    layerAnalysis,
    complexityMetrics,
    deadFunctions,
    totalFunctions,
    dependencyDensity,
  });


  // 🔥 NEW — RISK EXPOSURE
  const riskExposure = calculateRiskExposure({
    complexityMetrics,
    layerAnalysis,
    dependencyDensity,
    deadFunctions,
    totalFunctions,
  });

  // 🔥 NEW — ENGINEERING MATURITY
  const maturity = calculateEngineeringMaturity({
    architecture_health_score: architectureHealthScore,
    layer_analysis: layerAnalysis,
    complexity_metrics: complexityMetrics,
    dead_functions_count: deadFunctions,
    total_functions: totalFunctions,
  });

  // 🔥 NEW — VERSION & SCORE DELTA
  const previousReport = await RepoReportModel.findOne({ repo_id: repoObjectId, }).sort({ created_at: -1 }).lean();

  const version = previousReport ? previousReport.version + 1 : 1;
  let scoreDelta = {
  architecture: 0,
  layer: 0,
  complexity: 0,
  dead_functions: 0,
};

if (previousReport) {
  scoreDelta = {
    architecture:
      architectureHealthScore -
      (previousReport.architecture_health_score ?? 0),

    layer:
      layerAnalysis.layer_health_score -
      (previousReport.layer_analysis?.layer_health_score ?? 0),

    complexity:
      Number(
        (
          complexityMetrics.average_complexity -
          (previousReport.complexity_metrics?.average_complexity ?? 0)
        ).toFixed(2)
      ),

    dead_functions:
      deadFunctions -
      (previousReport.dead_functions_count ?? 0),
  };
}

  /* ================================
     EXTRACT MODULES (Dynamic)
  ================================= */
  
  const allFunctions = await FunctionModel.find({
    repo_id: repoObjectId,
  }).lean();

  const modules = extractModulesFromFiles(files, allFunctions);

  // Fetch security findings
  const securityFindings = await SecurityFindingModel.find({
    repo_id: repoObjectId,
  }).lean();

  const securitySummary = {
    total_findings: securityFindings.length,
    by_type: {
      secrets: securityFindings.filter(f => f.type === "SECRET").length,
      sast: securityFindings.filter(f => f.type === "BAD_PRACTICE").length,
      dependencies: securityFindings.filter(f => f.type === "CVE").length,
      malicious: securityFindings.filter(f => f.type === "MALICIOUS_PATTERN").length,
      licenses: securityFindings.filter(f => f.type === "LICENSE_ISSUE").length,
    },
    by_severity: {
      critical: securityFindings.filter(f => f.severity === "CRITICAL").length,
      high: securityFindings.filter(f => f.severity === "HIGH").length,
      medium: securityFindings.filter(f => f.severity === "MEDIUM").length,
      low: securityFindings.filter(f => f.severity === "LOW").length,
    },
  };

  // Calculate security trust score
  let securityTrustScore = 100;
  const severityWeights = { CRITICAL: 15, HIGH: 10, MEDIUM: 5, LOW: 1 };
  for (const finding of securityFindings) {
    securityTrustScore -= severityWeights[finding.severity as keyof typeof severityWeights] || 0;
  }
  securityTrustScore = Math.max(0, Math.min(100, securityTrustScore));

  const report = await RepoReportModel.create({
    repo_id: repoId,
    overview: architectureOverviewText,
    architecture_summary: architectureOverviewText,
    entry_points: entryPoints.map((e) => e.name),
    dead_functions_count: deadFunctions,
    total_files: repo.file_count,
    total_functions: totalFunctions,

    // 🔥 NEW DATA
    complexity_metrics: complexityMetrics,
    layer_analysis: layerAnalysis,
    dependency_density: dependencyDensity,
    investor_summary: investorSummary,
    risk_exposure: riskExposure,
    maturity: maturity,
    modules: modules,
    version,
    score_delta: scoreDelta,
    previous_version_id: previousReport?._id ?? null,
    architecture_health_score: architectureHealthScore,

    // Security findings
    security_trust_score: securityTrustScore,
    security_findings_count: securityFindings.length,
    security_summary: securitySummary,
  });

  return report;
};

/* =====================================================
   COMPLEXITY METRICS
===================================================== */

export async function calculateComplexityMetrics(repoId: string) {
  const repoObjectId = new mongoose.Types.ObjectId(repoId);

  const functions = await FunctionModel.find({
    repo_id: repoObjectId,
  }).lean();

  if (!functions.length) {
    return {
      total_functions: 0,
      average_complexity: 0,
      max_complexity: 0,
      high_complexity_functions: [],
    };
  }

  const total = functions.length;
  const complexities = functions.map((f) => f.complexity ?? 1);

  const sum = complexities.reduce((a, b) => a + b, 0);
  const max = Math.max(...complexities);
  const avg = sum / total;

  const high = functions
    .filter((f) => (f.complexity ?? 1) >= 10)
    .map((f) => ({
      function_id: f._id,
      name: f.name,
      complexity: f.complexity,
    }));

  return {
    total_functions: total,
    average_complexity: Number(avg.toFixed(2)),
    max_complexity: max,
    high_complexity_functions: high,
  };
}

/* =====================================================
   MODULE EXTRACTION ENGINE
===================================================== */

function extractModulesFromFiles(
  files: any[],
  functions: any[]
): Array<{
  name: string;
  files_count: number;
  functions_count: number;
  complexity: 'low' | 'medium' | 'high';
  type?: string;
}> {
  // Group files by top-level directory (e.g., src/core, src/components)
  const moduleMap = new Map<string, { files: Set<string>; functions: any[] }>();

  for (const file of files) {
    const path = file.path.replace(/\\/g, "/").toLowerCase();
    const pathParts = path.split("/");

    // Extract module name (e.g., "src/core" from "src/core/index.ts")
    let moduleName = pathParts.length > 1 ? `${pathParts[0]}/${pathParts[1]}` : pathParts[0];

    if (!moduleMap.has(moduleName)) {
      moduleMap.set(moduleName, { files: new Set(), functions: [] });
    }

    moduleMap.get(moduleName)!.files.add(file._id.toString());
  }

  for (const fn of functions) {
    const fileId = fn.file_id?.toString();
    const file = files.find((f) => f._id.toString() === fileId);

    if (!file) continue;

    const path = file.path.replace(/\\/g, "/").toLowerCase();
    const pathParts = path.split("/");
    const moduleName = pathParts.length > 1 ? `${pathParts[0]}/${pathParts[1]}` : pathParts[0];

    if (moduleMap.has(moduleName)) {
      moduleMap.get(moduleName)!.functions.push(fn);
    }
  }

  // Convert to sorted array
  const modules = Array.from(moduleMap.entries())
    .map(([name, data]) => {
      const avgComplexity = data.functions.length
        ? data.functions.reduce((sum: number, f: any) => sum + (f.complexity ?? 1), 0) /
          data.functions.length
        : 0;

      const complexityLevel: 'low' | 'medium' | 'high' =
        avgComplexity >= 10 ? 'high' : avgComplexity >= 5 ? 'medium' : 'low';

      return {
        name,
        files_count: data.files.size,
        functions_count: data.functions.length,
        complexity: complexityLevel,
        type: 'module',
      };
    })
    .sort((a, b) => b.functions_count - a.functions_count)
    .slice(0, 10); // Top 10 modules

  return modules;
}

/* =====================================================
   LAYER SEPARATION ENGINE
===================================================== */

function inferLayerFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();

  const match = LAYER_ORDER.find((layer) => normalized.includes(`/${layer}/`));

  return match ?? "unknown";
}

export function analyzeLayerSeparation(
  files: any[],
  edges: { from: string; to: string }[],
) {
  const fileLayerMap = new Map<string, string>();

  for (const file of files) {
    const layer = inferLayerFromPath(file.path);
    fileLayerMap.set(file._id.toString(), layer);
  }

  const layerMatrix: Record<string, Record<string, number>> = {};
  const violations: any[] = [];

  for (const { from, to } of edges) {
    const fromLayer = fileLayerMap.get(from);
    const toLayer = fileLayerMap.get(to);

    if (!fromLayer || !toLayer) continue;

    if (!layerMatrix[fromLayer]) {
      layerMatrix[fromLayer] = {};
    }

    if (!layerMatrix[fromLayer][toLayer]) {
      layerMatrix[fromLayer][toLayer] = 0;
    }

    layerMatrix[fromLayer][toLayer]++;

    const fromIndex = LAYER_ORDER.indexOf(fromLayer);
    const toIndex = LAYER_ORDER.indexOf(toLayer);

    if (fromIndex !== -1 && toIndex !== -1 && fromIndex > toIndex) {
      violations.push({
        from_layer: fromLayer,
        to_layer: toLayer,
        severity: "upward_dependency",
      });
    }
  }

  const totalViolations = violations.length;

  const layerHealthScore = Math.max(0, 100 - totalViolations * 5);

  return {
    layer_matrix: layerMatrix,
    violations,
    total_violations: totalViolations,
    layer_health_score: layerHealthScore,
  };
}

/* =====================================================
   DEPENDENCY DENSITY ENGINE
===================================================== */

function calculateDependencyDensity(
  files: any[],
  edges: { from: string; to: string }[],
) {
  const incoming: Record<string, number> = {};
  const outgoing: Record<string, number> = {};

  for (const file of files) {
    const id = file._id.toString();
    incoming[id] = 0;
    outgoing[id] = 0;
  }

  for (const edge of edges) {
    outgoing[edge.from]++;
    incoming[edge.to]++;
  }

  const fileDensity = files.map((file) => {
    const id = file._id.toString();

    return {
      file_id: id,
      path: file.path,
      outgoing_dependencies: outgoing[id],
      incoming_dependencies: incoming[id],
      density_score: outgoing[id] + incoming[id],
    };
  });

  const repoDensity = files.length > 0 ? edges.length / files.length : 0;

  return {
    repo_density: Number(repoDensity.toFixed(2)),
    file_density: fileDensity,
  };
}

function calculateEngineeringMaturity(report: any) {
  const arch = report.architecture_health_score ?? 80;
  const layer = report.layer_analysis?.layer_health_score ?? 80;

  const complexity = report.complexity_metrics?.average_complexity ?? 5;

  const deadRatio = report.dead_functions_count / report.total_functions;

  let score =
    arch * 0.35 +
    layer * 0.25 +
    (100 - complexity * 5) * 0.2 +
    (100 - deadRatio * 100) * 0.2;

  score = Math.max(0, Math.min(100, score));

  let grade = "D";
  if (score >= 90) grade = "A";
  else if (score >= 75) grade = "B";
  else if (score >= 60) grade = "C";

  return {
    maturity_score: Math.round(score),
    maturity_grade: grade,
  };
}

function buildInvestorSummary(data: any) {
  const riskLevel =
    data.deadFunctions > data.totalFunctions * 0.3
      ? "High Structural Risk"
      : data.complexityMetrics.average_complexity > 8
      ? "Moderate Maintainability Risk"
      : "Stable Engineering Base";

  return {
    risk_level: riskLevel,
    total_functions: data.totalFunctions,
    dead_functions: data.deadFunctions,
    avg_complexity: data.complexityMetrics.average_complexity,
    total_layer_violations: data.layerAnalysis.total_violations,
    repo_density: data.dependencyDensity.repo_density,
    strategic_note:
      "Engineering health impacts scalability, onboarding speed, and long-term refactor cost.",
  };
}

function calculateRiskExposure(data: any) {
  const complexityRisk =
    data.complexityMetrics.average_complexity * 10;

  const deadRatio =
    data.deadFunctions / Math.max(1, data.totalFunctions);

  const deadRisk = deadRatio * 100;

  const layerRisk =
    data.layerAnalysis.total_violations * 5;

  const densityRisk =
    data.dependencyDensity.repo_density * 10;

  return {
    complexity_risk_score: Math.round(complexityRisk),
    dead_code_risk_score: Math.round(deadRisk),
    layer_violation_risk_score: Math.round(layerRisk),
    dependency_density_risk_score: Math.round(densityRisk),
  };
}

function calculateArchitectureHealthScore(data: any) {
  const layerPenalty = data.layerAnalysis.total_violations * 3;

  const complexityPenalty =
    data.complexityMetrics.average_complexity * 2;

  const deadRatio =
    data.deadFunctions / Math.max(1, data.totalFunctions);

  const deadPenalty = deadRatio * 40;

  const densityPenalty =
    data.dependencyDensity.repo_density * 5;

  let score =
    100 -
    layerPenalty -
    complexityPenalty -
    deadPenalty -
    densityPenalty;

  score = Math.max(0, Math.min(100, score));

  return Math.round(score);
}
