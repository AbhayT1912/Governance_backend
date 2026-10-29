import { Response } from "express";

export const setNoStoreHeaders = (res: Response) => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
};
