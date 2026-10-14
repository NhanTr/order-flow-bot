import { existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";

function findUp(filename: string, startDirectory: string): string | undefined {
  let directory = resolve(startDirectory);
  const root = parse(directory).root;
  while (true) {
    const candidate = join(directory, filename);
    if (existsSync(candidate)) return candidate;
    if (directory === root) return undefined;
    directory = dirname(directory);
  }
}

const envPath = process.env.ENV_FILE ?? findUp(".env.local", process.cwd());

if (envPath) {
  loadDotenv({ path: envPath, quiet: true });
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().max(65_535).default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().refine(
    (value) => value.startsWith("redis://") || value.startsWith("rediss://"),
    "REDIS_URL must use redis:// or rediss://",
  ),
  API_PROXY_SECRET: z.string().min(32),
  TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(15 * 60),
  JWT_REFRESH_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 24 * 60 * 60),
  BOT_INTERNAL_SECRET: z.union([z.literal(""), z.string().min(32)]).default(""),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_AUTH_MAX_AGE_SECONDS: z.coerce.number().int().positive().default(5 * 60),
}).superRefine((env, context) => {
  const secrets = [
    ["JWT_ACCESS_SECRET", env.JWT_ACCESS_SECRET],
    ["JWT_REFRESH_SECRET", env.JWT_REFRESH_SECRET],
    ["API_PROXY_SECRET", env.API_PROXY_SECRET],
    ...(env.BOT_INTERNAL_SECRET
      ? [["BOT_INTERNAL_SECRET", env.BOT_INTERNAL_SECRET] as const]
      : []),
  ] as const;
  for (let left = 0; left < secrets.length; left += 1) {
    for (let right = left + 1; right < secrets.length; right += 1) {
      if (secrets[left][1] === secrets[right][1]) {
        context.addIssue({
          code: "custom",
          path: [secrets[right][0]],
          message: `${secrets[right][0]} must be distinct from ${secrets[left][0]}`,
        });
      }
    }
  }
});

export type AppEnv = z.infer<typeof envSchema>;

export function parseAppEnv(input: NodeJS.ProcessEnv): AppEnv {
  return envSchema.parse(input);
}

let cachedEnv: AppEnv | undefined;

export function getEnv(): AppEnv {
  cachedEnv ??= parseAppEnv(process.env);
  return cachedEnv;
}
