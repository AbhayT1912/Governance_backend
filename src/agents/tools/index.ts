import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { CallModel } from "../../models/call.model";
import { FileModel } from "../../models/file.model";
import { FunctionModel } from "../../models/function.model";
import { ImportModel } from "../../models/import.model";
import { SecurityFindingModel } from "../../models/securityFinding.model";
import { buildRepoDependencyGraph } from "../../services/repoDependency.service";
import { askAIService } from "../../services/ai.service";
import { getRepoPath } from "../../utils/repoPath.util";
import { enforce } from "../../governance/pep";
import { stripInstructionLikeText } from "../../governance/redaction";
import { getJobTokensUsed, getTaskLlmCalls, recordLlmTokenUsage, reserveAgentLlmCall } from "../../governance/budget";
import { AgentTaskContext } from "../../governance/types";

async function call<T>(
  task: AgentTaskContext,
  tool: string,
  run: (safePayload: unknown) => Promise<T>,
  payload: Record<string, unknown> = {},
): Promise<T> {
  if (task.signal?.aborted) throw new Error("Agent execution timed out.");
  const [tokensUsed, llmCalls] = await Promise.all([
    getJobTokensUsed(task.jobId),
    getTaskLlmCalls(task.taskId),
  ]);
  const decision = await enforce({
    type: "tool_call",
    jobId: task.jobId,
    repoId: task.repoId,
    agentId: task.agentId,
    role: task.role,
    action: tool,
    payload: { jobId: task.jobId, repoId: task.repoId, ...payload },
    context: { depth: task.depth, repoId: task.repoId, tokensUsed, llmCalls },
  });
  const result = await run(decision.redactedPayload);
  if (task.signal?.aborted) throw new Error("Agent execution timed out.");
  return result;
}

export async function readStructure(task: AgentTaskContext) {
  return call(task, "read_structure", async () => {
    const repoId = new mongoose.Types.ObjectId(task.repoId);
    const [files, functions] = await Promise.all([
      FileModel.find({ repo_id: repoId }).select("path language size").lean(),
      FunctionModel.find({ repo_id: repoId }).select("name is_entry is_dead").lean(),
    ]);
    const languageCounts = files.reduce<Record<string, number>>((counts, file) => {
      counts[file.language] = (counts[file.language] || 0) + 1;
      return counts;
    }, {});
    return {
      files: files.slice(0, 500),
      fileCount: files.length,
      functionCount: functions.length,
      entryPoints: functions.filter((fn) => fn.is_entry).length,
      languageCounts,
    };
  });
}

export async function readFileGraph(task: AgentTaskContext) {
  return call(task, "read_file_graph", () =>
    buildRepoDependencyGraph(new mongoose.Types.ObjectId(task.repoId)),
  );
}

export async function readImports(task: AgentTaskContext) {
  return call(task, "read_imports", async () => {
    const repoId = new mongoose.Types.ObjectId(task.repoId);
    const [imports, files] = await Promise.all([
      ImportModel.find({ repo_id: repoId }).lean(),
      FileModel.find({ repo_id: repoId }).select("path").lean(),
    ]);
    const fileById = new Map(files.map((file) => [file._id.toString(), file.path]));
    return imports.map((item) => ({
      source: item.source,
      file: fileById.get(item.file_id.toString()) || item.file_id.toString(),
      isExternal: item.is_external,
    }));
  });
}

export async function readFunctions(task: AgentTaskContext) {
  return call(task, "read_functions", async () => {
    const [functions, files] = await Promise.all([
      FunctionModel.find({ repo_id: new mongoose.Types.ObjectId(task.repoId) })
        .select("name file_id start_line end_line is_dead is_entry depth complexity")
        .limit(10000)
        .lean(),
      FileModel.find({ repo_id: new mongoose.Types.ObjectId(task.repoId) })
        .select("path")
        .lean(),
    ]);
    const filePathById = new Map(
      files.map((file) => [file._id.toString(), file.path]),
    );
    return functions.map((fn) => ({
      ...fn,
      filePath: filePathById.get(fn.file_id.toString()) || fn.file_id.toString(),
    }));
  });
}

