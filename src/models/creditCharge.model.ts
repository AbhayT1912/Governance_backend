import mongoose, { Schema, Document } from "mongoose";

export interface CreditChargeDocument extends Document {
  user_id: string;
  repo_id: string;
  feature_key: string;
  cost: number;
  charged_at: Date;
}

const CreditChargeSchema = new Schema<CreditChargeDocument>(
  {
    user_id: { type: String, required: true, index: true },
    repo_id: { type: String, required: true, index: true },
    feature_key: { type: String, required: true, index: true },
    cost: { type: Number, required: true },
    charged_at: { type: Date, default: Date.now },
  },
  {
    timestamps: false,
  }
);

CreditChargeSchema.index(
  { user_id: 1, repo_id: 1, feature_key: 1 },
  { unique: true }
);

export const CreditChargeModel = mongoose.model<CreditChargeDocument>(
  "CreditCharge",
  CreditChargeSchema
);
