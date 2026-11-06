import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { hash } from 'bcryptjs';
import { createHash } from 'node:crypto';

process.env.DATABASE_URL = 'postgresql://dummy:dummy@localhost:5432/dummy';
process.env.JWT_SECRET = 'test-secret-with-at-least-32-characters';
process.env.NODE_ENV = 'test';
const hashToken = (s: string) => createHash('sha256').update(s).digest('hex');

test('authentication routes enforce recovery and rotation boundaries', async t => {
  const { prisma } = await import('../src/prisma');
  const { buildServer } = await import('../src/server');
  const server = buildServer(); await server.ready();
  const password = Buffer.from(await hash('manager-pass', 4));
  const workers: any[] = [
    { workerId: 1n, workerName: 'Manager', cpf: Buffer.from('11111111111'), password, userType: '0', cooperative: 1n, authVersion: 0, email: 'a@example.test', cooperativeRef: { cooperativeName: 'A' } },
    { workerId: 2n, workerName: 'Worker', cpf: Buffer.from('22222222222'), password, userType: '1', cooperative: 2n, authVersion: 0, email: 'b@example.test', recoveryEmail: 'b@example.test', recoveryEmailVerified: false, cooperativeRef: { cooperativeName: 'B' } }
  ];
  const sessions: any[] = [{ id: 'session', workerId: 2n, tokenHash: hashToken('refresh'), authVersion: 0, expiresAt: new Date(Date.now()+100000) }];
  const records: any[] = [{ id: 'reset', workerId: 2n, tokenHash: hashToken('reset'), purpose: 'reset', authVersion: 0, attempts: 0, consumedAt: null, expiresAt: new Date(Date.now()+100000) }];
  const counts = new Map<string,number>();
  const fake: any = {
    workers: {
      findUnique: async ({where}: any) => workers.find(w => w.workerId === where.workerId) ?? null,
      findFirst: async ({where}: any) => workers.find(w => Buffer.from(w.cpf).equals(Buffer.from(where.cpf))) ?? null,
      update: async ({where,data}: any) => { const w = workers.find(w => w.workerId === where.workerId); if (data.authVersion) w.authVersion += data.authVersion.increment; if (data.password) w.password = data.password; return w; }
    },
    authRefreshSession: {
      findUnique: async ({where}: any) => sessions.find(s => s.tokenHash === where.tokenHash) ?? null,
      updateMany: async ({where,data}: any) => { const s = sessions.find(x => x.id === where.id && x.tokenHash === where.tokenHash && x.expiresAt > where.expiresAt.gt); if (!s) return { count: 0 }; s.tokenHash = data.tokenHash; return {count: 1}; },
      deleteMany: async () => ({count: 0}), create: async ({data}: any) => { sessions.push(data); return data; }
    },
    authRecoveryToken: {
      findUnique: async ({where}: any) => records.find(r => r.tokenHash === where.tokenHash) ?? null,
      findFirst: async ({where}: any) => records.find(r => r.workerId === where.workerId && r.purpose === where.purpose && r.consumedAt === null) ?? null,
      updateMany: async ({where,data}: any) => { const eligible = records.filter(r => (!where.id || r.id === where.id) && (!where.workerId || r.workerId === where.workerId) && (where.consumedAt !== null || r.consumedAt === null) && (!where.expiresAt || r.expiresAt > where.expiresAt.gt) && (!where.attempts || r.attempts < where.attempts.lt) && (!where.purpose || (typeof where.purpose === 'string' ? r.purpose === where.purpose : where.purpose.in.includes(r.purpose)))); for (const r of eligible) { if (data.attempts) r.attempts++; if (data.consumedAt) r.consumedAt = data.consumedAt; } return { count: eligible.length }; },
      update: async ({where,data}: any) => Object.assign(records.find(r => r.id === where.id), data),
      create: async ({data}: any) => { records.push({...data, attempts:0, consumedAt:null}); return data; }
    }, authAssistanceAudit: { create: async () => ({}) },
    $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => { if (strings.join('').includes('AuthAttemptLimit')) { const key = values[0]; const count = (counts.get(key) ?? 0)+1; counts.set(key,count); return [{count}]; } return []; }
  };
  for (const key of ['workers','authRefreshSession','authRecoveryToken','authAssistanceAudit','$queryRaw']) (prisma as any)[key] = fake[key];
  (prisma as any).$transaction = async (fn: any) => fn(fake);
  const managerToken = server.jwt.sign({ userId: '1', authVersion: 0 });
  const workerToken = server.jwt.sign({ userId: '2', authVersion: 0 });
  await t.test('two concurrent refreshes consume the old token once', async () => {
    const responses = await Promise.all([1,2].map(() => server.inject({ method:'POST', url:'/auth/refresh', payload:{refreshToken:'refresh'} })));
    assert.deepEqual(responses.map(r => r.statusCode).sort(), [200,401]);
  });
  await t.test('assisted recovery rejects a different cooperative', async () => {
    const r = await server.inject({ method:'POST', url:'/auth/assisted-recovery', headers:{authorization:`Bearer ${managerToken}`}, payload:{workerId:'2',currentPassword:'manager-pass',reason:'Requested help'} });
    assert.equal(r.statusCode,403); assert.equal(records.filter(x => x.purpose === 'assist').length,0);
  });
  await t.test('unverified email receives no recovery token', async () => {
    const before = records.length; const r = await server.inject({ method:'POST', url:'/auth/forgot-password', payload:{cpf:'22222222222'} });
    assert.equal(r.statusCode,200); assert.equal(records.length,before);
  });
  await t.test('reset is single use and revokes legacy and versioned access', async () => {
    const legacy = server.jwt.sign({userId:'2'});
    const responses = await Promise.all([1,2].map(() => server.inject({method:'POST',url:'/auth/reset-password',payload:{token:'reset',newPassword:'58290417'}})));
    assert.deepEqual(responses.map(r => r.statusCode).sort(),[200,400]); assert.equal(workers[1].authVersion,1);
    for (const token of [legacy,workerToken]) { const r = await server.inject({method:'GET',url:'/auth/me',headers:{authorization:`Bearer ${token}`}}); assert.equal(r.statusCode,401); }
  });
  await t.test('password change invalidates other outstanding reset links', async () => {
    records.push({ id:'stale', workerId:2n, tokenHash:hashToken('stale'), purpose:'reset', authVersion:0, attempts:0, consumedAt:null, expiresAt:new Date(Date.now()+100000) });
    const r = await server.inject({method:'POST',url:'/auth/reset-password',payload:{token:'stale',newPassword:'58290417'}}); assert.equal(r.statusCode,400);
  });
  await t.test('expired links are rejected', async () => {
    records.push({ id:'expired', workerId: 2n, tokenHash: hashToken('expired'), purpose:'reset', attempts:0, consumedAt:null, expiresAt:new Date(Date.now()-1000) });
    const r = await server.inject({method:'POST',url:'/auth/reset-password',payload:{token:'expired',newPassword:'58290417'}});
    assert.equal(r.statusCode,400);
  });
  await t.test('assisted code locks after five incorrect attempts', async () => {
    records.push({ id:'assist', workerId:2n, tokenHash:hashToken('2:58290417'), purpose:'assist', authVersion:1, attempts:0, consumedAt:null, expiresAt:new Date(Date.now()+100000) });
    for (let i=0; i<5; i++) { const r = await server.inject({method:'POST',url:'/auth/reset-password',payload:{cpf:'22222222222',code:'00000000',newPassword:'58290417'}}); assert.equal(r.statusCode,400); }
    const r = await server.inject({method:'POST',url:'/auth/reset-password',payload:{cpf:'22222222222',code:'58290417',newPassword:'58290417'}}); assert.equal(r.statusCode,400); assert.equal(records.find(r=>r.id==='assist').attempts,5);
  });
  await t.test('account limit does not block a different account on the same IP', async () => {
    for (let i=0; i<10; i++) { const r = await server.inject({method:'POST',url:'/auth/login',payload:{cpf:'99999999999',password:'wrong'}}); assert.equal(r.statusCode,401); }
    const limited = await server.inject({method:'POST',url:'/auth/login',payload:{cpf:'99999999999',password:'wrong'}}); assert.equal(limited.statusCode,429);
    const other = await server.inject({method:'POST',url:'/auth/login',payload:{cpf:'11111111111',password:'manager-pass'}}); assert.equal(other.statusCode,200);
  });
  await t.test('v2 login issues a 15 minute access token and refresh credential', async () => {
    const r = await server.inject({method:'POST',url:'/auth/login',payload:{cpf:'11111111111',password:'manager-pass',sessionVersion:2}});
    assert.equal(r.statusCode,200); const body = r.json(); assert.equal(body.expiresIn,900); assert.ok(body.refreshToken);
    const token = server.jwt.verify<{iat:number,exp:number}>(body.accessToken); assert.equal(token.exp-token.iat,900);
    assert.ok(sessions.some(s => s.tokenHash === hashToken(body.refreshToken) && s.expiresAt.getTime() > Date.now()+29*86400000));
  });
  await t.test('GET recovery links do not consume tokens', async () => { const before = records.length; const r = await server.inject({method:'GET',url:'/auth/reset-password?token=preview'}); assert.equal(r.statusCode,404); assert.equal(records.length,before); });
  await server.close();
});
