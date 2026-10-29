import rateLimit from "express-rate-limit";

export const analyzeRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 analyze requests per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "Too many repository analyze requests. Please try later.",
  },
});
