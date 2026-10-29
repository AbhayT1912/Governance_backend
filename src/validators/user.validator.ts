import { z } from "zod";

export const patchMeBodySchema = z.object({
  username: z.string().trim().min(1).max(50).optional(),
  bio: z.string().trim().max(500).optional(),
  location: z.string().trim().max(100).optional(),
  website: z
    .string()
    .trim()
    .max(200)
    .refine((value) => {
      if (!value) return true;
      return /^https?:\/\/.+/i.test(value);
    }, "Website must be a valid http(s) URL")
    .optional(),
});
