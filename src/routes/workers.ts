import { FastifyPluginAsync } from "fastify";
import { prisma } from "../prisma";
import { requireRole } from "../lib/requireRole";
import { mapUserTypeToRole } from "../lib/userType";

/**
 * Rotas para listagem de trabalhadores.
 *
 * Hoje so existe `GET /workers/wastepickers` — usado pelo app mobile para o
 * gestor escolher a quem atribuir uma pesagem. So gestores podem chamar.
 */
export const workersRoutes: FastifyPluginAsync = async (server) => {
  server.get(
    "/wastepickers",
    {
      preHandler: [server.authenticate, requireRole("manager")]
    },
    async (request) => {
      const managerId = BigInt(request.user.userId);

      const manager = await prisma.workers.findUnique({
        where: { workerId: managerId },
        select: { cooperative: true }
      });

      if (!manager?.cooperative) {
        throw server.httpErrors.badRequest(
          "Cooperativa nao encontrada para o gestor autenticado."
        );
      }

      const workers = await prisma.workers.findMany({
        where: {
          cooperative: manager.cooperative,
          exitDate: null
        },
        select: {
          workerId: true,
          workerName: true,
          userType: true
        },
        orderBy: {
          workerName: "asc"
        }
      });

      // Filtra para apenas catadores — gestores nao devem aparecer aqui.
      return workers
        .filter((w) => mapUserTypeToRole(w.userType) === "worker")
        .map((w) => ({
          id: w.workerId.toString(),
          name: w.workerName
        }));
    }
  );
};
