import { Request, Response } from "express";
import { verifyWebhook, WebhookEvent } from "@clerk/backend/webhooks";
import { ENV } from "../config/env";
import { upsertUserFromWebhookData } from "../services/userProvision.service";

const getHeaderValue = (value: string | string[] | undefined) => {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
};

export const handleClerkWebhook = async (req: Request, res: Response) => {
  if (!Buffer.isBuffer(req.body)) {
    return res.status(400).json({ message: "Expected raw webhook payload" });
  }

  const payload = req.body.toString("utf8");

  const svixId = getHeaderValue(req.headers["svix-id"]);
  const svixTimestamp = getHeaderValue(req.headers["svix-timestamp"]);
  const svixSignature = getHeaderValue(req.headers["svix-signature"]);

  if (!svixId || !svixTimestamp || !svixSignature) {
    return res.status(400).json({ message: "Missing Svix headers" });
  }

  const headers = new Headers();
  headers.set("svix-id", svixId);
  headers.set("svix-timestamp", svixTimestamp);
  headers.set("svix-signature", svixSignature);
  headers.set("content-type", "application/json");

  const request = new Request("http://localhost/api/v1/auth/clerk/webhook", {
    method: "POST",
    headers,
    body: payload,
  });

  let event: WebhookEvent;
  try {
    event = (await verifyWebhook(request, {
      signingSecret: ENV.CLERK_WEBHOOK_SECRET,
    })) as WebhookEvent;
  } catch (error) {
    return res.status(401).json({ message: "Invalid webhook signature" });
  }

  try {
    if (event.type === "user.created" || event.type === "user.updated") {
      await upsertUserFromWebhookData(event.data);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    return res.status(500).json({ message: "Failed to process webhook event" });
  }
};
