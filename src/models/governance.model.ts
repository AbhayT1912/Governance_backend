import mongoose, { Document, Schema } from "mongoose";
import {
  FindingEvidence,
  GovernanceEventType,
  PolicyCondition,
  PolicyEffect,
} from "../governance/types";

export interface AgentDocument extends Document {
  agentId: string;
  role: string;
  capabilities: string[];
  allowedTools: string[];
  trustWeight: number;
  status: "ACTIVE" | "DISABLED";
  trustAdjustmentDecisionIds?: string[];
}

const AgentSchema = new Schema<AgentDocument>(
  {
    agentId: { type: String, required: true, unique: true },
    role: { type: String, required: true, index: true },
    capabilities: [{ type: String }],
    allowedTools: [{ type: String }],
    trustWeight: { type: Number, min: 0.5, max: 1.5, default: 1 },
    trustAdjustmentDecisionIds: [{ type: String }],
    status: { type: String, enum: ["ACTIVE", "DISABLED"], default: "ACTIVE" },
  },
  { timestamps: true },
);

export interface PolicyDocument extends Document {
  policyId: string;
  version: number;
  type: string;
  description: string;
  when: { events: GovernanceEventType[] };
  conditions: PolicyCondition[];
  effect: PolicyEffect;
  message: string;
  enabled: boolean;
}

