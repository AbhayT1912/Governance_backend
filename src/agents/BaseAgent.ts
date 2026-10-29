import { AnalysisJobModel, FindingModel } from "../models/governance.model";
import { enforce } from "../governance/pep";
import { AgentTaskContext, FindingInput } from "../governance/types";
import { getJobTokensUsed } from "../governance/budget";

export abstract class BaseAgent {
  constructor(
    public readonly id: string,
    public readonly role: string,
  ) {}

  protected abstract analyze(task: AgentTaskContext): Promise<FindingInput[]>;

  async run(task: AgentTaskContext) {
    if (!await AnalysisJobModel.exists({ _id: task.jobId, status: "RUNNING" })) {
      throw new Error("Governance job is no longer active.");
    }
    const findings = await this.analyze(task);
    if (task.signal?.aborted) throw new Error("Agent execution timed out.");
    const stored = [];

    for (const finding of findings) {
      if (task.signal?.aborted) throw new Error("Agent execution timed out.");
      if (!await AnalysisJobModel.exists({ _id: task.jobId, status: "RUNNING" })) {
        throw new Error("Governance job is no longer active.");
      }
      const tokensUsed = await getJobTokensUsed(task.jobId);
      const decision = await enforce({
        type: "output",
        jobId: task.jobId,
        repoId: task.repoId,
        agentId: this.id,
        role: this.role,
        action: finding.category,
        payload: finding,
        context: { depth: task.depth, repoId: task.repoId, tokensUsed },
      });
      const safeFinding = (decision.redactedPayload || finding) as FindingInput;
      stored.push(
        await FindingModel.create({
          ...safeFinding,
          jobId: task.jobId,
          repoId: task.repoId,
          taskId: task.taskId,
          agentId: this.id,
          reviewStatus: decision.effect === "ESCALATE" ? "PENDING" : "NOT_REQUIRED",
          redactions: decision.redactions || [],
        }),
      );
    }

    return stored;
  }
}
