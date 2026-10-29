import fs from "fs";
import path from "path";
import { ENV } from "../config/env";
import { AppError } from "./AppError";

const calculateSize = (dirPath: string): number => {
  let totalSize = 0;

  const files = fs.readdirSync(dirPath);

  for (const file of files) {
    const filePath = path.join(dirPath, file);
    const stats = fs.statSync(filePath);

    if (stats.isDirectory()) {
      totalSize += calculateSize(filePath);
    } else {
      totalSize += stats.size;
    }
  }

  return totalSize;
};

export const enforceRepoSizeLimit = (repoPath: string) => {
  const sizeBytes = calculateSize(repoPath);
  const sizeMB = sizeBytes / (1024 * 1024);

  if (sizeMB > ENV.MAX_REPO_SIZE_MB) {
    throw new AppError("Repository exceeds size limit", 400);
  }
};
