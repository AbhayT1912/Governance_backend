import axios, { AxiosError } from "axios";

const RAG_BASE_URL = process.env.RAG_SERVICE_URL || "http://localhost:8000";
const RAG_TIMEOUT = parseInt(process.env.RAG_TIMEOUT || "60000"); // 60s default, up from 10s
const RAG_RETRIES = parseInt(process.env.RAG_RETRIES || "2");
const RAG_SERVICE_TOKEN = process.env.RAG_SERVICE_TOKEN;

export interface AskUsage {
  totalTokens?: number;
  promptTokens?: number;
  completionTokens?: number;
  model?: string;
}

export interface AskAIResponse {
  answer: string;
  usage?: AskUsage;
  sources?: Array<{
    file: string;
    symbol?: string;
    type?: string;
    findingId?: string;
    findingIds?: string[];
    sourceFile?: string;
  }>;
  injectionWarnings?: Array<{ file: string; count: number }>;
}

export interface GovernanceIndexInput {
  id: string;
  category: string;
  target: string;
  claim?: string;
  riskScore?: number;
  confidence?: number;
  evidence?: Array<{ kind: string; ref: string }>;
  score?: number;
  agreement?: number;
  status?: string;
  findingIds?: string[];
  dissentIds?: string[];
}

/**
 * Retry logic for cold-start/timeout scenarios
 */
const retryWithBackoff = async (
  fn: () => Promise<any>,
  retries: number = RAG_RETRIES,
  delayMs: number = 2000
): Promise<any> => {
  let lastError: any;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (error instanceof AxiosError && error.code === "ERR_CANCELED") throw error;
      if (i < retries) {
        // Exponential backoff: 2s, 4s, 8s, etc.
        const wait = delayMs * Math.pow(2, i);
        console.warn(
          `[RAG] Attempt ${i + 1}/${retries + 1} failed, retrying in ${wait}ms...`,
          error instanceof AxiosError ? { status: error.response?.status, message: error.message } : error
        );
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }
  throw lastError;
};

export const ingestToRAG = async (repoPath: string, repoId: string) => {
  return retryWithBackoff(async () => {
    const response = await axios.post(
      `${RAG_BASE_URL}/ingest`,
      {
        repoPath,
        repoId,
      },
      {
        timeout: RAG_TIMEOUT,
        headers: RAG_SERVICE_TOKEN ? { Authorization: `Bearer ${RAG_SERVICE_TOKEN}` } : undefined,
      }
    );
    return response.data;
  });
};

export const askAIService = async (
  repoId: string,
  question: string,
  identity?: { agentId: string; jobId: string },
  signal?: AbortSignal,
): Promise<AskAIResponse> => {
  return retryWithBackoff(async () => {
    const response = await axios.post(
      `${RAG_BASE_URL}/ask`,
      {
        repoId,
        question,
      },
      {
        timeout: RAG_TIMEOUT,
        signal,
        headers: {
          ...(RAG_SERVICE_TOKEN ? { Authorization: `Bearer ${RAG_SERVICE_TOKEN}` } : {}),
          ...(identity ? {
            "x-repolens-agent-id": identity.agentId,
            "x-repolens-job-id": identity.jobId,
          } : {}),
        },
      }
    );

    // Normalize the response to handle different upstream formats
    const answer = response.data?.answer ?? response.data?.data?.answer ?? "";
    const usage = response.data?.usage ?? response.data?.data?.usage;
    const sources =
      response.data?.retrieval?.sources ??
      response.data?.data?.retrieval?.sources;
    const injectionWarnings = response.data?.injectionWarnings ?? [];

    if (!answer) {
      throw new Error(
        response.data?.error ||
          response.data?.message ||
          "No answer received from RAG service"
      );
    }

    return {
      answer,
      usage,
      sources: Array.isArray(sources) ? sources : [],
      injectionWarnings: Array.isArray(injectionWarnings) ? injectionWarnings : [],
    } as AskAIResponse;
  });
};

export const indexGovernanceResults = async (
  repoId: string,
  jobId: string,
  findings: GovernanceIndexInput[],
  decisions: GovernanceIndexInput[],
  identity?: { agentId: string; jobId: string },
) => {
  const batchSize = 20;
  const batchCount = Math.max(1, Math.ceil(findings.length / batchSize), Math.ceil(decisions.length / batchSize));
  let storedVectors = 0;
  for (let batch = 0; batch < batchCount; batch += 1) {
    const findingBatch = findings.slice(batch * batchSize, (batch + 1) * batchSize);
    const decisionBatch = decisions.slice(batch * batchSize, (batch + 1) * batchSize);
    const response = await retryWithBackoff(async () => axios.post(
      `${RAG_BASE_URL}/governance/index`,
      { repoId, jobId, findings: findingBatch, decisions: decisionBatch, replace: batch === 0 },
      {
        timeout: RAG_TIMEOUT,
        headers: {
          ...(RAG_SERVICE_TOKEN ? { Authorization: `Bearer ${RAG_SERVICE_TOKEN}` } : {}),
          ...(identity ? {
            "x-repolens-agent-id": identity.agentId,
            "x-repolens-job-id": identity.jobId,
          } : {}),
        },
      },
    ));
    if (!response.data?.success) throw new Error("RAG service did not confirm governance indexing.");
    storedVectors += Number(response.data.storedVectors || 0);
  }
  return { success: true, storedVectors };
};
