import { config } from "dotenv";
import { z } from "zod";
import { parseTrustedProxyCidrs } from "./lib/auth/trusted-proxies";

config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z
    .coerce.number({
      message: "PORT must be a valid number"
    })
    .int()
    .min(1)
    .max(65535)
    .default(3333),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required"),
  SHADOW_DATABASE_URL: z.string().optional(),
  DMS_TRUSTED_PROXY_CIDRS: z.string().optional().refine(value => {
    try { parseTrustedProxyCidrs(value); return true; } catch { return false; }
  }, "DMS_TRUSTED_PROXY_CIDRS must contain explicit valid IP addresses or CIDRs, without /0"),
  DMS_TRUSTED_CLIENT_IP_HEADER: z.enum(["cf-connecting-ip"]).optional(),
  AUTH_PROXY_SECRET: z.string().min(32).optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  RECOVERY_EMAIL_FROM: z.string().min(1).optional(),
  RECOVERY_WEB_URL: z.string().url().refine(value => new URL(value).protocol === "https:", "RECOVERY_WEB_URL must use HTTPS").optional(),
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters for security")
});

export const env = envSchema.parse(process.env);

export type Environment = typeof env;


