import { PrismaClient } from "@prisma/client";

type GlobalPrisma = typeof globalThis & { prisma?: PrismaClient };

type PrismaLogLevels = NonNullable<
  ConstructorParameters<typeof PrismaClient>[0]
>["log"];

const logLevels: PrismaLogLevels =
  process.env.NODE_ENV === "production"
    ? ["error"]
    : ["query", "warn", "error"];

const prismaClient = new PrismaClient({ log: logLevels });

export const prisma = ((): PrismaClient => {
  const globalForPrisma = globalThis as GlobalPrisma;

  if (process.env.NODE_ENV === "production") {
    return prismaClient;
  }

  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = prismaClient;
  }

  return globalForPrisma.prisma;
})();

