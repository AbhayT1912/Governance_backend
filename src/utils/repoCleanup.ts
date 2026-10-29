import fs from "fs-extra";
import { logger } from "../config/logger";

/**
 * Retry logic for removing directories with file locks (common on Windows)
 * Uses exponential backoff to wait for file handles to be released
 */
const removeWithRetry = async (
  path: string,
  maxRetries: number = 5,
  delayMs: number = 500
): Promise<void> => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await fs.remove(path);
      return; // Success
    } catch (error: any) {
      const isWindowsLock =
        error.code === "EBUSY" ||
        error.code === "EACCES" ||
        error.message?.includes("resource busy") ||
        error.message?.includes("locked");

      if (!isWindowsLock || attempt === maxRetries) {
        throw error; // Not a lock error or out of retries
      }

      // Exponential backoff: 500ms, 1s, 2s, 4s, 8s
      const wait = delayMs * Math.pow(2, attempt);
      logger.warn(`File lock detected, retrying in ${wait}ms... (attempt ${attempt + 1}/${maxRetries})`, {
        path,
        error: error.code,
      });
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
};

export const cleanupRepo = async (repoPath: string, repoId: string) => {
  try {
    await removeWithRetry(repoPath);
    logger.info("Cleanup completed", { repo_id: repoId });
  } catch (error: any) {
    logger.error("Cleanup failed", {
      repo_id: repoId,
      path: repoPath,
      error: error.message || error.code,
    });
    throw error;
  }
};
