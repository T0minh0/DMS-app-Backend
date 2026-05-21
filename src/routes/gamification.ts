import { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../prisma";
import { listLevels, readWorkerLevel } from "../lib/levels";
import { getWorkerMonthSummary } from "../lib/achievements";

const achievementsQuerySchema = z.object({
  yearMonth: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "yearMonth deve usar o formato YYYY-MM.")
    .optional(),
});

export const gamificationRoutes: FastifyPluginAsync = async (server) => {
  // Catalogo de niveis (definicoes). Somente leitura.
  server.get(
    "/levels",
    {
      preHandler: [server.authenticate],
    },
    async () => {
      return listLevels();
    },
  );

  // Nivel e XP do catador logado, calculados ao vivo a partir das conquistas
  // (variante somente-leitura — nao persiste WorkerLevel).
  server.get(
    "/me/level",
    {
      preHandler: [server.authenticate],
    },
    async (request) => {
      const workerId = BigInt(request.user.userId);

      const worker = await prisma.workers.findUnique({
        where: { workerId },
        select: { cooperative: true },
      });

      if (!worker) {
        throw server.httpErrors.notFound("Trabalhador não encontrado.");
      }

      return readWorkerLevel({
        workerId,
        cooperativeId: worker.cooperative,
      });
    },
  );

  // Conquistas do catador logado no mes (default: mes corrente). Somente leitura.
  server.get(
    "/me/achievements",
    {
      preHandler: [server.authenticate],
    },
    async (request) => {
      const workerId = BigInt(request.user.userId);

      const worker = await prisma.workers.findUnique({
        where: { workerId },
        select: { cooperative: true },
      });

      if (!worker) {
        throw server.httpErrors.notFound("Trabalhador não encontrado.");
      }

      const { yearMonth } = achievementsQuerySchema.parse(request.query);

      return getWorkerMonthSummary({
        workerId,
        cooperativeId: worker.cooperative,
        yearMonth,
      });
    },
  );
};
