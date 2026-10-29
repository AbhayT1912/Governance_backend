import mongoose, { Document, Schema } from "mongoose";

export interface PRIssue {
  file: string;
  line: number;
  message: string;
  type: 'complexity' | 'architecture' | 'dead_code' | 'security' | 'performance' | 'quality';
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  suggestion?: string;
}

export interface PRFileImpact {
  file: string;
  change_type: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed';
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  risk_points: number;
  summary: string;
  merge_impact: string;
  recommendation?: string;
}

export interface PRAnalysisDocument extends Document {
  repo_id: mongoose.Types.ObjectId;
  pr_number: number;
  pr_title: string;
  pr_url: string;
  github_pr_id: number;
  
  files_changed: number;
  files_analyzed: string[];
  
  issues: PRIssue[];
  file_impacts?: PRFileImpact[];
  issue_summary: {
    total: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  
  complexity_delta: number;
  architecture_violations_count: number;
  dead_code_introduced: boolean;
  security_issues: number;
  
  overall_risk_score: number;
  ai_review?: string;
  criticality_reduction_fixes?: string[];
  github_comment_id?: string;
  github_comment_body?: string;
  analyzed_at: Date;
  created_at: Date;
  updated_at: Date;
}

const PRAnalysisSchema = new Schema<PRAnalysisDocument>(
  {
    repo_id: {
      type: Schema.Types.ObjectId,
      ref: "Repository",
      required: true,
      index: true,
    },
    pr_number: { type: Number, required: true },
    pr_title: { type: String },
    pr_url: { type: String },
    github_pr_id: { type: Number, unique: true },
    
    files_changed: { type: Number, default: 0 },
    files_analyzed: [{ type: String }],
    
    issues: [{
      file: String,
      line: Number,
      message: String,
      type: { 
        type: String, 
        enum: ['complexity', 'architecture', 'dead_code', 'security', 'performance', 'quality'],
        default: 'quality'
      },
      severity: {
        type: String,
        enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
        default: 'MEDIUM'
      },
      suggestion: String,
    }],

    file_impacts: [{
      file: String,
      change_type: {
        type: String,
        enum: ['added', 'modified', 'removed', 'renamed', 'copied', 'changed'],
        default: 'modified',
      },
      severity: {
        type: String,
        enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
        default: 'LOW',
      },
      risk_points: { type: Number, default: 0 },
      summary: String,
      merge_impact: String,
      recommendation: String,
    }],
    
    issue_summary: {
      total: { type: Number, default: 0 },
      critical: { type: Number, default: 0 },
      high: { type: Number, default: 0 },
      medium: { type: Number, default: 0 },
      low: { type: Number, default: 0 },
    },
    
    complexity_delta: { type: Number, default: 0 },
    architecture_violations_count: { type: Number, default: 0 },
    dead_code_introduced: { type: Boolean, default: false },
    security_issues: { type: Number, default: 0 },
    
    overall_risk_score: { type: Number, default: 0, min: 0, max: 100 },
    ai_review: { type: String },
    criticality_reduction_fixes: [{ type: String }],
    github_comment_id: String,
    github_comment_body: String,
    analyzed_at: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
  }
);

// Compound index for unique PR analysis per repo
PRAnalysisSchema.index({ repo_id: 1, pr_number: 1 }, { unique: false });

export const PRAnalysisModel = mongoose.model<PRAnalysisDocument>(
  "PRAnalysis",
  PRAnalysisSchema
);
