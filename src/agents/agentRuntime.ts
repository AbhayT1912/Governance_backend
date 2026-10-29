import mongoose from "mongoose";
import { BaseAgent } from "./BaseAgent";
import { askRepositoryRag, readFileGraph, readFunctions, readSecurityFindings, readStructure } from "./tools";
import { AgentModel, AnalysisJobModel, FindingModel, GovernanceTaskModel } from "../models/governance.model";
import { AgentTaskContext, FindingEvidence, FindingInput } from "../governance/types";
import { analyzeFileGraph } from "../services/fileGraph.service";
import { readImports } from "./tools";
import { readAgentMessages } from "../memory/sharedMemory.service";
import { enforce } from "../governance/pep";
import { logger } from "../config/logger";
import { getJobTokensUsed } from "../governance/budget";

const AGENT_TIMEOUT_MS = 120_000;

function boundedScore(value: number) {
  return Math.max(0, Math.min(1, value));
}

function securityRisk(severity: string) {
  switch (severity) {
    case "CRITICAL": return 1;
    case "HIGH": return 0.85;
    case "MEDIUM": return 0.55;
    default: return 0.25;
  }
}

async function analyzeTask(task: AgentTaskContext): Promise<FindingInput[]> {
  switch (task.agentId) {
    case "structure": {
      const structure = await readStructure(task);
      const representativeFile = structure.files[0];
      if (!representativeFile) return [];
      return [{
        category: "structure",
        target: "repository",
        claim: `Repository contains ${structure.fileCount} supported files and ${structure.functionCount} parsed functions. Languages: ${Object.entries(structure.languageCounts).map(([name, count]) => `${name} (${count})`).join(", ") || "none detected"}.`,
        riskScore: 0,
        confidence: 1,
        evidence: [{ kind: "file", ref: representativeFile.path }],
      }];
    }
    case "dependency": {
      const graph = await readFileGraph(task);
      const imports = await readImports(task);
      const analysis = analyzeFileGraph(
        graph.edges.map((edge) => ({ from: edge.from, to: edge.to })),
      );
      const findings: FindingInput[] = analysis.cycles.map((cycle) => ({
        category: "dependency-cycle",
        target: [...cycle.nodes].sort().join(","),
        claim: `Circular dependency among ${cycle.size} files (${cycle.total_internal_edges} dependency edges).`,
        riskScore: boundedScore(cycle.severity_score / 20),
        confidence: 0.95,
        severity: cycle.size > 3 ? "HIGH" : "MEDIUM",
        evidence: cycle.nodes.map((id) => ({
          kind: "file" as const,
          ref: graph.fileById.get(id)?.path || id,
        })),
      }));
      if (imports.some((item) => item.isExternal) && graph.nodes.length > 0) {
        findings.push({
          category: "dependency-footprint",
          target: "external-imports",
          claim: `Repository declares ${imports.filter((item) => item.isExternal).length} external imports.`,
          riskScore: 0.1,
          confidence: 1,
          evidence: [{
            kind: "file",
            ref: graph.fileById.get(graph.nodes[0].id)?.path || graph.nodes[0].path,
          }],
        });
      }
      return findings;
    }
    case "dead-code": {
      const functions = await readFunctions(task);
      const preservationNotes = (task.sharedMessages || [])
        .filter((message) => ["preserve-function", "entry-point"].includes(message.topic))
        .map((message) => `${message.body} ${message.from}`);
      const deadFunctions = functions.filter((fn) =>
        fn.is_dead && !preservationNotes.some((note) =>
          note.includes(fn._id.toString()) || note.includes(fn.name) || note.includes(fn.filePath),
        ),
      );
      return deadFunctions.map((fn) => ({
        category: "dead-code",
        target: fn._id.toString(),
        claim: `Function "${fn.name}" is unreachable in the computed call graph.`,
        riskScore: 0.35,
        confidence: 0.8,
        severity: "LOW",
        evidence: [
          { kind: "function", ref: fn._id.toString() },
          { kind: "file", ref: fn.filePath },
        ],
      }));
    }
    case "security": {
      const findings = await readSecurityFindings(task);
      return findings.map((finding) => ({
        category: "security",
        target: `${finding.file_path || "repository"}:${finding.line_number || 0}`,
        claim: `${finding.title}: ${finding.description}`,
        riskScore: securityRisk(finding.severity),
        confidence: finding.severity === "CRITICAL" ? 0.95 : 0.8,
        severity: finding.severity,
        evidence: [{
          kind: "security_finding",
          ref: finding._id.toString(),
        }, ...(finding.file_path
          ? [{ kind: "file" as const, ref: finding.file_path }]
          : [])],
      }));
    }
    case "quality": {
      const functions = await readFunctions(task);
      return functions
        .filter((fn) => (fn.complexity || 1) >= 10)
        .map((fn) => ({
          category: "quality",
          target: fn._id.toString(),
          claim: `Function "${fn.name}" has cyclomatic complexity ${fn.complexity || 1}.`,
          riskScore: boundedScore(((fn.complexity || 1) - 8) / 20),
          confidence: 0.85,
          severity: (fn.complexity || 1) >= 20 ? "HIGH" as const : "MEDIUM" as const,
          evidence: [
            { kind: "function" as const, ref: fn._id.toString() },
            { kind: "file" as const, ref: fn.filePath },
          ],
        }));
    }
    case "qa": {
      if (!task.question) throw new Error("Q&A task requires a question.");
      const response = await askRepositoryRag(task, task.question);
      const evidence: FindingEvidence[] = (response.sources || []).flatMap((source): FindingEvidence[] => {
        const findingIds = [source.findingId, ...(source.findingIds || [])]
          .filter((id): id is string => typeof id === "string" && mongoose.Types.ObjectId.isValid(id));
        if (findingIds.length) return findingIds.map((ref) => ({ kind: "finding" as const, ref }));
        if (source.sourceFile) return [{ kind: "file" as const, ref: source.sourceFile }];
        if (source.file && !source.file.startsWith("Governance ")) return [{ kind: "file" as const, ref: source.file }];
        return [];
      });
      if (!evidence.length) return [];
      return [{
        category: "qa",
        target: "repository",
        claim: response.answer,
        riskScore: 0,
        confidence: 0.7,
        evidence: evidence.slice(0, 10),
      }];
    }
    default:
      throw new Error(`No runtime registered for agent ${task.agentId}`);
  }
}

