import winston from "winston";
import { ENV } from "./env";

const transports: winston.transport[] = [
  new winston.transports.Console(),
];

if (ENV.NODE_ENV === "production") {
  transports.push(
    new winston.transports.File({
      filename: "logs/app.log",
    })
  );
}

export const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports,
});
