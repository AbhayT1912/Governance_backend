import { spawn } from "child_process";
import fs from "fs-extra";
import { AppError } from "../utils/AppError";
import { logger } from "../config/logger";
import { ENV } from "../config/env";
import { cleanupRepo } from "../utils/repoCleanup";
import simpleGit from "simple-git";

export async function getRepositoryCommitSha(repoPath: string) {
  return (await simpleGit(repoPath).revparse(["HEAD"])).trim();
}

const CLONE_TIMEOUT_MS = ENV.CLONE_TIMEOUT;

export const cloneRepository = (
  repoUrl: string,
  repoPath: string,
  repoId: string
): Promise<void> => {
  return new Promise((resolve, reject) => {
    logger.info("Clone started", { repo_id: repoId });

    let authenticatedUrl = repoUrl;
    if (process.env.GITHUB_TOKEN && repoUrl.includes("github.com")) {
      authenticatedUrl = repoUrl.replace("https://github.com", `https://${process.env.GITHUB_TOKEN}@github.com`);
    }

    const gitProcess = spawn("git", ["clone", "--depth", "1", authenticatedUrl, repoPath]);

    let timeoutHandle: NodeJS.Timeout;
    let isSettled = false;

    const finalize = async (error?: Error) => {
      if (isSettled) return;
      isSettled = true;

      clearTimeout(timeoutHandle);

      try {
        gitProcess.kill("SIGKILL");
      } catch {}

      if (error) {
        // Wait for git process to fully release file handles (Windows fix)
        // This is critical for preventing EBUSY errors on shallow.lock
        await new Promise((resolve) => setTimeout(resolve, 1000));

        try {
          // Use retry logic from repoCleanup for robustness
          await cleanupRepo(repoPath, repoId);
        } catch (cleanupError: any) {
          logger.warn("Cleanup during clone failure encountered issues", {
            repo_id: repoId,
            error: cleanupError.message,
          });
          // Don't throw - we still want to report the original clone error
        }

        logger.error("Clone failed", {
          repo_id: repoId,
          error: error.message,
        });

        return reject(
          new AppError(error.message || "Repository clone failed", 500)
        );
      }

      logger.info("Clone completed", { repo_id: repoId });
      resolve();
    };

    timeoutHandle = setTimeout(() => {
      finalize(new Error(`Git clone timeout exceeded (${CLONE_TIMEOUT_MS}ms)`));
    }, CLONE_TIMEOUT_MS);

    gitProcess.on("close", (code) => {
      if (code === 0) {
        finalize();
      } else {
        finalize(new Error(`Git clone failed with exit code ${code}`));
      }
    });

    gitProcess.on("error", (err) => {
      finalize(err);
    });
  });
};
