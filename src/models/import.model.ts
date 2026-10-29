import mongoose, { Document, Schema } from "mongoose";

export interface ImportDocument extends Document {
  repo_id: mongoose.Types.ObjectId;
  file_id: mongoose.Types.ObjectId;

  source: string;           // "./utils/helper"
  specifiers: string[];     // ["useState", "useEffect"]
  is_external: boolean;     // true if from "react"
}

const ImportSchema = new Schema<ImportDocument>(
  {
    repo_id: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    file_id: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    source: {
      type: String,
      required: true,
    },
    specifiers: [
      {
        type: String,
      },
    ],
    is_external: {
      type: Boolean,
      required: true,
    },
  },
  { timestamps: true }
);

export const ImportModel = mongoose.model<ImportDocument>(
  "Import",
  ImportSchema
);
