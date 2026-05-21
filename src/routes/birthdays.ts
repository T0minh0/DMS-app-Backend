import { FastifyPluginAsync } from "fastify";
import { prisma } from "../prisma";

// userType in Workers tambem aceita variantes maiusculas/minusculas para catador.
// Espelha exatamente o filtro de Web/.../src/app/api/birthdays/route.ts.
const WORKER_USER_TYPES = ["1", "W", "w", "C", "c"];

export const birthdaysRoutes: FastifyPluginAsync = async (server) => {
  // Aniversariantes do mes corrente, escopados a cooperativa do catador logado.
  // Somente leitura.
  server.get(
    "/",
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

      const rows = await prisma.workers.findMany({
        where: {
          userType: { in: WORKER_USER_TYPES },
          cooperative: worker.cooperative,
        },
        select: {
          workerName: true,
          birthDate: true,
        },
        orderBy: { birthDate: "asc" },
      });

      const currentMonth = new Date().getMonth() + 1;

      return rows
        .filter((row) => row.birthDate.getMonth() + 1 === currentMonth)
        .map((row) => {
          const birthDate = new Date(row.birthDate);
          const day = String(birthDate.getDate()).padStart(2, "0");
          const month = String(birthDate.getMonth() + 1).padStart(2, "0");

          return {
            name: row.workerName,
            date: `${day}/${month}`,
          };
        });
    },
  );
};
