import mongoose, { Document, Schema } from "mongoose";

export interface FunctionDocument extends Document {
  repo_id: mongoose.Types.ObjectId;
  file_id: mongoose.Types.ObjectId;
  name: string;
  start_line: number;
  end_line: number;
  is_dead?: boolean;
  depth?: number;
  component_id?: string;
  complexity?: number;
  is_entry?: boolean;
  centrality_score?: number;
  outgoing_calls?: mongoose.Types.ObjectId[];   // ✅ ADDED
  created_at: Date;
}

const FunctionSchema = new Schema<FunctionDocument>(
  {
    repo_id: {
      type: Schema.Types.ObjectId,
      ref: "Repository",
      required: true,
    },
    file_id: {
      type: Schema.Types.ObjectId,
      ref: "File",
      required: true,
    },
    name: { type: String, required: true },
    start_line: { type: Number, required: true },
    end_line: { type: Number, required: true },
    is_dead: { type: Boolean, default: false },
    depth: { type: Number },
    component_id: { type: String },
    complexity: { type: Number, default: 1 },
    is_entry: { type: Boolean, default: false },
    centrality_score: { type: Number, default: 0 },

    // ✅ THIS IS THE CRITICAL FIELD
    outgoing_calls: [
      {
        type: Schema.Types.ObjectId,
        ref: "Function",
      },
    ],
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: false },
  }
);

export const FunctionModel = mongoose.model<FunctionDocument>(
  "Function",
  FunctionSchema
);