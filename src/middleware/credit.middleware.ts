import { UserModel } from "../models/user.model";
import { CreditChargeModel } from "../models/creditCharge.model";
import { CREDITS_LIMIT } from "../config/creditPolicy.config";

const resetCreditsIfNeeded = async (userId: string) => {
  const user = await UserModel.findOne({ clerk_user_id: userId }).lean();
  if (!user) {
    return false;
  }

  const now = new Date();
  const lastReset = user.last_credit_reset || new Date(0);
  const hoursSinceReset =
    (now.getTime() - lastReset.getTime()) / (1000 * 60 * 60);

  if (hoursSinceReset >= 24) {
    await UserModel.updateOne(
      { clerk_user_id: userId },
      {
        $set: {
          credits: CREDITS_LIMIT,
          last_credit_reset: now,
        },
      }
    );
  }

  return true;
};

export const deductUserCredits = async (userId: string, cost: number) => {
  const userExists = await resetCreditsIfNeeded(userId);
  if (!userExists) {
    return { ok: false, status: 401, message: "User not found" };
  }

  const result = await UserModel.updateOne(
    {
      clerk_user_id: userId,
      credits: { $gte: cost },
    },
    {
      $inc: { credits: -cost },
    }
  );

  if (result.modifiedCount === 0) {
    return {
      ok: false,
      status: 403,
      message: "Insufficient credits. Please upgrade your plan.",
    };
  }

  return { ok: true as const };
};

export const deductCredits = (cost: number) => {
  return async (req: any, res: any, next: any) => {
    const userId = req.auth.userId;
    const deduction = await deductUserCredits(userId, cost);

    if (!deduction.ok) {
      return res.status(deduction.status).json({ message: deduction.message });
    }

    next();
  };
};

export const deductCreditsOncePerRepoFeature = (
  featureKey: string,
  cost: number
) => {
  return async (req: any, res: any, next: any) => {
    const userId = req.auth.userId;
    const repoId = req.params.repoId;

    if (!repoId) {
      return res.status(400).json({ message: "Repository ID is required" });
    }

    const reserveResult = await CreditChargeModel.updateOne(
      { user_id: userId, repo_id: repoId, feature_key: featureKey },
      {
        $setOnInsert: {
          cost,
          charged_at: new Date(),
        },
      },
      { upsert: true }
    );

    if (reserveResult.upsertedCount === 0) {
      return next();
    }

    const deduction = await deductUserCredits(userId, cost);
    if (!deduction.ok) {
      await CreditChargeModel.deleteOne({
        user_id: userId,
        repo_id: repoId,
        feature_key: featureKey,
      });
      return res.status(deduction.status).json({ message: deduction.message });
    }

    next();
  };
};
