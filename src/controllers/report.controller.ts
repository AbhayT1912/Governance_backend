import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { RepoReportModel } from "../models/repoReport.model";
import { generateExecutivePDF } from "../services/pdf.service";
import { UsageModel } from "../models/usage.model";
import mongoose from "mongoose";
import { detectRegression, calculateVelocity, calculateVolatilityScore, predictDegradation, calculateStabilityIndex } from "../services/trend.service";
import { RepoModel } from "../models/repo.model";
import { ImportModel } from "../models/import.model";
import { FunctionModel } from "../models/function.model";
import { setNoStoreHeaders } from "../utils/cacheControl.util";

/* =====================================================
   TYPE FOR HISTORY SNAPSHOT (Fixes Red Underlines)
===================================================== */

interface ReportHistorySnapshot {
  version: number;
  architecture_health_score: number;
  layer_analysis?: {
    layer_health_score?: number;
  };
  complexity_metrics?: {
    average_complexity?: number;
  };
  dead_functions_count: number;
  maturity?: {
    maturity_score?: number;
  };
  created_at: Date;
}

/* =====================================================
   DOWNLOAD EXECUTIVE PDF
===================================================== */

export const downloadExecutivePDF = async (req: any, res: any, next: any) => {
  try {
    const { repoId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(repoId as string)) {
      return res.status(400).json({
        success: false,
        message: "Invalid repository ID",
      });
    }

    const reportExists = await RepoReportModel.exists({
      repo_id: new mongoose.Types.ObjectId(repoId as string),
    });
    if (!reportExists) {
      return res.status(404).json({
        success: false,
        message: "Report not generated yet",
      });
    }

    await UsageModel.updateOne(
      { user_id: req.auth.userId },
      { $inc: { pdf_downloads: 1 } },
      { upsert: true }
    );

    await generateExecutivePDF(repoId as string, res);
  } catch (error) {
    next(error);
  }
};

/* =====================================================
   GET SINGLE REPORT
===================================================== */

export const getRepoReport = asyncHandler(async (req: Request, res: Response) => {
  const { repoId } = req.params;
  setNoStoreHeaders(res);

  if (!mongoose.Types.ObjectId.isValid(repoId as string)) {
    return res.status(400).json({
      success: false,
      message: "Invalid repository ID",
    });
  }

  const repoObjectId = new mongoose.Types.ObjectId(repoId as string);
  const report = await RepoReportModel.findOne({ repo_id: repoObjectId });

  if (!report) {
    const repo = await RepoModel.findById(repoId).select("status").lean();
    return res.status(200).json({
      success: true,
      data: null,
      status: repo?.status ?? "PROCESSING",
      message: "Report not generated yet",
    });
  }

  const reportData: any =
    typeof (report as any).toObject === "function"
      ? (report as any).toObject()
      : report;

  if (typeof reportData.total_dependencies !== "number") {
    const densityDependencies = Array.isArray(reportData?.dependency_density?.file_density)
      ? reportData.dependency_density.file_density.reduce(
        (sum: number, file: any) =>
          sum + Number(file?.outgoing_dependencies ?? 0),
        0
      )
      : 0;

    reportData.total_dependencies =
      densityDependencies > 0
        ? densityDependencies
        : await ImportModel.countDocuments({ repo_id: repoObjectId });
  }

  if (typeof reportData.total_lines_of_code !== "number") {
    const locAgg = await FunctionModel.aggregate([
      { $match: { repo_id: repoObjectId } },
      {
        $group: {
          _id: "$file_id",
          max_end_line: { $max: "$end_line" },
        },
      },
      {
        $group: {
          _id: null,
          total_lines_of_code: { $sum: "$max_end_line" },
        },
      },
    ]);

    reportData.total_lines_of_code = Number(locAgg?.[0]?.total_lines_of_code ?? 0);
  }

  res.status(200).json({
    success: true,
    data: reportData,
  });
});

/* =====================================================
   GET REPO HISTORY (Phase 5)
===================================================== */

export const getRepoHistory = async (req: Request, res: Response) => {
  const { repoId } = req.params;
  setNoStoreHeaders(res);

  const repoObjectId = new mongoose.Types.ObjectId(repoId as string);

  const reports = await RepoReportModel.find({
    repo_id: repoObjectId,
  })
    .sort({ version: 1 })
    .select(
      "version architecture_health_score layer_analysis complexity_metrics dead_functions_count maturity created_at"
    )
    .lean<ReportHistorySnapshot[]>(); // ✅ Proper typing

  const trend = reports.map((r) => ({
    version: r.version,
    architecture_score: r.architecture_health_score,
    layer_score: r.layer_analysis?.layer_health_score ?? 0,
    avg_complexity: r.complexity_metrics?.average_complexity ?? 0,
    dead_functions: r.dead_functions_count,
    maturity_score: r.maturity?.maturity_score ?? 0,
    created_at: r.created_at,
  }));

  // 🔥 Phase 5 Intelligence
  const regressionAlert = detectRegression(reports);
  const engineeringVelocity = calculateVelocity(reports);
  const stabilityIndex = calculateStabilityIndex(reports);
  const volatilityScore = calculateVolatilityScore(reports);
  const degradationPrediction = predictDegradation(reports);


  res.json({
    success: true,
    data: {
      trend,
      regression_alert: regressionAlert,
      engineering_velocity: engineeringVelocity,
      stability_index: stabilityIndex,
      volatility_score: volatilityScore,
      degradation_prediction: degradationPrediction,
    },
  });
};
