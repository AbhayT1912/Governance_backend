import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { globalErrorHandler } from "./middleware/error.middleware";
import { ENV } from "./config/env";
import { logger } from "./config/logger";
import repoRoutes from "./routes/v1/repo.routes";
import securityRoutes from "./routes/v1/security.routes";
import authRoutes from "./routes/v1/auth.routes";
import { handleGitHubWebhook } from "./controllers/pr.controller";
import governanceRoutes from "./routes/v1/governance.routes";

const allowedOrigins = new Set(ENV.CORS_ORIGINS);
const corsOptions: cors.CorsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) {
      callback(null, true);
      return;
    }

    // Normalize origin: remove trailing slash
    const normalizedOrigin = origin.replace(/\/$/, "");
    
    // Normalize allowed origins: remove trailing slashes
    const normalizedAllowed = ENV.CORS_ORIGINS.map(o => o.replace(/\/$/, ""));

    if (normalizedAllowed.includes(normalizedOrigin)) {
      callback(null, true);
      return;
    }

    // Always allow localhost in development
    if (ENV.NODE_ENV === "development" && origin.includes("localhost")) {
      callback(null, true);
      return;
    }

    logger.warn("Blocked CORS origin", { 
      origin, 
      normalizedOrigin,
      allowed: normalizedAllowed 
    });
    callback(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Authorization", "Content-Type", "Accept"],
  credentials: true,
  maxAge: 86400 // 24 hours
};

const app = express();

/* ========================
   TRUST PROXY (for X-Forwarded-For headers from load balancers)
   IMPORTANT: Must be set BEFORE any middleware checks X-Forwarded-For
======================== */
app.set('trust proxy', 1);

/* ========================
   SECURITY MIDDLEWARE
======================== */

app.use(helmet({
  contentSecurityPolicy: false,
}));

app.set("etag", false);
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

/* ========================
   REGISTER WEBHOOK WITH RAW BODY PARSING
   (Must be BEFORE express.json() and rate limiter)
======================== */

// Use express.raw for webhook to capture raw body
app.post("/api/v1/webhook/github", express.raw({ type: 'application/json' }), (req: any, res: express.Response, next: express.NextFunction) => {
  // Store the raw body as string for signature verification
  req.rawBody = req.body.toString();
  // Parse JSON separately
  try {
    req.body = JSON.parse(req.rawBody);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  next();
}, handleGitHubWebhook);

app.use(express.json({ limit: "1mb" }));

/* ========================
   RATE LIMITER
======================== */

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000
});

app.use(limiter);

app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/governance", governanceRoutes);

/* ========================
   REQUEST LOGGING
======================== */

app.use(morgan("combined", {
  stream: {
    write: (message: string) => logger.info(message.trim())
  }
}));

/* ========================
   HEALTH CHECK
======================== */

app.get("/health", (_: express.Request, res: express.Response) => {
  res.status(200).json({
    status: "OK",
    environment: ENV.NODE_ENV
  });
});

app.get("/error-test", () => {
  throw new Error("Unexpected crash");
});

app.use("/api/v1", repoRoutes);

app.use("/api/v1/repos", securityRoutes);


app.use((req: express.Request, res: express.Response) => {
  return res.status(404).json({
    success: false,
    error: {
      message: "Route not found",
      status: 404,
    },
  });
});
/* ========================
   ERROR HANDLING
======================== */

app.use(globalErrorHandler);

export default app;
