// Portado de Web/DMS_NextJS_MGM/src/lib/leaderboard/service.ts.
// As funcoes de data/periodo, a formula de XP (`calculateLeaderboardEntries`) e as
// queries SQL (`fetchWeightScores`, `fetchAchievementXpByWorker`, `getRandomMultiplier`)
// sao COPIA FIEL do portal — qualquer alteracao quebra a paridade de numeros entre o
// app do catador e o portal do gerente.
//
// Diferencas em relacao ao portal:
//  - `fetchWeightScores` recebe um intervalo de datas direto (start/endExclusive),
//    em vez de (yearMonth, weekNumber), para reaproveitar no filtro "mes".
//  - Funcoes novas: `getLeaderboardMonthRange`, `getCurrentLeaderboardYearMonth`,
//    `resolveHistoryWeeks`, `computeLiveRanking`, `buildRankingResponse` — calculam o
//    ranking COMPLETO ao vivo (o portal so persiste o top-3 em snapshots).
import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma";
import { decimalToJsonNumber, toDecimal } from "../decimal";

type LeaderboardDbClient = typeof prisma | Prisma.TransactionClient;

export const LEADERBOARD_TIME_ZONE = "America/Sao_Paulo";
// Workers tambem guarda contas de admin/gerente; o ranking considera apenas catadores ativos.
const WORKER_USER_TYPES = ["1", "C", "W"];

export class LeaderboardDomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "LeaderboardDomainError";
  }
}

export interface LeaderboardPeriod {
  yearMonth: string;
  weekNumber: number;
}

export interface LeaderboardScoreInput {
  workerId: bigint;
  workerName: string;
  weightXp: Prisma.Decimal | string | number;
  achievementXp?: Prisma.Decimal | string | number | null;
}

export interface LeaderboardEntryDraft {
  rankPosition: number;
  workerId: bigint;
  workerName: string;
  rawXp: Prisma.Decimal;
  finalXp: Prisma.Decimal;
  randomMult: Prisma.Decimal;
}

interface LeaderboardWeightRow {
  workerId: bigint;
  workerName: string;
  weightXp: string;
}

interface LeaderboardAchievementRow {
  workerId: bigint;
  achievementXp: string;
}

function formatDatePart(date: Date, timeZone = LEADERBOARD_TIME_ZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getTimeZoneOffsetMs(date: Date, timeZone = LEADERBOARD_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );

  return asUtc - date.getTime();
}

function zonedMidnightUtc(year: number, monthIndex: number, day: number) {
  const guess = new Date(Date.UTC(year, monthIndex, day));
  const offset = getTimeZoneOffsetMs(guess);
  const candidate = new Date(guess.getTime() - offset);
  const candidateOffset = getTimeZoneOffsetMs(candidate);

  return candidateOffset === offset
    ? candidate
    : new Date(guess.getTime() - candidateOffset);
}

function yearMonthDate(yearMonth: string) {
  const [yearPart, monthPart] = normalizeLeaderboardYearMonth(yearMonth).split("-");
  return {
    year: Number(yearPart),
    monthIndex: Number(monthPart) - 1,
  };
}

function formatUtcYearMonth(year: number, monthIndex: number) {
  const date = new Date(Date.UTC(year, monthIndex, 1));
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");

  return `${date.getUTCFullYear()}-${month}`;
}

export function normalizeLeaderboardYearMonth(yearMonth: string | null | undefined) {
  if (!yearMonth) {
    throw new LeaderboardDomainError(
      "yearMonth é obrigatório",
      "MISSING_YEAR_MONTH",
      400,
    );
  }

  const trimmed = yearMonth.trim();
  const match = /^(\d{4})-(\d{2})$/.exec(trimmed);
  if (!match) {
    throw new LeaderboardDomainError(
      "yearMonth deve usar o formato YYYY-MM",
      "INVALID_YEAR_MONTH",
      400,
    );
  }

  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new LeaderboardDomainError(
      "yearMonth deve ter mês entre 01 e 12",
      "INVALID_YEAR_MONTH",
      400,
    );
  }

  return trimmed;
}

export function parseLeaderboardWeekNumber(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") {
    throw new LeaderboardDomainError(
      "weekNumber é obrigatório",
      "MISSING_WEEK_NUMBER",
      400,
    );
  }

  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 4) {
    throw new LeaderboardDomainError(
      "weekNumber deve estar entre 1 e 4",
      "INVALID_WEEK_NUMBER",
      400,
    );
  }

  return parsed;
}

export function getLeaderboardWeekRange(yearMonth: string, weekNumber: number) {
  const normalizedWeek = parseLeaderboardWeekNumber(weekNumber);
  const { year, monthIndex } = yearMonthDate(yearMonth);

  const startDayByWeek: Record<number, number> = {
    1: 1,
    2: 8,
    3: 15,
    4: 22,
  };

  const start = zonedMidnightUtc(year, monthIndex, startDayByWeek[normalizedWeek]);
  const endExclusive =
    normalizedWeek === 4
      ? zonedMidnightUtc(year, monthIndex + 1, 1)
      : zonedMidnightUtc(year, monthIndex, startDayByWeek[normalizedWeek + 1]);

  return { start, endExclusive };
}

