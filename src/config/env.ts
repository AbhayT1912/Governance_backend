import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default("5000"),
  NODE_ENV: z.string(),
  MAX_REPO_SIZE_MB: z.string().default("500"),
  CLONE_TIMEOUT: z.string().default("60000"),
  TEMP_DIR_PATH: z.string().default("/tmp/repos"),
  MONGO_URI: z.string(),
  CLERK_SECRET_KEY: z.string(),
  CLERK_WEBHOOK_SECRET: z.string(),
  GOVERNANCE_ADMIN_USER_IDS: z.string().default(""),
  REDIS_URL: z.string().optional(), // Cloud deployments like Heroku
  RAG_SERVICE_TOKEN: z.string().min(32).optional(),
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173,https://repolens-sage.vercel.app"),
}).superRefine((values, context) => {
  if (values.NODE_ENV === "production" && !values.RAG_SERVICE_TOKEN) {
    context.addIssue({
      code: "custom",
      path: ["RAG_SERVICE_TOKEN"],
      message: "RAG_SERVICE_TOKEN is required in production.",
    });
  }
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment variables", parsed.error.format());
  process.exit(1);
}

export const ENV = {
  PORT: Number(parsed.data.PORT),
  NODE_ENV: parsed.data.NODE_ENV,
  MAX_REPO_SIZE_MB: Number(parsed.data.MAX_REPO_SIZE_MB),
  CLONE_TIMEOUT: Number(parsed.data.CLONE_TIMEOUT),
  TEMP_DIR_PATH: parsed.data.TEMP_DIR_PATH,
  MONGO_URI: parsed.data.MONGO_URI,
  CLERK_SECRET_KEY: parsed.data.CLERK_SECRET_KEY,
  CLERK_WEBHOOK_SECRET: parsed.data.CLERK_WEBHOOK_SECRET,
  GOVERNANCE_ADMIN_USER_IDS: parsed.data.GOVERNANCE_ADMIN_USER_IDS.split(",")
    .map((userId) => userId.trim())
    .filter(Boolean),
  REDIS_URL: parsed.data.REDIS_URL,
  RAG_SERVICE_TOKEN: parsed.data.RAG_SERVICE_TOKEN,
  CORS_ORIGINS: parsed.data.CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
};
