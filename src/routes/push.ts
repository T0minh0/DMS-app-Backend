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
  platform: z.enum(["ios", "android"])
});

const deletePushTokenBodySchema = z.object({
  token: z.string().trim().min(1, "Token invalido.")
});

export const pushRoutes: FastifyPluginAsync = async (server) => {
  server.post(
    "/push-token",
    {
      preHandler: [server.authenticate]
    },
    async (request) => {
      const workerId = BigInt(request.user.userId);
      const body = pushTokenBodySchema.parse(request.body);

      // Upsert por token. Se o token ja existir vinculado a outro worker,
      // transfere para o atual (usuario trocou de conta no mesmo device).
      await prisma.workerPushToken.upsert({
        where: { token: body.token },
        update: {
          workerId,
          platform: body.platform,
          lastSeen: new Date()
        },
        create: {
          workerId,
          token: body.token,
          platform: body.platform
        }
      });

      return { status: "ok" };
    }
  );

  server.delete(
    "/push-token",
    {
      preHandler: [server.authenticate]
    },
    async (request) => {
      const workerId = BigInt(request.user.userId);
      const body = deletePushTokenBodySchema.parse(request.body);

      // Deleta apenas se o token pertencer ao worker logado — evita que um
      // request mal intencionado apague tokens de outro user.
      await prisma.workerPushToken.deleteMany({
        where: {
          token: body.token,
          workerId
        }
      });

      return { status: "ok" };
    }
  );
};