export function getCurrentLeaderboardPeriod(now = new Date()): LeaderboardPeriod {
  const dateKey = formatDatePart(now);
  const [yearPart, monthPart, dayPart] = dateKey.split("-");
  const year = Number(yearPart);
  const monthIndex = Number(monthPart) - 1;
  const day = Number(dayPart);

  if (day <= 7) {
    return {
      yearMonth: formatUtcYearMonth(year, monthIndex - 1),
      weekNumber: 4,
    };
  }

  return {
    yearMonth: `${yearPart}-${monthPart}`,
    weekNumber: day <= 14 ? 1 : day <= 21 ? 2 : day <= 28 ? 3 : 4,
  };
}

// --- Novo: intervalo de um mes inteiro (filtro "month" do app mobile) ---
export function getLeaderboardMonthRange(yearMonth: string) {
  const { year, monthIndex } = yearMonthDate(yearMonth);
  return {
    start: zonedMidnightUtc(year, monthIndex, 1),
    endExclusive: zonedMidnightUtc(year, monthIndex + 1, 1),
  };
}

// --- Novo: mes corrente no fuso do ranking (YYYY-MM) ---
export function getCurrentLeaderboardYearMonth(now = new Date()) {
  return formatDatePart(now).slice(0, 7);
}

// --- Novo: semanas a exibir no modo "history" de um dado mes ---
export function resolveHistoryWeeks(yearMonth: string, now = new Date()): number[] {
  const normalized = normalizeLeaderboardYearMonth(yearMonth);
  const currentYearMonth = getCurrentLeaderboardYearMonth(now);

  if (normalized > currentYearMonth) {
    return [];
  }

  if (normalized < currentYearMonth) {
    return [1, 2, 3, 4];
  }

  const day = Number(formatDatePart(now).slice(8, 10));
  const currentWeek = day <= 7 ? 1 : day <= 14 ? 2 : day <= 21 ? 3 : 4;
  return Array.from({ length: currentWeek }, (_, index) => index + 1);
}

// Formula de XP — COPIA FIEL do portal. NAO alterar.
export function calculateLeaderboardEntries(
  scores: LeaderboardScoreInput[],
  randomMultiplier: Prisma.Decimal | string | number,
  limit = 3,
): LeaderboardEntryDraft[] {
  const randomMult = toDecimal(randomMultiplier, "randomMultiplier")
    .toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP);

  return scores
    .map((score) => {
      const weightXp = toDecimal(score.weightXp, "weightXp");
      const achievementXp = toDecimal(score.achievementXp ?? 0, "achievementXp");
      const rawXp = weightXp
        .plus(achievementXp)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      const finalXp = rawXp
        .times(randomMult)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

      return {
        rankPosition: 0,
        workerId: score.workerId,
        workerName: score.workerName,
        rawXp,
        finalXp,
        randomMult,
      };
    })
    .sort((left, right) => {
      const byFinalXp = right.finalXp.comparedTo(left.finalXp);
      if (byFinalXp !== 0) return byFinalXp;

      const byRawXp = right.rawXp.comparedTo(left.rawXp);
      if (byRawXp !== 0) return byRawXp;

      return left.workerId < right.workerId ? -1 : left.workerId > right.workerId ? 1 : 0;
    })
    .slice(0, limit)
    .map((entry, index) => ({
      ...entry,
      rankPosition: index + 1,
    }));
}

// Soma de peso x multiplicador de material — COPIA FIEL do SQL do portal.
// Diferenca: recebe o intervalo de datas direto, para servir semana E mes.
async function fetchWeightScores({
  cooperativeId,
  start,
  endExclusive,
  db,
}: {
  cooperativeId: bigint;
  start: Date;
  endExclusive: Date;
  db: LeaderboardDbClient;
}) {
  return db.$queryRaw<LeaderboardWeightRow[]>`
    SELECT
      w."Worker_id" AS "workerId",
      w."Worker_name" AS "workerName",
      COALESCE(SUM(m."Weight_KG" * COALESCE(cmm."multiplier_value", 1.0)), 0)::text AS "weightXp"
    FROM "Workers" w
    LEFT JOIN "Measurments" m
      ON m."Wastepicker" = w."Worker_id"
      AND m."Time_stamp" >= ${start}
      AND m."Time_stamp" < ${endExclusive}
    LEFT JOIN "cooperative_material_multiplier" cmm
      ON cmm."cooperative_id" = w."Cooperative"
      AND cmm."material_id" = m."Material"
    WHERE w."Cooperative" = ${cooperativeId}
      AND w."Exit_date" IS NULL
      AND w."User_type" IN (${Prisma.join(WORKER_USER_TYPES)})
    GROUP BY w."Worker_id", w."Worker_name"
  `;
}

