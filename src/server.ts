import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import jwt from "@fastify/jwt";
import { env } from "./env";
import { authRoutes } from "./routes/auth";
import { weighingsRoutes } from "./routes/weighings";
import { leaderboardRoutes } from "./routes/leaderboard";
import { materialsRoutes } from "./routes/materials";

export function buildServer() {
  const server = Fastify({
    logger:
      env.NODE_ENV === "production"
        ? true
        : {
            transport: {
              target: "pino-pretty",
              options: {
                singleLine: true,
                translateTime: "HH:MM:ss Z"
              }
            }
          }
  });

  void server.register(cors, {
    origin: true,
    credentials: true
  });

  void server.register(sensible);

  void server.register(jwt, {
    secret: env.JWT_SECRET,
    sign: {
      expiresIn: "7d"
    }
  });

  server.decorate(
    "authenticate",
    async function (request, reply) {
      try {
        await request.jwtVerify();
      } catch (error) {
        reply.send(error);
      }
    }
  );

  server.get("/health", async () => ({ status: "ok" }));

  void server.register(authRoutes, { prefix: "/auth" });
  void server.register(materialsRoutes, { prefix: "/materials" });
  void server.register(weighingsRoutes, { prefix: "/weighings" });
  void server.register(leaderboardRoutes, { prefix: "/leaderboard" });

  return server;
}


