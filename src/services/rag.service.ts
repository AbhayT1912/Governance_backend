import axios, { AxiosError } from "axios";
import { logger } from "../config/logger";

const RAG_BASE_URL = process.env.RAG_SERVICE_URL || "http://localhost:8000";
const RAG_INGEST_TIMEOUT = parseInt(process.env.RAG_INGEST_TIMEOUT || "180000"); // 3 minutes default
const RAG_INGEST_RETRIES = parseInt(process.env.RAG_INGEST_RETRIES || "1");
const RAG_SERVICE_TOKEN = process.env.RAG_SERVICE_TOKEN;

/**
 * Retry logic for RAG ingestion (cold starts, timeouts)
 */
const retryWithBackoff = async (
  fn: () => Promise<any>,
  retries: number = RAG_INGEST_RETRIES,
  delayMs: number = 3000
): Promise<any> => {
  let lastError: any;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < retries) {
        const wait = delayMs * Math.pow(2, i);
        const retryError =
          error instanceof AxiosError
            ? error.response?.status ?? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        logger.warn(
          `[RAG Ingest] Attempt ${i + 1}/${retries + 1} failed, retrying in ${wait}ms...`,
          {
            error: retryError,
          }
        );
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }
  throw lastError;
};

export const ingestRepoToRAG = async (
  repoPath: string,
  repoId: string,
  repoUrl: string
) => {
  await retryWithBackoff(async () => {
    await axios.post(
      `${RAG_BASE_URL}/ingest`,
      {
        repoPath,
        repoId,
        repoUrl,
        repo_url: repoUrl,
      },
      {
        timeout: RAG_INGEST_TIMEOUT,
        headers: RAG_SERVICE_TOKEN ? { Authorization: `Bearer ${RAG_SERVICE_TOKEN}` } : undefined,
      }
    );
  });

  logger.info("RAG ingestion completed successfully", {
    repo_id: repoId,
    rag_url: RAG_BASE_URL,
  });
};
