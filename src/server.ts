import Fastify from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import jwt from "@fastify/jwt";
import { ZodError } from "zod";
import { env } from "./env";
import { authRoutes } from "./routes/auth";
import { weighingsRoutes } from "./routes/weighings";
import { leaderboardRoutes } from "./routes/leaderboard";
import { materialsRoutes } from "./routes/materials";
import { noticesRoutes } from "./routes/notices";
import { birthdaysRoutes } from "./routes/birthdays";
import { gamificationRoutes } from "./routes/gamification";

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

  // Tratamento de erros: mapeia erros de validacao (zod) e de dominio (camadas
  // src/lib) para os status HTTP corretos, em vez do 500 generico.
  server.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: "Dados inválidos.",
        code: "VALIDATION_ERROR",
        issues: error.issues
      });
    }

    const err = error as {
      message?: unknown;
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
    };
    const message =
      typeof err.message === "string" ? err.message : "Erro inesperado.";
    const domainCode = typeof err.code === "string" ? err.code : undefined;

    // LeaderboardDomainError / LevelDomainError / AchievementDomainError
    // carregam `code` (string) e `status` (number).
    if (typeof err.status === "number" && domainCode) {
      return reply.status(err.status).send({
        error: message,
        code: domainCode
      });
    }

    // Erros HTTP do @fastify/sensible (server.httpErrors.*) trazem statusCode.
    if (typeof err.statusCode === "number" && err.statusCode < 500) {
      return reply.status(err.statusCode).send({
        error: message,
        code: domainCode ?? "HTTP_ERROR"
      });
    }

    request.log.error(error);
    return reply.status(500).send({
      error: "Erro interno do servidor.",
      code: "INTERNAL_ERROR"
    });
  });

  server.get("/health", async () => ({ status: "ok" }));

  void server.register(authRoutes, { prefix: "/auth" });
  void server.register(materialsRoutes, { prefix: "/materials" });
  void server.register(weighingsRoutes, { prefix: "/weighings" });
  void server.register(leaderboardRoutes, { prefix: "/leaderboard" });
  void server.register(noticesRoutes, { prefix: "/notices" });
  void server.register(birthdaysRoutes, { prefix: "/birthdays" });
  void server.register(gamificationRoutes, { prefix: "/gamification" });

  return server;
}
