import { Router } from "express";
import express from "express";
import { handleClerkWebhook } from "../../controllers/auth.controller";

const router = Router();

router.post("/clerk/webhook", express.raw({ type: "application/json" }), handleClerkWebhook);

export default router;
