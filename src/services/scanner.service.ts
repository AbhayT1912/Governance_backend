import fs from "fs";
import path from "path";
import mongoose from "mongoose";

import { FileModel } from "../models/file.model";
import { RepoModel } from "../models/repo.model";
import { updateRepoStatus } from "../utils/repoLifecycle.util";
import { logger } from "../config/logger";

const IGNORED_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__tests__",
  "tests",
  "fixtures",
  "coverage",
  "docs",
  "examples",
  "flow-typed",
  "scripts",
  "benchmarks",
  "__mocks__",
  "www",
  "cjs",
  "umd",
];

const MAX_FILE_COUNT = 5000;

const detectLanguage = (filePath: string): string => {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case ".js":
    case ".jsx":
      return "JavaScript";

    case ".ts":
    case ".tsx":
      return "TypeScript";

    case ".json":
      return "JSON";

    default:
      return "Other";
  }
};

export const scanRepository = async (
  repoPath: string,
  repoId: string
): Promise<number> => {
  let fileCount = 0;
  const filesToInsert: any[] = [];

  try {
    const walk = (currentPath: string) => {
      const entries = fs.readdirSync(currentPath);

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry);
        const stats = fs.statSync(fullPath);

        if (stats.isDirectory()) {
          if (!IGNORED_DIRS.includes(entry)) {
            walk(fullPath);
          }
        } else {
          const language = detectLanguage(fullPath);
          if (language === "Other") continue;

          fileCount++;

          if (fileCount > MAX_FILE_COUNT) {
            throw new Error(
              `File count exceeds limit (${MAX_FILE_COUNT})`
            );
          }

          const relativePath = path
            .relative(repoPath, fullPath)
            .replace(/\\/g, "/");

          filesToInsert.push({
            repo_id: new mongoose.Types.ObjectId(repoId),
            path: relativePath,
            language,
            size: stats.size,
          });
        }
      }
    };

    walk(repoPath);

    if (filesToInsert.length > 0) {
      await FileModel.insertMany(filesToInsert);
    }

    await RepoModel.findByIdAndUpdate(repoId, {
      file_count: fileCount,
    });

    logger.info("Repository scanned", {
      repo_id: repoId,
      total_files: fileCount,
    });

    return fileCount;
  } catch (error: any) {
    logger.error("Repository scanning failed", {
      repo_id: repoId,
      error: error.message,
    });

    throw error; // let processRepository handle lifecycle
  }
};
