import mongoose, { Document, Schema } from "mongoose";

export interface FileDocument extends Document {
  repo_id: mongoose.Types.ObjectId;
  path: string;
  language: string;
  size: number;
  created_at: Date;
}

const FileSchema = new Schema<FileDocument>(
  {
    repo_id: {
      type: Schema.Types.ObjectId,
      ref: "Repository",
      required: true,
    },
    path: { type: String, required: true },
    language: { type: String, required: true },
    size: { type: Number, required: true },
  },
  {
    timestamps: { createdAt: "created_at", updatedAt: false },
  }
);

export const FileModel = mongoose.model<FileDocument>(
  "File",
  FileSchema
);
