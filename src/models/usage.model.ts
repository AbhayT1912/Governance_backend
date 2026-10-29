import mongoose, { Schema, Document } from "mongoose";

export interface UsageDocument extends Document {
  user_id: string;
  analyses_count: number;
  ai_tokens_used: number;
  ai_queries_count: number;
  ai_model_tokens_used: number;
  ai_usage_metric_version: number;
  pdf_downloads: number;
  last_credit_reset: Date;
  credits: number;
  created_at: Date;
}

const UsageSchema = new Schema<UsageDocument>(
  {
    user_id: { type: String, required: true, unique: true },
    analyses_count: { type: Number, default: 0 },
    ai_tokens_used: { type: Number, default: 0 },
    ai_queries_count: { type: Number, default: 0 },
    ai_model_tokens_used: { type: Number, default: 0 },
    ai_usage_metric_version: { type: Number, default: 2 },
    pdf_downloads: { type: Number, default: 0 },
    last_credit_reset: { type: Date, default: Date.now },
    credits: { type: Number, default: 100 },
  },
  { timestamps: { createdAt: "created_at", updatedAt: false } }
);

export const UsageModel = mongoose.model<UsageDocument>(
  "Usage",
  UsageSchema
);
