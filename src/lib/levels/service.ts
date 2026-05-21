// Portado de Web/DMS_NextJS_MGM/src/lib/levels/service.ts.
// COPIA FIEL do portal, exceto:
//  - imports do prisma ajustados;
//  - `recalculateWorkerLevel`/`getWorkerLevel` (que fazem upsert em WorkerLevel) NAO
//    foram portados — um endpoint mobile GET nao deve escrever no banco. Em vez disso
//    expomos `readWorkerLevel`, que calcula o XP/nivel ao vivo sem persistir.
import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma";

type LevelDbClient = typeof prisma | Prisma.TransactionClient;

export class LevelDomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "LevelDomainError";
  }
}

export interface LevelDefinitionLike {
  levelNumber: number;
  levelName: string;
  xpRequired: number;
}

export interface FormatWorkerLevelInput {
  workerId: bigint;
  totalXp: number;
  currentLevel: LevelDefinitionLike;
  nextLevel?: LevelDefinitionLike | null;
}

function formatLevelDefinition(level: LevelDefinitionLike) {
  return {
    levelNumber: level.levelNumber,
    levelName: level.levelName,
    xpRequired: level.xpRequired,
    xpToNext: 0,
    workerId: null,
    totalXp: 0,
    currentLevel: false,
  };
}

export function pickCurrentLevel(
  levels: LevelDefinitionLike[],
  totalXp: number,
) {
  if (levels.length === 0) {
    throw new LevelDomainError("Nenhum nível cadastrado", "LEVEL_DEFINITIONS_MISSING", 500);
  }

  const ordered = [...levels].sort((a, b) => a.levelNumber - b.levelNumber);
  let current = ordered[0]!;

  for (const level of ordered) {
    if (level.xpRequired <= totalXp) {
      current = level;
    }
  }

  return current;
}

export function getNextLevel(
  levels: LevelDefinitionLike[],
  currentLevelNumber: number,
) {
  return levels
    .filter((level) => level.levelNumber > currentLevelNumber)
    .sort((a, b) => a.levelNumber - b.levelNumber)[0] ?? null;
}

export function calculateXpToNext(totalXp: number, nextLevel?: LevelDefinitionLike | null) {
  if (!nextLevel) {
    return 0;
  }

  return Math.max(0, nextLevel.xpRequired - totalXp);
}

export function formatWorkerLevel({
  workerId,
  totalXp,
  currentLevel,
  nextLevel,
}: FormatWorkerLevelInput) {
  return {
    levelNumber: currentLevel.levelNumber,
    levelName: currentLevel.levelName,
    xpRequired: currentLevel.xpRequired,
    xpToNext: calculateXpToNext(totalXp, nextLevel),
    workerId: workerId.toString(),
    totalXp,
    currentLevel: true,
  };
}

export async function listLevels(db: LevelDbClient = prisma) {
  const levels = await db.levelDefinition.findMany({
    orderBy: { levelNumber: "asc" },
  });

  return levels.map((level) => formatLevelDefinition(level));
}

async function findWorkerOrThrow(
  db: LevelDbClient,
  workerId: bigint,
  cooperativeId: bigint,
) {
  const worker = await db.workers.findFirst({
    where: { workerId, cooperative: cooperativeId },
    select: { workerId: true },
  });

  if (!worker) {
    throw new LevelDomainError(
      "Trabalhador não encontrado na cooperativa",
      "WORKER_NOT_FOUND",
      404,
    );
  }

  return worker;
}

export async function calculateTotalWorkerXp({
  workerId,
  cooperativeId,
  db = prisma,
}: {
  workerId: bigint;
  cooperativeId: bigint;
  db?: LevelDbClient;
}) {
  const [workerAchievements, overrides] = await Promise.all([
    db.workerAchievement.findMany({
      where: {
        workerId,
        cooperativeId,
        unlockedAt: { not: null },
      },
      include: {
        achievement: {
          select: {
            achievementId: true,
            baseXpReward: true,
          },
        },
      },
    }),
    db.achievementXpOverride.findMany({
      where: { cooperativeId },
      select: { achievementId: true, xpRewardOverride: true },
    }),
  ]);

  const overrideByAchievement = new Map(
    overrides.map((override) => [override.achievementId.toString(), override.xpRewardOverride]),
  );

  return workerAchievements.reduce((sum, achievement) => {
    const xp =
      overrideByAchievement.get(achievement.achievementId.toString()) ??
      achievement.achievement.baseXpReward;

    return sum + xp;
  }, 0);
}

// Variante SOMENTE-LEITURA de getWorkerLevel: calcula XP/nivel ao vivo e NAO faz
// upsert em WorkerLevel. O WorkerLevel materializado continua a cargo do job do portal.
export async function readWorkerLevel({
  workerId,
  cooperativeId,
  db = prisma,
}: {
  workerId: bigint;
  cooperativeId: bigint;
  db?: LevelDbClient;
}) {
  await findWorkerOrThrow(db, workerId, cooperativeId);

  const [levels, totalXp] = await Promise.all([
    db.levelDefinition.findMany({ orderBy: { levelNumber: "asc" } }),
    calculateTotalWorkerXp({ workerId, cooperativeId, db }),
  ]);

  const currentLevel = pickCurrentLevel(levels, totalXp);

  return formatWorkerLevel({
    workerId,
    totalXp,
    currentLevel,
    nextLevel: getNextLevel(levels, currentLevel.levelNumber),
  });
}
