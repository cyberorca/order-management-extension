import type { Schemas } from "./db/types.js";

export interface Config {
  databaseUrl: string;
  sessionSecret: string;
  tokenTtlSeconds: number;
  schemas: Schemas;
  enableMock: boolean;
}

/** Read and validate configuration from the environment (Vercel env vars in production). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const sessionSecret = env.SESSION_SECRET ?? "";
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  return {
    databaseUrl: env.DATABASE_URL,
    sessionSecret,
    tokenTtlSeconds: Number(env.TOKEN_TTL_SECONDS ?? 8 * 3600),
    schemas: { sidecar: env.SIDECAR_SCHEMA ?? "sidecar", mock: env.MOCK_SCHEMA ?? "mock" },
    enableMock: env.ENABLE_MOCK === "true",
  };
}
