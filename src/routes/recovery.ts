import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { randomInt, randomUUID } from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import { prisma } from '../prisma';
import { env } from '../env';
import { clientIp } from '../lib/auth/proxy-ip';
import { enqueueMail } from '../lib/auth/outbox';
import { digest, secret } from '../lib/auth/session';
import { mapUserTypeToRole } from '../lib/userType';
import { validNewPassword } from '../lib/auth/password';

const generic = { message: 'Se os dados permitirem, as instruções serão enviadas.' };
const cpfSchema = z.string().transform(v => v.replace(/\D/g, '')).refine(v => v.length === 11);
const refreshSchema = z.object({ refreshToken: z.string().min(1).max(256) });
export async function limit(key: string, maximum: number, seconds: number) {
  const id = digest(key); const now = new Date(); const until = new Date(now.getTime() + seconds * 1000);
  const rows = await prisma.$queryRaw<Array<{count: number}>>`
    INSERT INTO "AuthAttemptLimit" ("key", "count", "expiresAt") VALUES (${id}, 1, ${until})
    ON CONFLICT ("key") DO UPDATE SET "count" = CASE WHEN "AuthAttemptLimit"."expiresAt" <= ${now} THEN 1 ELSE "AuthAttemptLimit"."count" + 1 END,
    "expiresAt" = CASE WHEN "AuthAttemptLimit"."expiresAt" <= ${now} THEN ${until} ELSE "AuthAttemptLimit"."expiresAt" END RETURNING "count"`;
  return rows[0].count <= maximum;
}
export async function checkLimit(key: string, maximum: number) {
  const row = await prisma.authAttemptLimit.findUnique({where:{key:digest(key)}});
  return !row || row.expiresAt <= new Date() || row.count < maximum;
}
export async function clearLimit(key: string) { await prisma.authAttemptLimit.deleteMany({where:{key:digest(key)}}); }
const userSelect = { workerId: true, workerName: true, email: true, cpf: true, userType: true, cooperative: true, cooperativeRef: { select: { cooperativeName: true } } } as const;
function userObject(w: any) { return { id: String(w.workerId), name: w.workerName, email: w.email, cpf: Buffer.from(w.cpf).toString('utf8'), userType: mapUserTypeToRole(w.userType), cooperativeId: String(w.cooperative), cooperativeName: w.cooperativeRef?.cooperativeName ?? null }; }
export const recoveryRoutes: FastifyPluginAsync = async server => {
  server.post('/refresh', async (req) => {
    const { refreshToken } = refreshSchema.parse(req.body); const now = new Date(); const next = secret(); const oldHash = digest(refreshToken);
    const result = await prisma.$transaction(async tx => {
      const token = await tx.authRefreshToken.findUnique({ where: { tokenHash: oldHash } }); if (!token) return null;
      await tx.$queryRaw`SELECT "id" FROM "AuthRefreshSession" WHERE "id" = ${token.sessionId} FOR UPDATE`;
      const session = await tx.authRefreshSession.findUnique({where:{id:token.sessionId}});
      const current = await tx.authRefreshToken.findUnique({where:{tokenHash:oldHash}});
      if (!session || !current || session.revokedAt || session.expiresAt <= now) return null;
      if (current.consumedAt) { await tx.authRefreshSession.update({where:{id:session.id},data:{revokedAt:now}}); return null; }
      const worker = await tx.workers.findUnique({ where: { workerId: session.workerId }, select: { ...userSelect, authVersion: true } });
      if (!worker || worker.authVersion !== session.authVersion) return null;
      await tx.authRefreshToken.update({where:{tokenHash:oldHash},data:{consumedAt:now}});
      await tx.authRefreshToken.create({data:{tokenHash:digest(next),sessionId:session.id}});
      await tx.authRefreshSession.update({where:{id:session.id},data:{tokenHash:digest(next)}});
      return {worker, sid:session.id};
    });
    if (!result) throw server.httpErrors.unauthorized('Sessão inválida.');
    const accessToken = await server.jwt.sign({ userId: String(result.worker.workerId), authVersion: result.worker.authVersion, sessionVersion:2, sid:result.sid }, { expiresIn: '15m' });
    return { accessToken, refreshToken: next, expiresIn: 900, user: userObject(result.worker) };
  });
  server.post('/logout', async req => { const { refreshToken } = refreshSchema.parse(req.body); const token = await prisma.authRefreshToken.findUnique({where:{tokenHash:digest(refreshToken)}}); if (token) await prisma.authRefreshSession.updateMany({where:{id:token.sessionId,revokedAt:null},data:{revokedAt:new Date()}}); return { message: 'Sessão encerrada.' }; });
  server.post('/forgot-password', async req => {
    const { cpf } = z.object({ cpf: cpfSchema }).parse(req.body);
    const permitted = await Promise.all([limit(`forgot:cpf:${cpf}`, 3, 3600), limit(`forgot:ip:${clientIp(req, env.AUTH_PROXY_SECRET)}`, 20, 3600), limit(`forgot:cooldown:${cpf}`, 1, 60)]);
    if (!permitted.every(Boolean)) return generic;
    const candidate = await prisma.workers.findFirst({ where: { cpf: Buffer.from(cpf) }, select: { workerId: true } });
    const workerId = candidate?.workerId ?? 0n; const token = secret();
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "Worker_id" FROM "Workers" WHERE "Worker_id" = ${workerId} FOR UPDATE`;
      const w = await tx.workers.findUnique({where:{workerId},select:{workerId:true,authVersion:true,recoveryEmail:true,recoveryEmailVerified:true}});
      const email = w?.recoveryEmailVerified && w.recoveryEmail ? w.recoveryEmail : null;
      await tx.authRecoveryToken.create({data:{id:randomUUID(),workerId:email ? workerId : 0n,authVersion:email ? w!.authVersion : 0,tokenHash:digest(token),purpose:'reset',email,expiresAt:new Date(Date.now()+1200_000)}});
      await enqueueMail(tx,{email,token,purpose:'reset'});
    });
    return generic;
  });
  server.post('/recovery-email', { preHandler: [server.authenticate] }, async req => {
    const { email, currentPassword } = z.object({ email: z.string().email().max(254), currentPassword: z.string().min(1) }).parse(req.body);
    if (!await limit(`email-reauth:${req.user.userId}`, 10, 900)) throw server.httpErrors.tooManyRequests();
    const w = await prisma.workers.findUnique({ where: { workerId: BigInt(req.user.userId) } });
    if (!w || !await compare(currentPassword, Buffer.from(w.password).toString('utf8'))) throw server.httpErrors.unauthorized('Senha incorreta.');
    if (!await limit(`email:${w.workerId}`, 5, 3600)) throw server.httpErrors.tooManyRequests();
    const token = secret(); await prisma.$transaction(async tx => { await tx.$queryRaw`SELECT "Worker_id" FROM "Workers" WHERE "Worker_id" = ${w.workerId} FOR UPDATE`; const current = await tx.workers.findUnique({where:{workerId:w.workerId},select:{authVersion:true}}); if (!current || current.authVersion !== w.authVersion || current.authVersion !== (req.user.authVersion ?? 0)) throw server.httpErrors.unauthorized(); await tx.authRecoveryToken.updateMany({ where: { workerId: w.workerId, purpose: 'confirm', consumedAt: null }, data: { consumedAt: new Date() } }); await tx.authRecoveryToken.create({ data: { id: randomUUID(), workerId: w.workerId, authVersion: w.authVersion, tokenHash: digest(token), purpose: 'confirm', email, expiresAt: new Date(Date.now()+1200_000) } }); await enqueueMail(tx,{email,token,purpose:'confirm'}); }); return generic;
  });
  server.post('/verify-recovery-email', async req => {
    const { token } = z.object({ token: z.string().min(1).max(256) }).parse(req.body); const now = new Date();
    const ok = await prisma.$transaction(async tx => { const record = await tx.authRecoveryToken.findUnique({ where: { tokenHash: digest(token) } }); if (!record?.email || record.purpose !== 'confirm') return false;
      await tx.$queryRaw`SELECT "Worker_id" FROM "Workers" WHERE "Worker_id" = ${record.workerId} FOR UPDATE`;
      const current = await tx.workers.findUnique({ where: { workerId: record.workerId }, select: { authVersion: true } });
      if (!current || current.authVersion !== record.authVersion) return false;
      const changed = await tx.authRecoveryToken.updateMany({ where: { id: record.id, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } }); if (!changed.count) return false;
      await tx.authRecoveryToken.updateMany({ where: { workerId: record.workerId, purpose: 'reset', consumedAt: null }, data: { consumedAt: now } });
      await tx.workers.update({ where: { workerId: record.workerId }, data: { recoveryEmail: record.email, recoveryEmailVerified: true } }); return true; });
    if (!ok) throw server.httpErrors.badRequest('Link inválido ou expirado.'); return { message: 'Email confirmado.' };
  });
  server.post('/assisted-recovery', { preHandler: [server.authenticate] }, async req => {
    const input = z.object({ workerId: z.string().regex(/^\d+$/), currentPassword: z.string().min(1), reason: z.string().trim().min(3).max(500) }).parse(req.body);
    if (!await limit(`assist-reauth:${req.user.userId}`, 10, 900)) throw server.httpErrors.tooManyRequests();
    const manager = await prisma.workers.findUnique({ where: { workerId: BigInt(req.user.userId) } });
    if (!manager || mapUserTypeToRole(manager.userType) !== 'manager' || !await compare(input.currentPassword, Buffer.from(manager.password).toString('utf8'))) throw server.httpErrors.unauthorized('Não autorizado.');
    const worker = await prisma.workers.findUnique({ where: { workerId: BigInt(input.workerId) } });
    if (!worker || worker.cooperative !== manager.cooperative || mapUserTypeToRole(worker.userType) !== 'worker') throw server.httpErrors.forbidden('Não autorizado.');
    if (!await limit(`assist:${manager.workerId}`, 10, 3600)) throw server.httpErrors.tooManyRequests();
    const code = String(randomInt(100_000_000)).padStart(8,'0');
    await prisma.$transaction(async tx => {
      const first = manager.workerId < worker.workerId ? manager.workerId : worker.workerId; const second = manager.workerId < worker.workerId ? worker.workerId : manager.workerId;
      await tx.$queryRaw`SELECT "Worker_id" FROM "Workers" WHERE "Worker_id" IN (${first}, ${second}) ORDER BY "Worker_id" FOR UPDATE`;
      const currentManager = await tx.workers.findUnique({where:{workerId:manager.workerId}}); const currentWorker = await tx.workers.findUnique({where:{workerId:worker.workerId}});
      if (!currentManager || !currentWorker || currentManager.authVersion !== manager.authVersion || currentManager.authVersion !== (req.user.authVersion ?? 0) || currentWorker.authVersion !== worker.authVersion || mapUserTypeToRole(currentManager.userType) !== 'manager' || mapUserTypeToRole(currentWorker.userType) !== 'worker' || currentManager.cooperative !== currentWorker.cooperative) throw server.httpErrors.unauthorized();
      await tx.authRecoveryToken.updateMany({ where: { workerId: worker.workerId, purpose: 'assist', consumedAt: null }, data: { consumedAt: new Date() } }); await tx.authRecoveryToken.create({ data: { id: randomUUID(), workerId: worker.workerId, authVersion: worker.authVersion, tokenHash: digest(`${worker.workerId}:${code}`), purpose: 'assist', expiresAt: new Date(Date.now()+900_000) } }); await tx.authAssistanceAudit.create({ data: { id: randomUUID(), managerId: manager.workerId, workerId: worker.workerId, reason: input.reason } }); });
    return { code, expiresIn: 900 };
  });
  server.post('/reset-password', async req => {
    const input = z.union([z.object({ token: z.string().min(1).max(256), newPassword: z.string().min(1).max(128) }), z.object({ cpf: cpfSchema, code: z.string().regex(/^\d{8}$/), newPassword: z.string().min(1).max(128) })]).parse(req.body);
    const now = new Date(); if (!await limit(`reset:ip:${clientIp(req, env.AUTH_PROXY_SECRET)}`, 40, 3600)) throw server.httpErrors.tooManyRequests();
    const passwordHash = await hash(input.newPassword, 10);
    const ok = await prisma.$transaction(async tx => {
      let record;
      if ('token' in input) record = await tx.authRecoveryToken.findUnique({ where: { tokenHash: digest(input.token) } });
      else { const w = await tx.workers.findFirst({ where: { cpf: Buffer.from(input.cpf) }, select: { workerId: true } }); if (!w) return false; record = await tx.authRecoveryToken.findFirst({ where: { workerId: w.workerId, purpose: 'assist', consumedAt: null }, orderBy: { createdAt: 'desc' } }); }
      if (!record || record.purpose !== ('token' in input ? 'reset' : 'assist')) return false;
      await tx.$queryRaw`SELECT "Worker_id" FROM "Workers" WHERE "Worker_id" = ${record.workerId} FOR UPDATE`;
      if (record.consumedAt || record.expiresAt <= now || record.attempts >= 5) return false;
      if ('code' in input && record.tokenHash !== digest(`${record.workerId}:${input.code}`)) {
        await tx.authRecoveryToken.updateMany({where:{id:record.id,consumedAt:null,expiresAt:{gt:now},attempts:{lt:5}},data:{attempts:{increment:1}}}); return false;
      }
      const worker = await tx.workers.findUnique({ where: { workerId: record.workerId }, select: { userType: true, authVersion: true, recoveryEmail: true, recoveryEmailVerified: true } }); if (!worker || worker.authVersion !== record.authVersion || !validNewPassword(input.newPassword, mapUserTypeToRole(worker.userType))) return false;
      const claim = await tx.authRecoveryToken.updateMany({ where: { id: record.id, consumedAt: null, expiresAt: { gt: now }, attempts: { lt: 5 } }, data: { consumedAt: now } }); if (!claim.count) return false;
      await tx.workers.update({ where: { workerId: record.workerId }, data: { password: Buffer.from(passwordHash), authVersion: { increment: 1 } } });
      await tx.authRecoveryToken.updateMany({ where: { workerId: record.workerId, purpose: { in: ['reset', 'assist'] }, consumedAt: null }, data: { consumedAt: now } });
      if (worker.recoveryEmailVerified && worker.recoveryEmail) await enqueueMail(tx,{email:worker.recoveryEmail,purpose:'notice'}); return true;
    });
    if (!ok) throw server.httpErrors.badRequest('Dados inválidos, expirados ou senha fora da política.'); return { message: 'Senha alterada.' };
  });
};
