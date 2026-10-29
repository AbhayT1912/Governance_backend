import mongoose, { Document, Schema } from "mongoose";

export interface CallDocument extends Document {
  repo_id: mongoose.Types.ObjectId;
  file_id: mongoose.Types.ObjectId;

  caller_function_id: mongoose.Types.ObjectId;
  callee_function_id: mongoose.Types.ObjectId;

  start_line: number;
}

const CallSchema = new Schema<CallDocument>(
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
    caller_function_id: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    callee_function_id: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    start_line: {
      type: Number,
      required: true,
    },
  },
  { timestamps: true }
);

CallSchema.index({
  repo_id: 1,
  caller_function_id: 1,
  callee_function_id: 1,
});

export const CallModel = mongoose.model<CallDocument>(
  "Call",
  CallSchema
);