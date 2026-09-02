import { pino } from "pino";

export function createLogger(level: string, pretty: boolean) {
  return pino({
    level,
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers['x-api-key']",
        "req.headers.cookie",
        "*.apiKey",
        "*.api_key",
        "*.key_hash",
        "apiKey",
        "authorization",
      ],
      censor: "[redacted]",
    },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? { transport: { target: "pino/file", options: { destination: 1 } } }
      : {}),
  });
}

export type Logger = ReturnType<typeof createLogger>;
