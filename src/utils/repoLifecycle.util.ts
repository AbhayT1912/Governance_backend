import { RepoModel } from "../models/repo.model";
import { RepoStatus } from "../types/repo.types";

const VALID_TRANSITIONS: Record<RepoStatus, RepoStatus[]> = {
  RECEIVED: ["CLONING", "FAILED"],
  CLONING: ["SCANNING", "FAILED"],
  SCANNING: ["PARSING", "FAILED"],
  PARSING: ["GRAPHING", "FAILED"],
  GRAPHING: ["INDEXING", "FAILED"],
  INDEXING: ["READY", "FAILED"],
  READY: [],
  FAILED: [],
};

export const updateRepoStatus = async (
  repoId: string,
  nextStatus: RepoStatus,
  errorMessage?: string
) => {
  const repo = await RepoModel.findById(repoId);
  if (!repo) throw new Error("Repository not found");

  const currentStatus = repo.status;

  if (!VALID_TRANSITIONS[currentStatus].includes(nextStatus)) {
    throw new Error(
      `Invalid status transition: ${currentStatus} → ${nextStatus}`
    );
  }

  repo.status = nextStatus;

  if (nextStatus === "CLONING") {
    repo.started_at = new Date();
  }

  if (nextStatus === "READY" || nextStatus === "FAILED") {
    repo.completed_at = new Date();
  }

  if (nextStatus === "FAILED" && errorMessage) {
    repo.error_message = errorMessage;
  }

  await repo.save();
};