// XP de conquistas por trabalhador no mes — COPIA FIEL do SQL do portal.
async function fetchAchievementXpByWorker({
  cooperativeId,
  yearMonth,
  db,
}: {
  cooperativeId: bigint;
  yearMonth: string;
  db: LeaderboardDbClient;
}) {
  const rows = await db.$queryRaw<LeaderboardAchievementRow[]>`
    SELECT
      wa."worker_id" AS "workerId",
      COALESCE(SUM(COALESCE(axo."xp_reward_override", ad."base_xp_reward")), 0)::text AS "achievementXp"
    FROM "worker_achievement" wa
    JOIN "achievement_definition" ad
      ON ad."achievement_id" = wa."achievement_id"
    LEFT JOIN "achievement_xp_override" axo
      ON axo."achievement_id" = wa."achievement_id"
      AND axo."cooperative_id" = ${cooperativeId}
    WHERE wa."cooperative_id" = ${cooperativeId}
      AND wa."year_month" = ${yearMonth}
      AND wa."unlocked_at" IS NOT NULL
    GROUP BY wa."worker_id"
  `;

  return new Map(rows.map((row) => [row.workerId.toString(), row.achievementXp]));
}

// Multiplicador aleatorio do periodo — COPIA FIEL da logica do portal.
async function getRandomMultiplier({
  cooperativeId,
  yearMonth,
  db,
}: {
  cooperativeId: bigint;
  yearMonth: string;
  db: LeaderboardDbClient;
}) {
  const historical = await db.cooperativeRandomMultiplierHistory.findUnique({
    where: {
      cooperativeId_yearMonth: {
        cooperativeId,
        yearMonth,
      },
    },
    select: { multiplierValue: true },
  });

  if (historical) {
    return historical.multiplierValue;
  }

  const current = await db.cooperativeRandomMultiplier.findUnique({
    where: { cooperativeId },
    select: { multiplierValue: true, lastUpdated: true },
  });

  if (
    current &&
    formatUtcYearMonth(
      current.lastUpdated.getUTCFullYear(),
      current.lastUpdated.getUTCMonth(),
    ) === yearMonth
  ) {
    return current.multiplierValue;
  }

  return new Prisma.Decimal(1);
}

// --- Novo: ranking COMPLETO ao vivo (todos os catadores, com rankPosition 1..N) ---
// O portal so persiste o top-3 em LeaderboardEntry; aqui recalculamos tudo para
// conseguir a posicao de qualquer catador no ranking.
export async function computeLiveRanking({
  cooperativeId,
  start,
  endExclusive,
  yearMonth,
  db = prisma,
}: {
  cooperativeId: bigint;
  start: Date;
  endExclusive: Date;
  yearMonth: string;
  db?: LeaderboardDbClient;
}): Promise<LeaderboardEntryDraft[]> {
  const [weightRows, achievementXpByWorker, randomMultiplier] = await Promise.all([
    fetchWeightScores({ cooperativeId, start, endExclusive, db }),
    fetchAchievementXpByWorker({ cooperativeId, yearMonth, db }),
    getRandomMultiplier({ cooperativeId, yearMonth, db }),
  ]);

  const scores: LeaderboardScoreInput[] = weightRows.map((row) => ({
    workerId: row.workerId,
    workerName: row.workerName,
    weightXp: row.weightXp,
    achievementXp: achievementXpByWorker.get(row.workerId.toString()) ?? 0,
  }));

  // limit = scores.length => nao corta no top-3; classifica todo mundo.
  return calculateLeaderboardEntries(scores, randomMultiplier, scores.length);
}

function formatRankedEntry(entry: LeaderboardEntryDraft) {
  return {
    rankPosition: entry.rankPosition,
    workerId: entry.workerId.toString(),
    workerName: entry.workerName,
    xp: decimalToJsonNumber(entry.finalXp, 2, "xp"),
    rawXp: decimalToJsonNumber(entry.rawXp, 2, "rawXp"),
    finalXp: decimalToJsonNumber(entry.finalXp, 2, "finalXp"),
  };
}

export interface RankingResponseBlock {
  topThree: ReturnType<typeof formatRankedEntry>[];
  currentUser: ReturnType<typeof formatRankedEntry> | null;
  totalParticipants: number;
}

// --- Novo: monta a resposta (top-3 + posicao do catador logado + total) ---
export function buildRankingResponse(
  ranked: LeaderboardEntryDraft[],
  viewerWorkerId: bigint,
): RankingResponseBlock {
  const viewer = ranked.find((entry) => entry.workerId === viewerWorkerId);

  return {
    topThree: ranked.slice(0, 3).map(formatRankedEntry),
    currentUser: viewer ? formatRankedEntry(viewer) : null,
    totalParticipants: ranked.length,
  };
}
