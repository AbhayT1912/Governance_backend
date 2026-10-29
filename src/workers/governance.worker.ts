import { Queue, Worker } from "bullmq";
import { AnalysisJobModel, GovernanceTaskModel } from "../models/governance.model";
import { AGENT_DEFINITIONS } from "../governance/agentRegistry";
import { getBullQueueConnectionOptions, redisAvailable, redisConnection } from "../config/queue";
import { logger } from "../config/logger";
import { runAgentTask } from "../agents/agentRuntime";

const queues = new Map<string, Queue>();
const workers = new Map<string, Worker>();

function queueName(agentId: string) {
  return `governance-agent-${agentId}`;
}

function getQueue(agentId: string) {
  const existing = queues.get(agentId);
  if (existing) return existing;
  if (!redisAvailable || !redisConnection) return null;
  const queue = new Queue(queueName(agentId), {
    connection: getBullQueueConnectionOptions(),
  });
  queues.set(agentId, queue);
  return queue;
}

async function finalizeQuiescentJobs() {
  const jobs = await AnalysisJobModel.find({ status: "RUNNING" }).select("_id").lean();
  const { finalizeJobIfReady } = await import("../orchestrator/coordinator");
  for (const job of jobs) await finalizeJobIfReady(job._id.toString());
}

export async function initializeGovernanceWorkers() {
  const staleCutoff = new Date(Date.now() - 90_000);
  await GovernanceTaskModel.updateMany(
    { status: "RUNNING", updatedAt: { $lt: staleCutoff } },
    { $set: { status: "QUEUED" } },
  );

  if (!redisAvailable || !redisConnection) {
    const queuedTasks = await GovernanceTaskModel.find({ status: "QUEUED" })
      .select("_id assignedAgent")
      .lean();
    for (const task of queuedTasks) {
      await enqueueAgentTask(task.assignedAgent, task._id.toString());
    }
    await finalizeQuiescentJobs();
    return false;
  }
  for (const { agentId } of AGENT_DEFINITIONS.filter(
    (agent) => agent.agentId !== "coordinator",
  )) {
    if (workers.has(agentId)) continue;
    const worker = new Worker(
      queueName(agentId),
      async (job) => {
        const attempts = Number(job.opts.attempts || 1);
        const willRetry = job.attemptsMade + 1 < attempts;
        return runAgentTask(String(job.data.taskId), willRetry);
      },
      {
        connection: getBullQueueConnectionOptions(),
        concurrency: 2,
        lockDuration: 150_000,
        stalledInterval: 30_000,
        maxStalledCount: 2,
        limiter: { max: 20, duration: 60_000 },
      },
    );
    worker.on("failed", (job, error) => {
      logger.error("Governance agent task failed", {
        agent_id: agentId,
        task_id: job?.data?.taskId,
        error: error.message,
      });
    });
    worker.on("error", (error) => {
      logger.error("Governance worker error", {
        agent_id: agentId,
        error: error.message,
      });
    });
    workers.set(agentId, worker);
  }

  const queued = await GovernanceTaskModel.find({ status: "QUEUED" })
    .select("_id assignedAgent")
    .lean();
  for (const task of queued) {
    await enqueueAgentTask(task.assignedAgent, task._id.toString());
  }
  await finalizeQuiescentJobs();
  return true;
}

export async function enqueueAgentTask(agentId: string, taskId: string) {
  const queue = getQueue(agentId);
  if (queue) {
    await queue.add(
      "run-agent-task",
      { taskId },
      {
        jobId: taskId,
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    );
    return;
  }

  void runAgentTask(taskId).catch((error) => {
    logger.error("Synchronous governance task failed", {
      agent_id: agentId,
      task_id: taskId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export async function closeGovernanceWorkers() {
  await Promise.all([
    ...Array.from(workers.values(), (worker) => worker.close()),
    ...Array.from(queues.values(), (queue) => queue.close()),
  ]);
  workers.clear();
  queues.clear();
}
