import { Request, Response } from "express";
import mongoose from "mongoose";
import { FileModel } from "../models/file.model";
import { ImportModel } from "../models/import.model";
import { asyncHandler } from "../utils/asyncHandler";
import { AppError } from "../utils/AppError";
import { analyzeLayers } from "../services/layerDetection.service";

export const getLayerAnalysis = asyncHandler(
  async (req: Request, res: Response) => {
    const { repoId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(repoId as string)) {
      throw new AppError("Invalid repository ID", 400);
    }

    const files = await FileModel.find({
      repo_id: repoId,
    }).lean();

    const imports = await ImportModel.find({
      repo_id: repoId,
    }).lean();

    const edges = imports
      .filter(i => i.file_id && i.source)
      .map(i => ({
        from: i.file_id.toString(),
        to: i.source,
      }));

    const fileNodes = files.map(f => ({
      id: f._id.toString(),
      path: f.path,
    }));

    const analysis = analyzeLayers(fileNodes, edges);

    res.status(200).json({
      success: true,
      data: analysis,
    });
  }
);