class RegisteredAgent extends BaseAgent {
  protected analyze(task: AgentTaskContext) {
    return analyzeTask(task);
  }
}

export async function runAgentTask(taskId: string, retrying = false) {
  const taskDocument = await GovernanceTaskModel.findById(taskId);
  if (!taskDocument) return;
  const staleCutoff = new Date(Date.now() - 90_000);
  if (taskDocument.status === "RUNNING" && taskDocument.updatedAt && taskDocument.updatedAt < staleCutoff) {
    await GovernanceTaskModel.updateOne(
      { _id: taskDocument._id, status: "RUNNING", updatedAt: { $lt: staleCutoff } },
      { $set: { status: "QUEUED" } },
    );
  }

  const claimed = await GovernanceTaskModel.findOneAndUpdate(
    { _id: taskDocument._id, status: "QUEUED" },
    { $set: { status: "RUNNING" } },
    { new: true },
  );
  if (!claimed) return;

  const activeJob = await AnalysisJobModel.exists({ _id: claimed.jobId, status: "RUNNING" });
  if (!activeJob) {
    await GovernanceTaskModel.updateOne(
      { _id: claimed._id, status: "RUNNING" },
      { $set: { status: "FAILED", error: "Governance job is no longer active." } },
    );
    return;
  }

  const executionStartedAt = Date.now();
  try {
    await FindingModel.deleteMany({ taskId: claimed._id });
    const agent = await AgentModel.findOne({
      agentId: claimed.assignedAgent,
      status: "ACTIVE",
    }).lean();
    if (!agent) throw new Error(`Agent ${claimed.assignedAgent} is not active.`);

    const sharedMessages = await readAgentMessages({
      jobId: claimed.jobId.toString(),
      repoId: claimed.repoId.toString(),
      agentId: agent.agentId,
      role: agent.role,
    });
    const task: AgentTaskContext = {
      jobId: claimed.jobId.toString(),
      repoId: claimed.repoId.toString(),
      taskId: claimed._id.toString(),
      agentId: agent.agentId,
      role: agent.role,
      depth: claimed.depth,
      question: claimed.question,
      signal: undefined,
      sharedMessages: sharedMessages.map((message) => ({
        from: message.from,
        topic: message.topic,
        body: message.body,
      })),
    };
    const controller = new AbortController();
    task.signal = controller.signal;
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        new RegisteredAgent(agent.agentId, agent.role).run(task),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error(`Agent execution timed out after ${AGENT_TIMEOUT_MS}ms.`));
          }, Math.max(0, AGENT_TIMEOUT_MS - (Date.now() - executionStartedAt)));
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    await GovernanceTaskModel.updateOne(
      { _id: claimed._id },
      { $set: { status: "COMPLETED" } },
    );
    const { finalizeJobIfReady } = await import("../orchestrator/coordinator");
    await finalizeJobIfReady(claimed.jobId.toString());
  } catch (error) {
    const durationMs = Date.now() - executionStartedAt;
    if (durationMs > AGENT_TIMEOUT_MS) {
      try {
        await enforce({
          type: "message",
          jobId: claimed.jobId.toString(),
          repoId: claimed.repoId.toString(),
          agentId: claimed.assignedAgent,
          role: claimed.assignedAgent,
          action: "agent_timeout",
          payload: { jobId: claimed.jobId.toString(), repoId: claimed.repoId.toString(), taskId },
          context: {
            depth: claimed.depth,
            repoId: claimed.repoId.toString(),
            tokensUsed: await getJobTokensUsed(claimed.jobId.toString()),
            durationMs,
          },
        });
      } catch (auditError) {
        if ((auditError as Error)?.name !== "PolicyViolationError") {
          logger.error("Could not audit an agent timeout", {
            task_id: taskId,
            error: auditError instanceof Error ? auditError.message : String(auditError),
          });
        }
      }
    }
    await GovernanceTaskModel.updateOne(
      { _id: claimed._id },
      {
        $set: {
          status: retrying ? "QUEUED" : "FAILED",
          error: error instanceof Error ? error.message : String(error),
        },
      },
    );
    if (!retrying) {
      const { failJobIfNecessary } = await import("../orchestrator/coordinator");
      await failJobIfNecessary(claimed.jobId.toString());
    }
    throw error;
  }
}
