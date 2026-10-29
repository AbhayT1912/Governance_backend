import mongoose, { Document, Schema } from "mongoose";
import { RepoStatus } from "../types/repo.types";

export interface RepoDocument extends Document {
  owner_id: { type: String, required: true };

  repo_url: string;
  status: RepoStatus;

  error_message?: string;

  file_count?: number;
  function_count?: number;

  // Security fields
  security_score?: number;
  security_findings_count?: number;
  critical_vulnerabilities?: number;

  started_at?: Date;
  completed_at?: Date;

  created_at: Date;
  updated_at: Date;
}

const RepoSchema = new Schema<RepoDocument>(
  {
    owner_id: { type: String, required: true },
    repo_url: { type: String, required: true, index: true },

    status: {
      type: String,
      enum: [
        "RECEIVED",
        "CLONING",
        "SCANNING",
        "PARSING",
        "GRAPHING",
        "INDEXING",
        "READY",
        "FAILED",
      ],
      required: true,
      index: true,
    },

    error_message: { type: String },

    file_count: { type: Number },
    function_count: { type: Number },

    // Security analysis metrics
    security_score: { type: Number, default: 100, min: 0, max: 100 },
    security_findings_count: { type: Number, default: 0 },
    critical_vulnerabilities: { type: Number, default: 0 },

    started_at: { type: Date },
    completed_at: { type: Date },
  },
  {
    timestamps: {
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
  }
);

// Allow same repo URL across different users; prevent duplicates only per user.
RepoSchema.index(
  { owner_id: 1, repo_url: 1 },
  { unique: true, name: "owner_repo_unique" }
);

export const RepoModel = mongoose.model<RepoDocument>(
  "Repository",
  RepoSchema
);
