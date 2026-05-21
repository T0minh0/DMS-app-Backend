// Portado de Web/DMS_NextJS_MGM/src/lib/achievements/service.ts.
// Apenas o SUBCONJUNTO DE LEITURA foi portado (resumo mensal de conquistas do
// catador). As funcoes de avaliacao/escrita do portal (`evaluateAchievements...`,
// `upsertAchievementProgress`, `updateAchievementXpOverride`) NAO foram portadas —
// o app mobile so consome. As partes portadas sao copia fiel do portal.
import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma";
import { decimalToJsonNumber } from "../decimal";

export const ACHIEVEMENT_TIME_ZONE = "America/Sao_Paulo";

type AchievementDbClient = typeof prisma | Prisma.TransactionClient;

type AchievementDefinitionRow = {
  achievementId: bigint;
  achievementKey: string;
  achievementName: string;
  description: string;
  category: string;
  thresholdValue: Prisma.Decimal;
  baseXpReward: number;
  difficulty: string;
  xpOverrides?: { xpRewardOverride: number }[];
  workerAchievements?: { progressValue: Prisma.Decimal; unlockedAt: Date | null }[];
};

export class AchievementDomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "AchievementDomainError";
  }
}

export interface WorkerMonthMetrics {
  totalWeightKg: number;
  daysWorked: number;
}

function formatDatePart(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function currentYearMonth(date = new Date(), timeZone = ACHIEVEMENT_TIME_ZONE) {
  return formatDatePart(date, timeZone).slice(0, 7);
}

export function normalizeYearMonth(
  yearMonth: string | null | undefined,
  now = new Date(),
  timeZone = ACHIEVEMENT_TIME_ZONE,
) {
  if (!yearMonth) {
    return currentYearMonth(now, timeZone);
  }

  const trimmed = yearMonth.trim();
  const match = /^(\d{4})-(\d{2})$/.exec(trimmed);
  if (!match) {
    throw new AchievementDomainError(
      "yearMonth deve usar o formato YYYY-MM",
      "INVALID_YEAR_MONTH",
      400,
    );
  }

  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new AchievementDomainError(
      "yearMonth deve ter mês entre 01 e 12",
      "INVALID_YEAR_MONTH",
      400,
    );
  }

  return trimmed;
}

export function getYearMonthDateRange(yearMonth: string) {
  const normalized = normalizeYearMonth(yearMonth);
  const [yearPart, monthPart] = normalized.split("-");
  const year = Number(yearPart);
  const monthIndex = Number(monthPart) - 1;

  return {
    start: new Date(Date.UTC(year, monthIndex, 1)),
    end: new Date(Date.UTC(year, monthIndex + 1, 1)),
  };
}

function effectiveXp(row: Pick<AchievementDefinitionRow, "baseXpReward" | "xpOverrides">) {
  return row.xpOverrides?.[0]?.xpRewardOverride ?? row.baseXpReward;
}

function formatAchievement(row: AchievementDefinitionRow) {
  const workerAchievement = row.workerAchievements?.[0] ?? null;
  const unlocked = Boolean(workerAchievement?.unlockedAt);

  return {
    achievementId: row.achievementId.toString(),
    achievementKey: row.achievementKey,
    achievementName: row.achievementName,
    description: row.description,
    category: row.category,
    thresholdValue: decimalToJsonNumber(row.thresholdValue),
    xpReward: effectiveXp(row),
    difficulty: row.difficulty,
    progressValue: workerAchievement
      ? decimalToJsonNumber(workerAchievement.progressValue)
      : 0,
    unlocked,
    unlockedAt: workerAchievement?.unlockedAt?.toISOString() ?? null,
  };
}

async function getWorkerOrThrow(
  db: AchievementDbClient,
  workerId: bigint,
  cooperativeId: bigint,
) {
  const worker = await db.workers.findFirst({
    where: { workerId, cooperative: cooperativeId },
    select: { workerId: true, workerName: true },
  });

  if (!worker) {
    throw new AchievementDomainError(
      "Trabalhador não encontrado na cooperativa",
      "WORKER_NOT_FOUND",
      404,
    );
  }

  return worker;
}

export async function getWorkerMonthMetrics(
  db: AchievementDbClient,
  workerId: bigint,
  yearMonth: string,
): Promise<WorkerMonthMetrics> {
  const { start, end } = getYearMonthDateRange(yearMonth);

  const [weightAggregate, dayRows] = await Promise.all([
    db.measurments.aggregate({
      where: {
        wastepicker: workerId,
        timeStamp: { gte: start, lt: end },
      },
      _sum: { weightKg: true },
    }),
    db.measurments.groupBy({
      by: ["timeStamp"],
      where: {
        wastepicker: workerId,
        timeStamp: { gte: start, lt: end },
      },
    }),
  ]);

  return {
    totalWeightKg: decimalToJsonNumber(weightAggregate._sum.weightKg ?? 0),
    daysWorked: dayRows.length,
  };
}

export async function getWorkerMonthSummary({
  workerId,
  cooperativeId,
  yearMonth,
  now = new Date(),
  db = prisma,
}: {
  workerId: bigint;
  cooperativeId: bigint;
  yearMonth?: string | null;
  now?: Date;
  db?: AchievementDbClient;
}) {
  const normalizedYearMonth = normalizeYearMonth(yearMonth, now);
  const worker = await getWorkerOrThrow(db, workerId, cooperativeId);
  const metrics = await getWorkerMonthMetrics(db, workerId, normalizedYearMonth);

  const rows = await db.achievementDefinition.findMany({
    include: {
      xpOverrides: {
        where: { cooperativeId },
        select: { xpRewardOverride: true },
        take: 1,
      },
      workerAchievements: {
        where: { workerId, cooperativeId, yearMonth: normalizedYearMonth },
        select: { progressValue: true, unlockedAt: true },
        take: 1,
      },
    },
    orderBy: [{ category: "asc" }, { thresholdValue: "asc" }],
  });

  const achievements = rows.map((row) => formatAchievement(row));
  const unlockedAchievements = achievements.filter((achievement) => achievement.unlocked);

  return {
    workerId: worker.workerId.toString(),
    workerName: worker.workerName,
    yearMonth: normalizedYearMonth,
    totalWeightKg: metrics.totalWeightKg,
    daysWorked: metrics.daysWorked,
    achievementsUnlocked: unlockedAchievements.length,
    totalXpEarned: unlockedAchievements.reduce(
      (sum, achievement) => sum + achievement.xpReward,
      0,
    ),
    achievements,
  };
}
