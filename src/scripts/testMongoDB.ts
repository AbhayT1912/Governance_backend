import mongoose from "mongoose";
import { ENV } from "../config/env";
import { logger } from "../config/logger";

/**
 * Diagnostic script to test MongoDB connection and identify issues
 * Run with: npx ts-node src/scripts/testMongoDB.ts
 */
export const testMongoDBConnection = async () => {
  console.log("🔍 MongoDB Connection Diagnostic Tool\n");
  console.log("═".repeat(60));

  // Step 1: Check environment variables
  console.log("\n📋 STEP 1: Environment Variables Check");
  console.log("─".repeat(60));
  
  if (!process.env.MONGO_URI) {
    console.log("❌ MONGO_URI is not set in .env file");
    return;
  }

  const mongoUri = process.env.MONGO_URI;
  console.log("✅ MONGO_URI is set");

  // Parse connection string
  try {
    const url = new URL(mongoUri);
    console.log(`✅ Connection string format is valid`);
    console.log(`   Protocol: ${url.protocol}`);
    console.log(`   Host: ${url.hostname}`);
    console.log(`   Database: ${url.pathname.slice(1) || "(default)"}`);
  } catch (err: any) {
    console.log(`❌ Invalid connection string format: ${err.message}`);
    return;
  }

  // Step 2: Test DNS resolution
  console.log("\n🌐 STEP 2: DNS Resolution Test");
  console.log("─".repeat(60));
  
  try {
    const dns = require("dns").promises;
    const host = new URL(mongoUri).hostname;
    const addresses = await dns.resolve4(host);
    console.log(`✅ DNS resolved successfully`);
    console.log(`   IPs: ${addresses.join(", ")}`);
  } catch (err: any) {
    console.log(`❌ DNS resolution failed: ${err.message}`);
    console.log("   Fix: Check your internet connection or firewall settings");
    return;
  }

  // Step 3: Test MongoDB connection
  console.log("\n🔌 STEP 3: MongoDB Connection Test");
  console.log("─".repeat(60));
  
  try {
    console.log("Connecting to MongoDB...");
    const conn = await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 10000,
    });

    console.log("✅ MongoDB connected successfully!");
    console.log(`✅ Connection state: ${conn.connection.readyState === 1 ? "CONNECTED" : "DISCONNECTED"}`);
    
    // Get server info
    const admin = conn.connection.getClient().db("admin");
    const serverStatus = await admin.command({ buildInfo: 1 });
    console.log(`✅ MongoDB Version: ${serverStatus.version}`);

    await mongoose.disconnect();
    console.log("✅ Disconnected successfully");
  } catch (err: any) {
    console.log(`❌ MongoDB connection failed: ${err.message}`);
    console.log(`   Error Code: ${err.code}`);
    console.log(`   Error Name: ${err.name}`);
    
    // Provide specific solutions based on error
    if (err.message.includes("authentication failed")) {
      console.log("\n🔑 SOLUTION: Authentication Failed");
      console.log("   - Verify username and password are correct");
      console.log("   - Check if user exists in MongoDB Atlas");
      console.log("   - Verify user has permissions for this database");
    } else if (err.message.includes("ECONNREFUSED")) {
      console.log("\n🚫 SOLUTION: Connection Refused");
      console.log("   - Check if MongoDB server is running");
      console.log("   - Verify the hostname and port are correct");
      console.log("   - Check firewall settings");
    } else if (err.message.includes("connect ENOTFOUND")) {
      console.log("\n🌐 SOLUTION: Host Not Found");
      console.log("   - Check internet connection");
      console.log("   - Verify hostname is correct");
      console.log("   - Check if DNS is working properly");
    } else if (err.message.includes("IP address is not whitelisted")) {
      console.log("\n🛡️ SOLUTION: IP Whitelist Error");
      console.log("   - Go to MongoDB Atlas Console");
      console.log("   - Go to Network Access / IP Whitelist");
      console.log("   - Add your current IP address");
      console.log("   - Or add 0.0.0.0/0 to allow all IPs (not recommended for production)");
    }
    return;
  }

  console.log("\n" + "═".repeat(60));
  console.log("✅ All checks passed! MongoDB is properly configured.\n");
};

// Run if executed directly
if (require.main === module) {
  testMongoDBConnection().catch(console.error);
}
