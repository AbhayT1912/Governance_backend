import { Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { UserModel } from "../models/user.model";

export const getMe = asyncHandler(async (req: any, res: Response) => {
  const user = await UserModel.findOne({ clerk_user_id: req.auth.userId }).lean();

  if (!user) {
    return res.status(404).json({
      success: false,
      message: "User not found",
    });
  }

  return res.status(200).json({
    success: true,
    data: user,
  });
});

export const patchMe = asyncHandler(async (req: any, res: Response) => {
  const updates = req.body;

  const user = await UserModel.findOneAndUpdate(
    { clerk_user_id: req.auth.userId },
    { $set: updates },
    { new: true }
  ).lean();

  if (!user) {
    return res.status(404).json({
      success: false,
      message: "User not found",
    });
  }

  return res.status(200).json({
    success: true,
    data: user,
  });
});
