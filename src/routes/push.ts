import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";

/**
 * Rotas para registrar/remover Expo push tokens do usuario autenticado.
 *
 * Modelo: um worker pode ter varios tokens (multiplos devices). O token em si
 * eh unico no banco — se o mesmo device for usado por outro usuario, o
 * upsert atualiza o `workerId` (transferencia de propriedade do device).
 */

const pushTokenBodySchema = z.object({
  token: z.string().trim().min(1, "Token invalido."),
  platform: z.enum(["ios", "android"]),
});

const deletePushTokenBodySchema = z.object({
  token: z.string().trim().min(1, "Token invalido."),
});

export const pushRoutes: FastifyPluginAsync = async (server) => {
  server.post(
    "/push-token",
    {
      preHandler: [server.authenticate],
    },
    async (request) => {
      const workerId = BigInt(request.user.userId);
      const body = pushTokenBodySchema.parse(request.body);

      await prisma.$transaction(async (tx) => {
        // Use the same worker -> session lock order as credential recovery.
        // Authentication may have completed before logout/password revocation;
        // recheck ownership and version inside the transaction that commits push.
        await tx.$queryRaw`SELECT "Worker_id" FROM "Workers" WHERE "Worker_id" = ${workerId} FOR UPDATE`;
        const worker = await tx.workers.findUnique({
          where: { workerId },
          select: { authVersion: true },
        });
        if (!worker || worker.authVersion !== (request.user.authVersion ?? 0))
          throw server.httpErrors.unauthorized("Sessão inválida.");
        if (request.user.sessionVersion === 2) {
          const sid = request.user.sid;
          if (!sid) throw server.httpErrors.unauthorized("Sessão inválida.");
          await tx.$queryRaw`SELECT "id" FROM "AuthRefreshSession" WHERE "id" = ${sid} FOR UPDATE`;
          const session = await tx.authRefreshSession.findUnique({
            where: { id: sid },
          });
          if (
            !session ||
            session.revokedAt ||
            session.expiresAt <= new Date() ||
            session.workerId !== workerId ||
            session.authVersion !== worker.authVersion
          )
            throw server.httpErrors.unauthorized("Sessão inválida.");
        }
        // Legacy JWTs have no revocable session row; retain version-checked
        // registration for old clients. All new mobile logins request v2.
        await tx.workerPushToken.upsert({
          where: { token: body.token },
          update: { workerId, platform: body.platform, lastSeen: new Date() },
          create: { workerId, token: body.token, platform: body.platform },
        });
      });

      return { status: "ok" };
    },
  );

  server.delete(
    "/push-token",
    {
      preHandler: [server.authenticate],
    },
    async (request) => {
      const workerId = BigInt(request.user.userId);
      const body = deletePushTokenBodySchema.parse(request.body);

      // Deleta apenas se o token pertencer ao worker logado — evita que um
      // request mal intencionado apague tokens de outro user.
      await prisma.workerPushToken.deleteMany({
        where: {
          token: body.token,
          workerId,
        },
      });

      return { status: "ok" };
    },
  );
};