const PolicySchema = new Schema<PolicyDocument>(
  {
    policyId: { type: String, required: true, index: true },
    version: { type: Number, required: true },
    type: { type: String, required: true },
    description: { type: String, required: true },
    when: {
      events: [{ type: String, enum: ["delegate", "message", "tool_call", "output"] }],
    },
    conditions: [
      {
        field: { type: String, required: true },
        op: { type: String, enum: ["eq", "gt", "in", "matches"], required: true },
        value: { type: Schema.Types.Mixed },
      },
    ],
    effect: {
      type: String,
      enum: ["ALLOW", "DENY", "REDACT", "ESCALATE"],
      required: true,
    },
    message: { type: String, required: true },
    enabled: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);
PolicySchema.index({ policyId: 1, version: 1 }, { unique: true });

export interface AnalysisJobDocument extends Document {
  repoId: mongoose.Types.ObjectId;
  requestedBy: string;
  analysisTypes: string[];
  question?: string;
  status:
    | "PLANNING"
    | "RUNNING"
    | "AWAITING_CONSENSUS"
    | "COMPLETED"
    | "ESCALATED"
    | "FAILED";
  plan: Array<{ type: string; agentId: string; taskId?: mongoose.Types.ObjectId }>;
  error?: string;
  completedAt?: Date;
  ragIndexingStatus: "PENDING" | "INDEXED" | "FAILED";
  ragIndexingError?: string;
  llmCalls: number;
  tokensUsed: number;
}

const AnalysisJobSchema = new Schema<AnalysisJobDocument>(
  {
    repoId: { type: Schema.Types.ObjectId, ref: "Repository", required: true, index: true },
    requestedBy: { type: String, required: true, index: true },
    analysisTypes: [{ type: String, required: true }],
    question: { type: String },
    status: {
      type: String,
      enum: ["PLANNING", "RUNNING", "AWAITING_CONSENSUS", "COMPLETED", "ESCALATED", "FAILED"],
      default: "PLANNING",
      index: true,
    },
    plan: [
      {
        type: { type: String, required: true },
        agentId: { type: String, required: true },
        taskId: { type: Schema.Types.ObjectId, ref: "GovernanceTask" },
      },
    ],
    error: { type: String },
    completedAt: { type: Date },
    ragIndexingStatus: { type: String, enum: ["PENDING", "INDEXED", "FAILED"], default: "PENDING", index: true },
    ragIndexingError: { type: String },
    llmCalls: { type: Number, default: 0, min: 0 },
    tokensUsed: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

export interface GovernanceTaskDocument extends Document {
  jobId: mongoose.Types.ObjectId;
  repoId: mongoose.Types.ObjectId;
  type: string;
  assignedAgent: string;
  delegatedBy: string;
  depth: number;
  fingerprint: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "REUSED";
  question?: string;
  reusedFromTaskId?: mongoose.Types.ObjectId;
  error?: string;
  llmCalls: number;
  tokensUsed: number;
  updatedAt?: Date;
}

const GovernanceTaskSchema = new Schema<GovernanceTaskDocument>(
  {
    jobId: { type: Schema.Types.ObjectId, ref: "AnalysisJob", required: true, index: true },
    repoId: { type: Schema.Types.ObjectId, ref: "Repository", required: true, index: true },
    type: { type: String, required: true },
    assignedAgent: { type: String, required: true, index: true },
    delegatedBy: { type: String, required: true },
    depth: { type: Number, required: true, min: 0 },
    fingerprint: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "REUSED"],
      default: "QUEUED",
      index: true,
    },
    question: { type: String },
    reusedFromTaskId: { type: Schema.Types.ObjectId, ref: "GovernanceTask" },
    error: { type: String },
    llmCalls: { type: Number, default: 0, min: 0 },
    tokensUsed: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);
GovernanceTaskSchema.index({ fingerprint: 1, status: 1 });

export interface FindingDocument extends Document {
  jobId: mongoose.Types.ObjectId;
  repoId: mongoose.Types.ObjectId;
  taskId: mongoose.Types.ObjectId;
  agentId: string;
  category: string;
  target: string;
  claim: string;
  riskScore: number;
  confidence: number;
  evidence: FindingEvidence[];
  severity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  reviewStatus: "NOT_REQUIRED" | "PENDING" | "ACCEPTED" | "REJECTED";
  criticVerdict?: string;
  redactions: string[];
  createdAt?: Date;
  updatedAt?: Date;
}

const FindingSchema = new Schema<FindingDocument>(
  {
    jobId: { type: Schema.Types.ObjectId, ref: "AnalysisJob", required: true, index: true },
    repoId: { type: Schema.Types.ObjectId, ref: "Repository", required: true, index: true },
    taskId: { type: Schema.Types.ObjectId, ref: "GovernanceTask", required: true },
    agentId: { type: String, required: true, index: true },
    category: { type: String, required: true, index: true },
    target: { type: String, required: true, index: true },
    claim: { type: String, required: true },
    riskScore: { type: Number, required: true, min: 0, max: 1 },
    confidence: { type: Number, required: true, min: 0, max: 1 },
    evidence: [
      {
        kind: { type: String, enum: ["file", "function", "edge", "security_finding", "finding"], required: true },
        ref: { type: String, required: true },
      },
    ],
    severity: { type: String, enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
    reviewStatus: {
      type: String,
      enum: ["NOT_REQUIRED", "PENDING", "ACCEPTED", "REJECTED"],
      default: "NOT_REQUIRED",
      index: true,
    },
    criticVerdict: { type: String },
    redactions: [{ type: String }],
  },
  { timestamps: true },
);
FindingSchema.index({ jobId: 1, category: 1, target: 1 });

export interface AgentMessageDocument extends Document {
  jobId: mongoose.Types.ObjectId;
  repoId: mongoose.Types.ObjectId;
  from: string;
  to?: string;
  topic: string;
  body: string;
  visibility: "job" | "role" | "private";
  roles: string[];
  policyDecision: string;
}

const AgentMessageSchema = new Schema<AgentMessageDocument>(
  {
    jobId: { type: Schema.Types.ObjectId, ref: "AnalysisJob", required: true, index: true },
    repoId: { type: Schema.Types.ObjectId, ref: "Repository", required: true },
    from: { type: String, required: true },
    to: { type: String },
    topic: { type: String, required: true },
    body: { type: String, required: true },
    visibility: { type: String, enum: ["job", "role", "private"], default: "job" },
    roles: [{ type: String }],
    policyDecision: { type: String, required: true },
  },
  { timestamps: true },
);

export interface DecisionDocument extends Document {
  jobId: mongoose.Types.ObjectId;
  repoId: mongoose.Types.ObjectId;
  category: string;
  target: string;
  score: number;
  agreement: number;
  status: "ACCEPTED" | "ESCALATED" | "REJECTED";
  findingIds: mongoose.Types.ObjectId[];
  dissentIds: mongoose.Types.ObjectId[];
  auditStartSeq?: number;
  auditEndSeq?: number;
  approvedBy?: string;
  approval?: "APPROVED" | "REJECTED";
  trustAdjustedAt?: Date;
}

const DecisionSchema = new Schema<DecisionDocument>(
  {
    jobId: { type: Schema.Types.ObjectId, ref: "AnalysisJob", required: true, index: true },
    repoId: { type: Schema.Types.ObjectId, ref: "Repository", required: true },
    category: { type: String, required: true },
    target: { type: String, required: true },
    score: { type: Number, required: true, min: 0, max: 1 },
    agreement: { type: Number, required: true, min: 0, max: 1 },
    status: { type: String, enum: ["ACCEPTED", "ESCALATED", "REJECTED"], required: true },
    findingIds: [{ type: Schema.Types.ObjectId, ref: "GovernanceFinding" }],
    dissentIds: [{ type: Schema.Types.ObjectId, ref: "GovernanceFinding" }],
    auditStartSeq: { type: Number },
    auditEndSeq: { type: Number },
    approvedBy: { type: String },
    approval: { type: String, enum: ["APPROVED", "REJECTED"] },
    trustAdjustedAt: { type: Date },
  },
  { timestamps: true },
);
DecisionSchema.index({ jobId: 1, category: 1, target: 1 }, { unique: true });

export interface AuditLogDocument extends Document {
  seq: number;
  ts: Date;
  actor: string;
  jobId: string;
  repoId: string;
  event: string;
  action: string;
  policyIds: string[];
  decision: string;
  reason?: string;
  payloadHash: string;
  prevHash: string;
  hash: string;
}

const AuditLogSchema = new Schema<AuditLogDocument>(
  {
    seq: { type: Number, required: true, unique: true },
    ts: { type: Date, required: true },
    actor: { type: String, required: true, index: true },
    jobId: { type: String, required: true, index: true },
    repoId: { type: String, required: true, index: true },
    event: { type: String, required: true },
    action: { type: String, required: true },
    policyIds: [{ type: String }],
    decision: { type: String, required: true },
    reason: { type: String },
    payloadHash: { type: String, required: true },
    prevHash: { type: String, required: true },
    hash: { type: String, required: true },
  },
  { versionKey: false },
);

export const AgentModel = mongoose.model<AgentDocument>("GovernanceAgent", AgentSchema);
export const PolicyModel = mongoose.model<PolicyDocument>("GovernancePolicy", PolicySchema);
export const AnalysisJobModel = mongoose.model<AnalysisJobDocument>("AnalysisJob", AnalysisJobSchema);
export const GovernanceTaskModel = mongoose.model<GovernanceTaskDocument>("GovernanceTask", GovernanceTaskSchema);
export const FindingModel = mongoose.model<FindingDocument>("GovernanceFinding", FindingSchema);
export const AgentMessageModel = mongoose.model<AgentMessageDocument>("AgentMessage", AgentMessageSchema);
export const DecisionModel = mongoose.model<DecisionDocument>("GovernanceDecision", DecisionSchema);
export const AuditLogModel = mongoose.model<AuditLogDocument>("GovernanceAuditLog", AuditLogSchema);
