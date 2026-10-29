import { AgentModel } from "../models/governance.model";
import { PolicyModel } from "../models/governance.model";
import policyDefaults from "./policies/default.json";

export const AGENT_DEFINITIONS = [
  {
    agentId: "structure",
    role: "structure",
    capabilities: ["structure_summary"],
    allowedTools: ["read_structure", "read_messages"],
    trustWeight: 1,
  },
  {
    agentId: "dependency",
    role: "dependency",
    capabilities: ["dependency_analysis"],
    allowedTools: ["read_file_graph", "read_imports", "read_messages"],
    trustWeight: 1,
  },
  {
    agentId: "dead-code",
    role: "dead-code",
    capabilities: ["dead_code_analysis"],
    allowedTools: ["read_functions", "read_messages"],
    trustWeight: 1,
  },
  {
    agentId: "security",
    role: "security",
    capabilities: ["security_analysis"],
    allowedTools: ["read_security_findings", "read_source_file", "read_messages"],
    trustWeight: 1,
  },
  {
    agentId: "quality",
    role: "quality",
    capabilities: ["quality_analysis"],
    allowedTools: ["read_functions", "read_messages"],
    trustWeight: 1,
  },
  {
    agentId: "qa",
    role: "qa",
    capabilities: ["repository_question_answering"],
    allowedTools: ["ask_rag", "read_messages"],
    trustWeight: 1,
  },
  {
    agentId: "critic",
    role: "critic",
    capabilities: ["finding_review"],
    allowedTools: ["read_findings", "read_functions", "read_imports", "read_messages", "write_review"],
    trustWeight: 1,
  },
  {
    agentId: "coordinator",
    role: "coordinator",
    capabilities: ["job_orchestration"],
    allowedTools: ["index_rag"],
    trustWeight: 1,
  },
] as const;

export async function seedAgentRegistry() {
  for (const agent of AGENT_DEFINITIONS) {
    await AgentModel.updateOne(
      { agentId: agent.agentId },
      {
        $set: {
          role: agent.role,
          capabilities: [...agent.capabilities],
          allowedTools: [...agent.allowedTools],
        },
        $setOnInsert: { trustWeight: agent.trustWeight, status: "ACTIVE" },
      },
      { upsert: true },
    );
  }

  for (const policy of policyDefaults) {
    await PolicyModel.updateOne(
      { policyId: policy.policyId, version: policy.version },
      { $setOnInsert: policy },
      { upsert: true },
    );
  }
}

export async function getAgent(agentId: string) {
  return AgentModel.findOne({ agentId, status: "ACTIVE" }).lean();
}

export async function isPolicyActive(policyId: string, expectedEffect?: string) {
  const policy = await PolicyModel.findOne({ policyId }).sort({ version: -1 }).lean();
  return Boolean(policy?.enabled && (!expectedEffect || policy.effect === expectedEffect));
}

export async function listActiveAgents() {
  return AgentModel.find({ status: "ACTIVE" })
    .select("agentId role capabilities allowedTools trustWeight status")
    .sort({ agentId: 1 })
    .lean();
}
