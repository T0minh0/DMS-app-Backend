import { config } from "dotenv";
import { z } from "zod";

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
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required"),
  SHADOW_DATABASE_URL: z.string().optional(),
  JWT_SECRET: z
    .string()
    .min(32, "JWT_SECRET must be at least 32 characters for security")
});

export const env = envSchema.parse(process.env);

export type Environment = typeof env;


