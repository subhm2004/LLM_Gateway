import { z } from "zod";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(v)));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().int());

const EnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: int(8080),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.string().default("info"),

  ADMIN_TOKEN: z.string().min(16, "ADMIN_TOKEN must be at least 16 characters"),

  DATABASE_URL: z.string().optional(),
  DATABASE_SSL_INSECURE: bool(false),
  SQLITE_PATH: z.string().default("./data/gateway.db"),

  GROQ_API_KEY: z.string().optional(),
  GROQ_BASE_URL: z.string().default("https://api.groq.com/openai/v1"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  ANTHROPIC_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().default("http://127.0.0.1:11434/v1"),
  OLLAMA_ENABLED: bool(false),

  PROVIDER_TIMEOUT_MS: int(30_000),

  REQUEST_DEADLINE_MS: int(70_000),

  MAX_RETRIES_PER_TARGET: int(1),
  RETRY_BASE_DELAY_MS: int(250),
  RETRY_MAX_DELAY_MS: int(4_000),

  BREAKER_FAILURE_THRESHOLD: int(5),
  BREAKER_COOLDOWN_MS: int(30_000),

  ESTIMATE_SAFETY_FACTOR: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 1.15 : Number(v)))
    .pipe(z.number().min(1)),

  RESERVATION_TTL_MS: int(120_000),
  RESERVATION_SWEEP_INTERVAL_MS: int(30_000),

  CACHE_ENABLED: bool(false),
  CACHE_MAX_ENTRIES: int(500),
  CACHE_TTL_MS: int(300_000),

  MODEL_CATALOG_PATH: z.string().default("./config/models.json"),
});

export type Config = z.infer<typeof EnvSchema> & { isProd: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.REQUEST_DEADLINE_MS <= cfg.PROVIDER_TIMEOUT_MS) {
    throw new Error(
      "REQUEST_DEADLINE_MS must exceed PROVIDER_TIMEOUT_MS, otherwise the chain " +
        "can never attempt a second target.",
    );
  }
  return { ...cfg, isProd: cfg.NODE_ENV === "production" };
}
