import mongoose, { Document, Schema } from "mongoose";

export interface RepoReportDocument extends Document {
  repo_id: mongoose.Types.ObjectId;

  overview: string;
  architecture_summary: string;
  architecture_health_score: number;

  entry_points: string[];
  dead_functions_count: number;
  total_files: number;
  total_functions: number;

  complexity_metrics: any;
  layer_analysis: any;
  dependency_density: any;
  investor_summary: any;
  risk_exposure: any;
  maturity: any;
  modules?: Array<{
    name: string;
    files_count: number;
    functions_count: number;
    complexity: 'low' | 'medium' | 'high';
    type?: string;
  }>;

  // Security analysis fields
  security_trust_score?: number;
  security_findings_count?: number;
  security_findings?: Array<{
    type: string;
    severity: string;
    title: string;
    count: number;
  }>;
  security_summary?: {
    total_findings: number;
    by_type: {
      secrets: number;
      sast: number;
      dependencies: number;
      malicious: number;
      licenses: number;
    };
    by_severity: {
      critical: number;
      high: number;
      medium: number;
      low: number;
    };
  };

  version: number;
  previous_version_id: mongoose.Types.ObjectId | null;

  score_delta: {
    architecture: number;
    layer: number;
    complexity: number;
    dead_functions: number;
  }

  generated_at: Date;
}

const RepoReportSchema = new Schema<RepoReportDocument>(
  {
    repo_id: {
      type: Schema.Types.ObjectId,
      ref: "Repository",
      required: true,
      index: true,
    },

    overview: { type: String },
    architecture_summary: { type: String },
    architecture_health_score: { type: Number, default: 0 },

    entry_points: [{ type: String }],
    dead_functions_count: { type: Number },
    total_files: { type: Number },
    total_functions: { type: Number },

    // 🔥 NEW FIELDS
    complexity_metrics: { type: Schema.Types.Mixed },
    layer_analysis: { type: Schema.Types.Mixed },
    dependency_density: { type: Schema.Types.Mixed },
    investor_summary: { type: Schema.Types.Mixed },
    risk_exposure: { type: Schema.Types.Mixed },
    maturity: { type: Schema.Types.Mixed },
    modules: [{
      name: { type: String },
      files_count: { type: Number },
      functions_count: { type: Number },
      complexity: { type: String, enum: ['low', 'medium', 'high'] },
      type: { type: String },
    }],

    // Security analysis fields
    security_trust_score: { type: Number, default: 100, min: 0, max: 100 },
    security_findings_count: { type: Number, default: 0 },
    security_findings: [{
      type: { type: String },
      severity: { type: String },
      title: { type: String },
      count: { type: Number },
    }],
    security_summary: {
      total_findings: { type: Number, default: 0 },
      by_type: {
        secrets: { type: Number, default: 0 },
        sast: { type: Number, default: 0 },
        dependencies: { type: Number, default: 0 },
        malicious: { type: Number, default: 0 },
        licenses: { type: Number, default: 0 },
      },
      by_severity: {
        critical: { type: Number, default: 0 },
        high: { type: Number, default: 0 },
        medium: { type: Number, default: 0 },
        low: { type: Number, default: 0 },
      },
    },

    generated_at: {
      type: Date,
      default: Date.now,
    },
    version: {
      type: Number,
      required: true,
    },
    previous_version_id: {
      type: Schema.Types.ObjectId,
      ref: "RepoReport",
    },
    score_delta: {
        architecture: { type: Number, default: 0 },
        layer: { type: Number, default: 0 },
        complexity: { type: Number, default: 0 },
        dead_functions: { type: Number, default: 0 },
    },
  },
  {
    timestamps: false,
  }
);

export const RepoReportModel = mongoose.model<RepoReportDocument>(
  "RepoReport",
  RepoReportSchema
);
