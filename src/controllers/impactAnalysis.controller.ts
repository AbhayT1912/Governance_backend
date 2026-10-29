import { Request, Response } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler";
import { AppError } from "../utils/AppError";
import {
  analyzeFullImpact,
  rankFilesByRisk,
} from "../services/impactAnalysis.service";
import { buildRepoDependencyGraph } from "../services/repoDependency.service";

export const getImpactAnalysis = asyncHandler(
  async (req: Request, res: Response) => {
    const repoId = Array.isArray(req.params.repoId)
      ? req.params.repoId[0]
      : req.params.repoId;
    const fileId = Array.isArray(req.params.fileId)
      ? req.params.fileId[0]
      : req.params.fileId;

    if (!mongoose.Types.ObjectId.isValid(repoId)) {
      throw new AppError("Invalid repository ID", 400);
    }

    const repoObjectId = new mongoose.Types.ObjectId(repoId);
    const { edges, fileById } = await buildRepoDependencyGraph(repoObjectId);

    if (!fileById.has(fileId)) {
      throw new AppError("File not found in repository graph", 404);
    }

    const impact = analyzeFullImpact(fileId, edges);

    res.status(200).json({
      success: true,
      data: {
        ...impact,
        file: fileById.get(fileId),
      },
    });
  }
);

export const getRiskRanking = asyncHandler(
  async (req: Request, res: Response) => {
    const repoId = Array.isArray(req.params.repoId)
      ? req.params.repoId[0]
      : req.params.repoId;

    if (!mongoose.Types.ObjectId.isValid(repoId)) {
      throw new AppError("Invalid repository ID", 400);
    }

    const repoObjectId = new mongoose.Types.ObjectId(repoId);
    const { edges, fileById } = await buildRepoDependencyGraph(repoObjectId);

    const ranking = rankFilesByRisk(edges)
      .map((entry) => {
        const file = fileById.get(entry.file_id);
        if (!file) return null;

        return {
          ...entry,
          path: file.path,
          language: file.language,
          size: file.size,
        };
      })
      .filter(Boolean);

    res.status(200).json({
      success: true,
      data: ranking,
    });
  }
);
