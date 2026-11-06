import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { prisma } from '../../prisma';
export const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export async function makeRefresh(workerId: bigint, authVersion: number) {
  const token = secret();
  await prisma.authRefreshSession.create({ data: { id: randomUUID(), workerId, tokenHash: digest(token), authVersion, expiresAt: new Date(Date.now() + 30 * 86400_000) } });
  return token;
}
