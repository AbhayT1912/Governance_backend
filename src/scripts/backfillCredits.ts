import mongoose from "mongoose";
import { connectDB } from "../config/database";
import { CREDITS_LIMIT } from "../config/creditPolicy.config";
import { UserModel } from "../models/user.model";

const run = async () => {
  await connectDB();

  const now = new Date();

  const result = await UserModel.updateMany(
    {
      $or: [{ credits: { $lt: CREDITS_LIMIT } }, { last_credit_reset: { $exists: false } }],
    },
    {
      $set: {
        credits: CREDITS_LIMIT,
        last_credit_reset: now,
      },
    }
  );

  console.log(
    JSON.stringify({
      matched: result.matchedCount,
      modified: result.modifiedCount,
      credits_limit: CREDITS_LIMIT,
    })
  );
};

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
