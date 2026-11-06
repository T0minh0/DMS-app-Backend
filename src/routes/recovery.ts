import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { randomInt, randomUUID } from 'node:crypto';
import { compare, hash } from 'bcryptjs';
import { prisma } from '../prisma';
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
async function sendMail(email: string, token: string, purpose: 'reset'|'confirm') {
  const { RESEND_API_KEY, RECOVERY_EMAIL_FROM, RECOVERY_WEB_URL } = process.env;
  if (!RESEND_API_KEY || !RECOVERY_EMAIL_FROM || !RECOVERY_WEB_URL) return false;
  let url: URL;
  try { url = new URL(RECOVERY_WEB_URL); if (url.protocol !== 'https:') return false; } catch { return false; }
  url.pathname = purpose === 'reset' ? '/recuperar-senha' : '/confirmar-email'; url.search = ''; url.searchParams.set('token', token);
  try { const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: RECOVERY_EMAIL_FROM, to: [email], subject: purpose === 'reset' ? 'Recuperar senha' : 'Confirmar email', text: `Acesse: ${url.toString()}` }) }); return response.ok; } catch { return false; /* Do not log link or provider response. */ }
}
const userSelect = { workerId: true, workerName: true, email: true, cpf: true, userType: true, cooperative: true, cooperativeRef: { select: { cooperativeName: true } } } as const;
function userObject(w: any) { return { id: String(w.workerId), name: w.workerName, email: w.email, cpf: Buffer.from(w.cpf).toString('utf8'), userType: mapUserTypeToRole(w.userType), cooperativeId: String(w.cooperative), cooperativeName: w.cooperativeRef?.cooperativeName ?? null }; }
export const recoveryRoutes: FastifyPluginAsync = async server => {
  server.post('/refresh', async (req) => {
    const { refreshToken } = refreshSchema.parse(req.body); const now = new Date(); const next = secret();
    const result = await prisma.$transaction(async tx => {
      const session = await tx.authRefreshSession.findUnique({ where: { tokenHash: digest(refreshToken) } });
      if (!session || session.expiresAt <= now) return null;
      const worker = await tx.workers.findUnique({ where: { workerId: session.workerId }, select: { ...userSelect, authVersion: true } });
      if (!worker || worker.authVersion !== session.authVersion) return null;
      const changed = await tx.authRefreshSession.updateMany({ where: { id: session.id, tokenHash: digest(refreshToken), expiresAt: { gt: now } }, data: { tokenHash: digest(next) } });
      return changed.count === 1 ? worker : null;
    });
    if (!result) throw server.httpErrors.unauthorized('Sessão inválida.');
    const accessToken = await server.jwt.sign({ userId: String(result.workerId), authVersion: result.authVersion }, { expiresIn: '15m' });
    return { accessToken, refreshToken: next, expiresIn: 900, user: userObject(result) };
  });
  server.post('/logout', async req => { const { refreshToken } = refreshSchema.parse(req.body); await prisma.authRefreshSession.deleteMany({ where: { tokenHash: digest(refreshToken) } }); return { message: 'Sessão encerrada.' }; });
  server.post('/forgot-password', async req => {
    const { cpf } = z.object({ cpf: cpfSchema }).parse(req.body);
    const permitted = await Promise.all([limit(`forgot:cpf:${cpf}`, 3, 3600), limit(`forgot:ip:${req.ip}`, 20, 3600)]);
    if (!permitted.every(Boolean)) return generic;
    const w = await prisma.workers.findFirst({ where: { cpf: Buffer.from(cpf) }, select: { workerId: true, authVersion: true, recoveryEmail: true, recoveryEmailVerified: true } });
    if (w?.recoveryEmail && w.recoveryEmailVerified) { const token = secret(); await prisma.authRecoveryToken.create({ data: { id: randomUUID(), workerId: w.workerId, authVersion: w.authVersion, tokenHash: digest(token), purpose: 'reset', expiresAt: new Date(Date.now()+1200_000) } }); await sendMail(w.recoveryEmail, token, 'reset'); }
    return generic;
  });
  server.post('/recovery-email', { preHandler: [server.authenticate] }, async req => {
    const { email, currentPassword } = z.object({ email: z.string().email().max(254), currentPassword: z.string().min(1) }).parse(req.body);
    if (!await limit(`email-reauth:${req.user.userId}`, 10, 900)) throw server.httpErrors.tooManyRequests();
    const w = await prisma.workers.findUnique({ where: { workerId: BigInt(req.user.userId) } });
    if (!w || !await compare(currentPassword, Buffer.from(w.password).toString('utf8'))) throw server.httpErrors.unauthorized('Senha incorreta.');
    if (!await limit(`email:${w.workerId}`, 5, 3600)) throw server.httpErrors.tooManyRequests();
    const token = secret(); await prisma.$transaction(async tx => { await tx.$queryRaw`SELECT "Worker_id" FROM "Workers" WHERE "Worker_id" = ${w.workerId} FOR UPDATE`; await tx.authRecoveryToken.updateMany({ where: { workerId: w.workerId, purpose: 'confirm', consumedAt: null }, data: { consumedAt: new Date() } }); await tx.authRecoveryToken.create({ data: { id: randomUUID(), workerId: w.workerId, authVersion: w.authVersion, tokenHash: digest(token), purpose: 'confirm', email, expiresAt: new Date(Date.now()+1200_000) } }); }); if (!await sendMail(email, token, 'confirm')) throw server.httpErrors.serviceUnavailable('Não foi possível enviar o email de confirmação.'); return generic;
  });
  server.post('/verify-recovery-email', async req => {
    const { token } = z.object({ token: z.string().min(1).max(256) }).parse(req.body); const now = new Date();
    const ok = await prisma.$transaction(async tx => { const record = await tx.authRecoveryToken.findUnique({ where: { tokenHash: digest(token) } }); if (!record?.email || record.purpose !== 'confirm') return false;
      await tx.$queryRaw`SELECT "Worker_id" FROM "Workers" WHERE "Worker_id" = ${record.workerId} FOR UPDATE`;
      const current = await tx.workers.findUnique({ where: { workerId: record.workerId }, select: { authVersion: true } });
      if (!current || current.authVersion !== record.authVersion) return false;
      const changed = await tx.authRecoveryToken.updateMany({ where: { id: record.id, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } }); if (!changed.count) return false;
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
    await prisma.$transaction(async tx => { await tx.authRecoveryToken.updateMany({ where: { workerId: worker.workerId, purpose: 'assist', consumedAt: null }, data: { consumedAt: new Date() } }); await tx.authRecoveryToken.create({ data: { id: randomUUID(), workerId: worker.workerId, authVersion: worker.authVersion, tokenHash: digest(`${worker.workerId}:${code}`), purpose: 'assist', expiresAt: new Date(Date.now()+900_000) } }); await tx.authAssistanceAudit.create({ data: { id: randomUUID(), managerId: manager.workerId, workerId: worker.workerId, reason: input.reason } }); });
    return { code, expiresIn: 900 };
  });
  server.post('/reset-password', async req => {
    const input = z.union([z.object({ token: z.string().min(1).max(256), newPassword: z.string().min(1).max(128) }), z.object({ cpf: cpfSchema, code: z.string().regex(/^\d{8}$/), newPassword: z.string().min(1).max(128) })]).parse(req.body);
    const now = new Date(); if (!await limit(`reset:ip:${req.ip}`, 40, 3600)) throw server.httpErrors.tooManyRequests();
    const passwordHash = await hash(input.newPassword, 10);
    const ok = await prisma.$transaction(async tx => {
      let record;
      if ('token' in input) record = await tx.authRecoveryToken.findUnique({ where: { tokenHash: digest(input.token) } });
      else { const w = await tx.workers.findFirst({ where: { cpf: Buffer.from(input.cpf) }, select: { workerId: true } }); if (!w) return false; record = await tx.authRecoveryToken.findFirst({ where: { workerId: w.workerId, purpose: 'assist', consumedAt: null }, orderBy: { createdAt: 'desc' } }); }
      if (!record || record.purpose !== ('token' in input ? 'reset' : 'assist')) return false;
      await tx.$queryRaw`SELECT "Worker_id" FROM "Workers" WHERE "Worker_id" = ${record.workerId} FOR UPDATE`;
      const claim = await tx.authRecoveryToken.updateMany({ where: { id: record.id, consumedAt: null, expiresAt: { gt: now }, attempts: { lt: 5 } }, data: { attempts: { increment: 1 } } }); if (!claim.count) return false;
      if ('code' in input && record.tokenHash !== digest(`${record.workerId}:${input.code}`)) return false;
      const worker = await tx.workers.findUnique({ where: { workerId: record.workerId }, select: { userType: true, authVersion: true } }); if (!worker || worker.authVersion !== record.authVersion || !validNewPassword(input.newPassword, mapUserTypeToRole(worker.userType))) return false;
      await tx.authRecoveryToken.update({ where: { id: record.id }, data: { consumedAt: now } });
      await tx.workers.update({ where: { workerId: record.workerId }, data: { password: Buffer.from(passwordHash), authVersion: { increment: 1 } } });
      await tx.authRecoveryToken.updateMany({ where: { workerId: record.workerId, purpose: { in: ['reset', 'assist'] }, consumedAt: null }, data: { consumedAt: now } }); return true;
    });
    if (!ok) throw server.httpErrors.badRequest('Dados inválidos, expirados ou senha fora da política.'); return { message: 'Senha alterada.' };
  });
};
