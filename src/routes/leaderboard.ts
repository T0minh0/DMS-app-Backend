import { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../prisma";
import {
  buildRankingResponse,
  computeLiveRanking,
  getCurrentLeaderboardPeriod,
  getCurrentLeaderboardYearMonth,
  getLeaderboardMonthRange,
  getLeaderboardWeekRange,
  normalizeLeaderboardYearMonth,
  resolveHistoryWeeks,
} from "../lib/leaderboard";

const rankingQuerySchema = z.object({
  period: z.enum(["week", "month", "history"]).default("week"),
  yearMonth: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "yearMonth deve usar o formato YYYY-MM.")
    .optional(),
  weekNumber: z.coerce.number().int().min(1).max(4).optional(),
});

export const leaderboardRoutes: FastifyPluginAsync = async (server) => {
  // GET /leaderboard/ranking — ranking oficial por XP da gamificacao.
  // Calcula o ranking COMPLETO ao vivo (o portal so persiste o top-3 em snapshots)
  // e devolve top-3 + a posicao do catador logado + o total de participantes.
  // Filtro `period`: week (semana corrente ou informada), month (mes), history
  // (todas as semanas de um mes). Somente leitura.
  server.get(
    "/ranking",
    {
      preHandler: [server.authenticate],
    },
    async (request) => {
      const workerId = BigInt(request.user.userId);

      const worker = await prisma.workers.findUnique({
        where: { workerId },
        select: { cooperative: true },
      });

      if (!worker?.cooperative) {
        throw server.httpErrors.badRequest(
          "Cooperativa não definida para o catador autenticado.",
        );
      }

      const cooperativeId = worker.cooperative;
      const {
        period,
        yearMonth: rawYearMonth,
        weekNumber: rawWeekNumber,
      } = rankingQuerySchema.parse(request.query);
      const now = new Date();

      if (period === "history") {
        const yearMonth = rawYearMonth
          ? normalizeLeaderboardYearMonth(rawYearMonth)
          : getCurrentLeaderboardYearMonth(now);
        const weeks = resolveHistoryWeeks(yearMonth, now);

        const blocks = await Promise.all(
          weeks.map(async (weekNumber) => {
            const { start, endExclusive } = getLeaderboardWeekRange(
              yearMonth,
              weekNumber,
            );
            const ranked = await computeLiveRanking({
              cooperativeId,
              start,
              endExclusive,
              yearMonth,
            });
            return { weekNumber, ...buildRankingResponse(ranked, workerId) };
          }),
        );

        return { period, yearMonth, weeks: blocks };
      }

      if (period === "month") {
        const yearMonth = rawYearMonth
          ? normalizeLeaderboardYearMonth(rawYearMonth)
          : getCurrentLeaderboardYearMonth(now);
        const { start, endExclusive } = getLeaderboardMonthRange(yearMonth);
        const ranked = await computeLiveRanking({
          cooperativeId,
          start,
          endExclusive,
          yearMonth,
        });

        return {
          period,
          yearMonth,
          ...buildRankingResponse(ranked, workerId),
        };
      }

      // period === "week"
      let yearMonth: string;
      let weekNumber: number;
      if (rawYearMonth) {
        yearMonth = normalizeLeaderboardYearMonth(rawYearMonth);
        weekNumber = rawWeekNumber ?? 1;
      } else {
        const current = getCurrentLeaderboardPeriod(now);
        yearMonth = current.yearMonth;
        weekNumber = rawWeekNumber ?? current.weekNumber;
      }

      const { start, endExclusive } = getLeaderboardWeekRange(
        yearMonth,
        weekNumber,
      );
      const ranked = await computeLiveRanking({
        cooperativeId,
        start,
        endExclusive,
        yearMonth,
      });

      return {
        period,
        yearMonth,
        weekNumber,
        ...buildRankingResponse(ranked, workerId),
      };
    },
  );

  // DEPRECATED: GET /leaderboard/top-collectors — ranking por SOMA DE PESO (kg),
  // sem XP/gamificacao. Mantido por uma release para nao quebrar o app atual.
  // Use /leaderboard/ranking. Remover quando o app migrar.
  server.get(
    "/top-collectors",
    {
      preHandler: [server.authenticate],
    },
    async (request) => {
      request.log.warn(
        { route: "/leaderboard/top-collectors" },
        "Rota depreciada chamada — migrar o app para /leaderboard/ranking.",
      );

      const workerId = BigInt(request.user.userId);

      const worker = await prisma.workers.findUnique({
        where: { workerId },
        select: {
          workerId: true,
          cooperative: true,
        },
      });

      if (!worker?.cooperative) {
        throw server.httpErrors.badRequest(
          "Cooperativa não definida para o coletor autenticado.",
        );
      }

      const aggregates = await prisma.measurments.groupBy({
        by: ["wastepicker"],
        where: {
          wastepickerRef: {
            cooperative: worker.cooperative,
          },
        },
        _sum: {
          weightKg: true,
        },
        _count: {
          _all: true,
        },
      });

      if (aggregates.length === 0) {
        return [];
      }

      const workers = await prisma.workers.findMany({
        where: {
          workerId: {
            in: aggregates.map((aggregate) => aggregate.wastepicker),
          },
        },
        select: {
          workerId: true,
          workerName: true,
        },
      });

      const workerMap = new Map(
        workers.map((collector) => [
          collector.workerId.toString(),
          collector.workerName,
        ]),
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
            totalWeighings: aggregate._count._all,
          };
        })
        .sort((a, b) => b.totalWeightKg - a.totalWeightKg)
        .slice(0, 3);
    },
  );
};
