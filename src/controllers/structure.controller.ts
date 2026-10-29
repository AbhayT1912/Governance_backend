import { Request, Response } from "express";
import mongoose from "mongoose";
import { FileModel } from "../models/file.model";
import { FunctionModel } from "../models/function.model";
import { ImportModel } from "../models/import.model";
import { asyncHandler } from "../utils/asyncHandler";
import { AppError } from "../utils/AppError";

export const getStructure = asyncHandler(
  async (req: Request, res: Response) => {
    const { repoId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(repoId as string)) {
      throw new AppError("Invalid repository ID", 400);
    }

    const repoObjectId = new mongoose.Types.ObjectId(repoId as string);

    // 🔹 Fetch all required data in parallel
    const [files, functions, imports] = await Promise.all([
      FileModel.find({ repo_id: repoObjectId }).lean(),
      FunctionModel.find({ repo_id: repoObjectId }).lean(),
      ImportModel.find({ repo_id: repoObjectId }).lean(),
    ]);

    // ---------------------------
    // 🔹 FILES
    // ---------------------------
    const fileData = files
      .map((file) => ({
        id: file._id.toString(),
        path: file.path,
        language: file.language,
        size: file.size,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));

    // ---------------------------
    // 🔹 FUNCTIONS
    // ---------------------------
    const functionData = functions
      .map((fn) => ({
        id: fn._id.toString(),
        name: fn.name,
        file_id: fn.file_id?.toString() || null,
        start_line: fn.start_line,
        end_line: fn.end_line,
      }))
      .sort((a, b) => {
        if (a.name === b.name) {
          return a.id.localeCompare(b.id);
        }
        return a.name.localeCompare(b.name);
      });

    // ---------------------------
    // 🔹 IMPORTS
    // ---------------------------
    const importData = imports
      .map((imp) => ({
        id: imp._id.toString(),
        file_id: imp.file_id?.toString() || null,
        source: imp.source,
        specifiers: imp.specifiers ?? [],
      }))
      .sort((a, b) => {
        if (a.source === b.source) {
          return a.id.localeCompare(b.id);
        }
        return a.source.localeCompare(b.source);
      });

    return res.status(200).json({
      success: true,
      data: {
        repo_id: repoId,
        file_count: fileData.length,
        function_count: functionData.length,
        import_count: importData.length,
        files: fileData,
        functions: functionData,
        imports: importData,
      },
    });
  }
);