import { randomBytes, randomUUID, createHash } from "node:crypto";
import { prisma } from "../../prisma";
export const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
export async function makeRefresh(workerId: bigint, authVersion: number) {
  const token = secret();
  const id = randomUUID();
  const tokenHash = digest(token);
  await prisma.$transaction(async (tx) => {
    await tx.authRefreshSession.create({
      data: {
        id,
        workerId,
        tokenHash,
        authVersion,
        expiresAt: new Date(Date.now() + 30 * 86400_000),
      },
    });
    await tx.authRefreshToken.create({ data: { tokenHash, sessionId: id } });
  });
  return { token, id };
}
