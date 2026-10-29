import mongoose, { Document, Schema } from "mongoose";

export interface GraphEdgeDocument extends Document {
  repo_id: mongoose.Types.ObjectId;
  from_function_id: mongoose.Types.ObjectId;
  to_function_id: mongoose.Types.ObjectId;
  type: "CALL";
  created_at: Date;
}

const GraphEdgeSchema = new Schema<GraphEdgeDocument>(
  {
    repo_id: { type: Schema.Types.ObjectId, required: true, index: true },
    from_function_id: { type: Schema.Types.ObjectId, required: true },
    to_function_id: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, default: "CALL" },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: false },
  }
);

GraphEdgeSchema.index({
  repo_id: 1,
  from_function_id: 1,
  to_function_id: 1,
});

export const GraphEdgeModel = mongoose.model<GraphEdgeDocument>(
  "GraphEdge",
  GraphEdgeSchema
);
