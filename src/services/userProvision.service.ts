import { createClerkClient } from "@clerk/backend";
import { ENV } from "../config/env";
import { UserModel } from "../models/user.model";
import { CREDITS_LIMIT } from "../config/creditPolicy.config";

const clerkClient = createClerkClient({
  secretKey: ENV.CLERK_SECRET_KEY,
});

type UserUpsertInput = {
  clerkUserId: string;
  email: string;
};

const resolvePrimaryEmail = (emails: any[], primaryId?: string | null): string | null => {
  if (!Array.isArray(emails) || emails.length === 0) {
    return null;
  }

  if (primaryId) {
    const primaryEmail = emails.find((email) => {
      return email?.id === primaryId;
    });

    const matchedEmail = primaryEmail?.emailAddress ?? primaryEmail?.email_address;
    if (matchedEmail) {
      return matchedEmail;
    }
  }

  const firstEmail = emails[0];
  return firstEmail?.emailAddress ?? firstEmail?.email_address ?? null;
};

export const upsertUser = async ({ clerkUserId, email }: UserUpsertInput) => {
  return UserModel.findOneAndUpdate(
    { clerk_user_id: clerkUserId },
    {
      $set: { email },
      $setOnInsert: {
        credits: CREDITS_LIMIT,
        last_credit_reset: new Date(),
      },
    },
    {
      upsert: true,
      new: true,
    }
  );
};

export const upsertUserFromWebhookData = async (userData: any) => {
  const clerkUserId = userData?.id;
  const email = resolvePrimaryEmail(
    userData?.email_addresses,
    userData?.primary_email_address_id
  );

  if (!clerkUserId || !email) {
    throw new Error("Webhook user payload is missing id or primary email");
  }

  return upsertUser({
    clerkUserId,
    email,
  });
};

export const ensureUserProvisioned = async (clerkUserId: string) => {
  const existingUser = await UserModel.findOne({ clerk_user_id: clerkUserId }).lean();

  if (existingUser) {
    return existingUser;
  }

  const clerkUser = await clerkClient.users.getUser(clerkUserId);
  const email = resolvePrimaryEmail(
    clerkUser.emailAddresses,
    clerkUser.primaryEmailAddressId
  );

  if (!email) {
    throw new Error("Clerk user does not have a primary email");
  }

  return upsertUser({
    clerkUserId,
    email,
  });
};