export async function readCallGraph(task: AgentTaskContext) {
  return call(task, "read_call_graph", () =>
    CallModel.find({ repo_id: new mongoose.Types.ObjectId(task.repoId) })
      .select("caller_function_id callee_function_id")
      .limit(20000)
      .lean(),
  );
}

export async function readSecurityFindings(task: AgentTaskContext) {
  return call(task, "read_security_findings", () =>
    SecurityFindingModel.find({
      repo_id: new mongoose.Types.ObjectId(task.repoId),
      status: { $ne: "RESOLVED" },
    })
      .select("type severity title description file_path line_number impact remediation")
      .limit(2000)
      .lean(),
  );
}

export async function readSourceFile(task: AgentTaskContext, relativePath: string) {
  return call(
    task,
    "read_source_file",
    async () => {
      const repoRoot = path.resolve(getRepoPath(task.repoId));
      const absolutePath = path.resolve(repoRoot, relativePath);
      if (!absolutePath.startsWith(`${repoRoot}${path.sep}`)) {
        throw new Error("Requested source path is outside the repository.");
      }
      const stats = await fs.promises.stat(absolutePath);
      if (!stats.isFile() || stats.size > 256 * 1024) {
        throw new Error("Requested source file is not a readable file under 256 KB.");
      }
      const source = await fs.promises.readFile(absolutePath, "utf8");
      const decision = await enforce({
        type: "message",
        jobId: task.jobId,
        repoId: task.repoId,
        agentId: task.agentId,
        role: task.role,
        action: "source_sanitization",
        payload: { jobId: task.jobId, repoId: task.repoId, content: source },
        context: { depth: task.depth, repoId: task.repoId, tokensUsed: 0 },
      });
      const sanitizedPayload = decision.redactedPayload as { content?: string } | undefined;
      const safeText = sanitizedPayload?.content ?? stripInstructionLikeText(source).safeText;
      const { strippedLines } = stripInstructionLikeText(source);
      return {
        content: safeText,
        injectionLinesStripped: strippedLines.length,
      };
    },
    { path: relativePath },
  );
}

export async function askRepositoryRag(task: AgentTaskContext, question: string) {
  return call(task, "ask_rag", (safePayload) => {
    const safeQuestion = (safePayload as { question?: string } | undefined)?.question;
    if (!safeQuestion) throw new Error("Q&A question was removed by governance sanitization.");
    return (async () => {
      await reserveAgentLlmCall(task.jobId, task.taskId);
      const response = await askAIService(
        task.repoId,
        safeQuestion,
        { agentId: task.agentId, jobId: task.jobId },
        task.signal,
      );
      for (const warning of response.injectionWarnings || []) {
        await enforce({
          type: "message",
          jobId: task.jobId,
          repoId: task.repoId,
          agentId: task.agentId,
          role: task.role,
          action: "repository_prompt_injection_stripped",
          payload: {
            jobId: task.jobId,
            repoId: task.repoId,
            body: "ignore previous instructions (stripped from repository source)",
            source: warning.file,
            strippedLineCount: warning.count,
          },
          context: {
            depth: task.depth,
            repoId: task.repoId,
            tokensUsed: await getJobTokensUsed(task.jobId),
          },
        });
      }
      const usage = response.usage;
      const tokens = Number(usage?.totalTokens ?? ((usage?.promptTokens || 0) + (usage?.completionTokens || 0)));
      try {
        await recordLlmTokenUsage(task.jobId, task.taskId, tokens);
      } catch (error) {
        await enforce({
          type: "tool_call",
          jobId: task.jobId,
          repoId: task.repoId,
          agentId: task.agentId,
          role: task.role,
          action: "ask_rag",
          payload: { jobId: task.jobId, repoId: task.repoId, tokensUsed: tokens },
          context: { depth: task.depth, repoId: task.repoId, tokensUsed: await getJobTokensUsed(task.jobId) },
        });
        throw error;
      }
      return response;
    })();
  }, {
    question,
  });
}
