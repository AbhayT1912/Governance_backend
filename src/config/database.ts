import mongoose from "mongoose";
import { ENV } from "./env";
import { logger } from "./logger";

export const connectDB = async (retries = 3) => {
  let attemptCount = 0;

  while (attemptCount < retries) {
    try {
      attemptCount++;
      
      logger.info(`Attempting MongoDB connection (attempt ${attemptCount}/${retries})`);

      await mongoose.connect(ENV.MONGO_URI, {
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 45000,
        retryWrites: true,
        w: "majority",
        maxPoolSize: 10,
        minPoolSize: 2,
      });

      logger.info("✅ MongoDB connected successfully");
      
      // Set up connection event handlers
      mongoose.connection.on("disconnected", () => {
        logger.warn("⚠️ MongoDB disconnected");
      });

      mongoose.connection.on("error", (err) => {
        logger.error("MongoDB connection error", { error: err.message });
      });

      return;
    } catch (error: any) {
      logger.error(`MongoDB connection attempt ${attemptCount} failed`, {
        error: error.message,
        code: error.code,
        name: error.name,
      });

      if (attemptCount < retries) {
        const waitTime = Math.min(1000 * Math.pow(2, attemptCount - 1), 10000);
        logger.info(`Retrying in ${waitTime}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        logger.error("❌ MongoDB connection failed after all retry attempts");
        logger.error("TROUBLESHOOTING STEPS:");
        logger.error("1. Check if MONGO_URI is correctly set in .env file");
        logger.error("2. Verify MongoDB Atlas cluster is running and network access is enabled");
        logger.error("3. Check if IP address is whitelisted in MongoDB Atlas");
        logger.error("4. Verify database credentials are correct");
        logger.error("5. Check network connectivity to MongoDB");
        process.exit(1);
      }
    }
  }
};
