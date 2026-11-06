import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { prisma } from '../../prisma';
import { env } from '../../env';

type Mail = { email: string | null; token?: string; purpose: 'reset' | 'confirm' | 'notice' };
const key = () => createHash('sha256').update(env.JWT_SECRET).digest();
function encrypt(mail: Mail) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(mail), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}
function decrypt(value: string): Mail {
  const raw = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0,12));
  cipher.setAuthTag(raw.subarray(12,28)); return JSON.parse(Buffer.concat([cipher.update(raw.subarray(28)),cipher.final()]).toString('utf8'));
}
export async function enqueueMail(tx: any, mail: Mail) {
  await tx.authMailOutbox.create({ data: { id: randomUUID(), payload: encrypt(mail) } });
}
async function deliver(mail: Mail) {
  if (!mail.email) return true;
  if (!env.RESEND_API_KEY || !env.RECOVERY_EMAIL_FROM || !env.RECOVERY_WEB_URL) return false;
  const link = mail.purpose === 'notice' ? null : new URL(env.RECOVERY_WEB_URL);
  if (link) { link.pathname = mail.purpose === 'reset' ? '/recuperar-senha' : '/confirmar-email'; link.search = ''; link.searchParams.set('token', mail.token ?? ''); }
  const subject = mail.purpose === 'reset' ? 'Recuperar senha' : mail.purpose === 'confirm' ? 'Confirmar email de recuperação' : 'Sua senha foi alterada';
  const action = mail.purpose === 'reset' ? 'Redefinir senha' : 'Confirmar email';
  const introduction = mail.purpose === 'reset' ? 'Recebemos uma solicitação para redefinir sua senha.' : 'Recebemos uma solicitação para confirmar este email de recuperação.';
  const text = link ? `${introduction} O link vale por 20 minutos. Se não foi você, ignore esta mensagem.\n\n${link}` : 'A senha da sua conta foi alterada. Se não foi você, procure a gestão da sua cooperativa.';
  const html = link ? `<p>${introduction}</p><p>O link vale por 20 minutos. Se não foi você, ignore esta mensagem.</p><p><a href="${link}" style="display:inline-block;padding:14px 22px;background:#196f45;color:#fff;border-radius:6px;text-decoration:none">${action}</a></p>` : '<p>A senha da sua conta foi alterada.</p><p>Se não foi você, procure a gestão da sua cooperativa.</p>';
  try { const response = await fetch('https://api.resend.com/emails', { method:'POST', headers:{ Authorization:`Bearer ${env.RESEND_API_KEY}`, 'Content-Type':'application/json' }, body:JSON.stringify({from:env.RECOVERY_EMAIL_FROM,to:[mail.email],subject,text,html}), signal:AbortSignal.timeout(10000) }); return response.ok; } catch { return false; }
}
export async function processOutbox() {
  const job = await prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Array<{id:string}>>`SELECT "id" FROM "AuthMailOutbox" WHERE "availableAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AND ("lockedUntil" IS NULL OR "lockedUntil" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')) ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!rows.length) return null;
    return tx.authMailOutbox.update({where:{id:rows[0].id},data:{lockedUntil:new Date(Date.now()+30000),attempts:{increment:1}}});
  });
  if (!job) return;
  let ok = false; try { ok = await deliver(decrypt(job.payload)); } catch { /* Retry without exposing content. */ }
  if (ok) await prisma.authMailOutbox.deleteMany({where:{id:job.id}});
  else await prisma.authMailOutbox.updateMany({where:{id:job.id},data:{lockedUntil:null,availableAt:new Date(Date.now()+Math.min(3600000, 30000 * 2 ** Math.min(job.attempts,7)))}});
}
export function startOutbox() {
  if (env.NODE_ENV === 'test') return () => {};
  const timer = setInterval(() => { void processOutbox().catch(() => {}); }, 2000); timer.unref(); return () => clearInterval(timer);
}
