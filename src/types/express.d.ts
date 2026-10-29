import { ActorIdentity } from "../governance/types";

declare global {
  namespace Express {
    interface Request {
      actor?: ActorIdentity;
    }
  }
}

export {};
