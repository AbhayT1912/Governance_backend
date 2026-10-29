import { Request, Response, NextFunction } from "express";
import { AppError } from "../utils/AppError";

export const globalErrorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  let statusCode = 500;
  let message = "Internal Server Error";

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
  } else if (err?.name === "PolicyViolationError") {
    statusCode = 403;
    message = err.message || "Blocked by governance policy.";
  } else if (err.message) {
    message = err.message;
  }

  return res.status(statusCode).json({
    success: false,
    message, // Add top-level message for frontend compatibility
    error: {
      message,
      status: statusCode,
      ...(err?.name === "PolicyViolationError" ? { policy_ids: err.policyIds || [] } : {}),
    },
  });
};
