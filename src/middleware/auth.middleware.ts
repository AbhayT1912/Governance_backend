import { verifyToken } from "@clerk/backend";
import { Request, Response, NextFunction } from "express";
import { ENV } from "../config/env";
import { ensureUserProvisioned } from "../services/userProvision.service";

export const requireAuth = async (
  req: any,
  res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const token = authHeader.split(" ")[1];

    const payload = await verifyToken(token, {
      secretKey: ENV.CLERK_SECRET_KEY,
    });

    if (!payload.sub) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    try {
      await ensureUserProvisioned(payload.sub);
    } catch (error: any) {
      const status = typeof error?.status === "number" ? error.status : null;
      if (status === 401 || status === 404) {
        return res.status(401).json({ message: "Unauthorized user profile" });
      }

      return res.status(500).json({ message: "Failed to sync authenticated user" });
    }

    req.auth = {
      userId: payload.sub,
    };
    req.actor = { id: payload.sub, type: "user" };

    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};
