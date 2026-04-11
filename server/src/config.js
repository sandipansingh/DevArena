const { z } = require("zod");

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  CLIENT_ORIGIN: z.string().default("http://localhost:5173"),
  JWT_SECRET: z.string().min(16).default("devarena-local-secret-key"),
  MONGODB_URI: z.string().optional(),
  AI_ENABLED: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().optional(),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(120),
  DISCONNECT_GRACE_MS: z.coerce.number().int().positive().default(15_000),
  CHAT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(4_000),
  CHAT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(8),
  SUBMIT_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(8_000),
  SUBMIT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  FAIRNESS_POLICY: z.enum(["timer-only", "early-finish"]).default("timer-only"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error(
    "Invalid environment configuration",
    parsed.error.flatten().fieldErrors,
  );
  process.exit(1);
}

const config = parsed.data;

function getCorsOrigins() {
  return config.CLIENT_ORIGIN.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

module.exports = {
  config,
  getCorsOrigins,
};
