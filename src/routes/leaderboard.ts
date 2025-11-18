import { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";

export const leaderboardRoutes: FastifyPluginAsync = async (server) => {
  server.get(
    "/top-collectors",
    {
      preHandler: [server.authenticate]
    },
    async (request) => {
      const workerId = BigInt(request.user.userId);

      const worker = await prisma.workers.findUnique({
        where: { workerId },
        select: {
          workerId: true,
          cooperative: true
        }
      });

      if (!worker?.cooperative) {
        throw server.httpErrors.badRequest(
          "Cooperativa não definida para o coletor autenticado."
        );
      }

      const aggregates = await prisma.measurments.groupBy({
        by: ["wastepicker"],
        where: {
          wastepickerRef: {
            cooperative: worker.cooperative
          }
        },
        _sum: {
          weightKg: true
        },
        _count: {
          _all: true
        }
      });

      if (aggregates.length === 0) {
        return [];
      }

      const workers = await prisma.workers.findMany({
        where: {
          workerId: {
            in: aggregates.map((aggregate) => aggregate.wastepicker)
          }
        },
        select: {
          workerId: true,
          workerName: true
        }
      });

      const workerMap = new Map(
        workers.map((collector) => [
          collector.workerId.toString(),
          collector.workerName
        ])
      );

      return aggregates
        .map((aggregate) => {
          const rawWeight =
            aggregate._sum.weightKg !== null
              ? new Prisma.Decimal(aggregate._sum.weightKg).toNumber()
              : 0;
          const totalWeightKg = Math.round(rawWeight * 100) / 100;

          return {
            workerId: aggregate.wastepicker.toString(),
            workerName:
              workerMap.get(aggregate.wastepicker.toString()) ?? "Coletor",
            totalWeightKg,
            totalWeighings: aggregate._count._all
          };
        })
        .sort((a, b) => b.totalWeightKg - a.totalWeightKg)
        .slice(0, 3);
    }
  );
};

