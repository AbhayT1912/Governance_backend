import { Queue } from "bullmq";
import IORedis from "ioredis";
import { ENV } from "./env";
import { logger } from "./logger";

export type QueueMode = "redis" | "degraded";

let redisConnection: IORedis | null = null;
let repoQueue: Queue | null = null;
let redisAvailable = false;
let queueMode: QueueMode = "degraded";

export const getBullQueueConnectionOptions = () => {
  if (ENV.REDIS_URL) {
    const redisUrl = new URL(ENV.REDIS_URL);
    const database = redisUrl.pathname.replace(/^\//, "");
    return {
      host: redisUrl.hostname,
      port: Number(redisUrl.port || (redisUrl.protocol === "rediss:" ? 6380 : 6379)),
      username: redisUrl.username ? decodeURIComponent(redisUrl.username) : undefined,
      password: redisUrl.password ? decodeURIComponent(redisUrl.password) : undefined,
      db: database ? Number(database) : undefined,
      tls: redisUrl.protocol === "rediss:" ? {} : undefined,
      maxRetriesPerRequest: null,
    };
  }
  return {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT || 6379),
    maxRetriesPerRequest: null,
  };
};

export const setQueueMode = (nextMode: QueueMode) => {
  queueMode = nextMode;
};

const setRedisAvailability = (available: boolean) => {
  redisAvailable = available;
  queueMode = available ? "redis" : "degraded";
};

const isIpv4Address = (hostname: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);

const isLikelyInternalOnlyRedisUrl = (redisUrl: string) => {
  try {
    const hostname = new URL(redisUrl).hostname;

    if (hostname === "localhost" || isIpv4Address(hostname)) {
      return false;
    }

    return /^red-[a-z0-9]+$/i.test(hostname) && !hostname.includes(".");
  } catch {
    return false;
  }
};

const attachRedisEventListeners = (connection: IORedis, source: "cloud" | "local") => {
  connection.on("ready", () => {
    if (redisAvailable) return;

    setRedisAvailability(true);
    logger.info("Redis connection ready", { source });
  });

  connection.on("end", () => {
    if (!redisAvailable) return;

    setRedisAvailability(false);
    logger.warn("Redis connection closed - falling back to degraded mode", {
      source,
    });
  });

  connection.on("error", (error) => {
    if (!redisAvailable) return;

    setRedisAvailability(false);
    logger.error("Redis connection error - falling back to degraded mode", {
      error: error.message,
      source,
    });
  });
};

export const initializeQueue = async () => {
  if (redisConnection && repoQueue && redisAvailable) {
    return true;
  }

  if (ENV.REDIS_URL) {
    if (
      ENV.NODE_ENV === "development" &&
      isLikelyInternalOnlyRedisUrl(ENV.REDIS_URL)
    ) {
      logger.warn(
        "REDIS_URL appears to be an internal-only Redis host. Use the provider's external connection string for local development."
      );
      setRedisAvailability(false);
      redisConnection = null;
      repoQueue = null;
      return false;
    }

    const connection = new IORedis(ENV.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      connectTimeout: 10000,
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });

    attachRedisEventListeners(connection, "cloud");

    try {
      await connection.connect();
      await connection.ping();

      redisConnection = connection;
      repoQueue = new Queue("repo-processing", { connection: getBullQueueConnectionOptions() });
      setRedisAvailability(true);
      logger.info("Redis queue initialized with REDIS_URL");
      return true;
    } catch (error) {
      logger.warn("Failed to initialize Redis queue with REDIS_URL", {
        error: error instanceof Error ? error.message : String(error),
      });
      setRedisAvailability(false);
      repoQueue = null;
      connection.disconnect();
      redisConnection = null;
      return false;
    }
  }

  const connection = new IORedis({
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT || 6379),
    maxRetriesPerRequest: null,
    connectTimeout: 3000,
    lazyConnect: true,
    retryStrategy: () => null,
  });

  attachRedisEventListeners(connection, "local");

  try {
    await connection.connect();
    await connection.ping();

    redisConnection = connection;
    repoQueue = new Queue("repo-processing", { connection: getBullQueueConnectionOptions() });
    setRedisAvailability(true);
    logger.info("Redis queue initialized with local Redis");
    return true;
  } catch (error) {
    logger.info("Redis not available - using synchronous processing", {
      error: error instanceof Error ? error.message : String(error),
    });
    setRedisAvailability(false);
    repoQueue = null;
    connection.disconnect();
    redisConnection = null;
    return false;
  }
};

export { redisConnection, repoQueue, redisAvailable, queueMode };
