// src/models/user.model.ts

import mongoose, { Schema, Document } from "mongoose";

export interface UserDocument extends Document {
  clerk_user_id: string;
  email: string;
  username?: string;
  bio?: string;
  location?: string;
  website?: string;
  credits: number; // Optional field for user credits
  created_at: Date;
  updated_at: Date;
  last_credit_reset: Date; // Optional field to track when credits were last reset
}

const UserSchema = new Schema<UserDocument>(
  {
    clerk_user_id: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    username: { type: String },
    bio: { type: String },
    location: { type: String },
    website: { type: String },
    credits: { type: Number, default: 500 },
    last_credit_reset: { type: Date, default: Date.now },
  },
  
  {
    timestamps: { createdAt: "created_at", updatedAt: "updated_at" },
  }
);

export const UserModel = mongoose.model<UserDocument>(
  "User",
  UserSchema
);
