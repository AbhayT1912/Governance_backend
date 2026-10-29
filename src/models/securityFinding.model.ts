import mongoose, { Document, Schema } from "mongoose";

export interface SecurityFindingDocument extends Document {
  repo_id: mongoose.Types.ObjectId;
  
  type: "SECRET" | "CVE" | "MALICIOUS_PATTERN" | "BAD_PRACTICE" | "LICENSE_ISSUE";
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  
  title: string;
  description: string;
  
  file_path?: string;
  line_number?: number;
  
  pattern?: string;
  evidence?: string;
  
  impact: string;
  remediation: string;
  
  // For CVE findings
  cve_id?: string;
  affected_package?: string;
  affected_version?: string;
  available_fix?: string;
  source_url?: string;
  
  // For license issues
  license_name?: string;
  license_type?: string;
  is_compliant?: boolean;
  
  // For malicious patterns
  pattern_type?: string;
  context_lines?: string;
  
  status: "OPEN" | "ACKNOWLEDGED" | "MITIGATED" | "RESOLVED";
  
  detected_at: Date;
  resolved_at?: Date;
  
  created_at: Date;
  updated_at: Date;
}

const SecurityFindingSchema = new Schema<SecurityFindingDocument>(
  {
    repo_id: {
      type: Schema.Types.ObjectId,
      ref: "Repository",
      required: true,
      index: true,
    },
    
    type: {
      type: String,
      enum: ["SECRET", "CVE", "MALICIOUS_PATTERN", "BAD_PRACTICE", "LICENSE_ISSUE"],
      required: true,
      index: true,
    },
    
    severity: {
      type: String,
      enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
      required: true,
      index: true,
    },
    
    title: { type: String, required: true },
    description: { type: String, required: true },
    
    file_path: { type: String },
    line_number: { type: Number },
    
    pattern: { type: String },
    evidence: { type: String },
    
    impact: { type: String, required: true },
    remediation: { type: String, required: true },
    
    // CVE fields
    cve_id: { type: String },
    affected_package: { type: String },
    affected_version: { type: String },
    available_fix: { type: String },
    source_url: { type: String },
    
    // License fields
    license_name: { type: String },
    license_type: { type: String },
    is_compliant: { type: Boolean },
    
    // Malicious pattern fields
    pattern_type: { type: String },
    context_lines: { type: String },
    
    status: {
      type: String,
      enum: ["OPEN", "ACKNOWLEDGED", "MITIGATED", "RESOLVED"],
      default: "OPEN",
    },
    
    detected_at: {
      type: Date,
      default: Date.now,
    },
    resolved_at: { type: Date },
  },
  {
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  }
);

// Indexes for efficient querying
SecurityFindingSchema.index({ repo_id: 1, severity: 1 });
SecurityFindingSchema.index({ repo_id: 1, type: 1 });
SecurityFindingSchema.index({ repo_id: 1, status: 1 });

export const SecurityFindingModel = mongoose.model<SecurityFindingDocument>(
  "SecurityFinding",
  SecurityFindingSchema
);
