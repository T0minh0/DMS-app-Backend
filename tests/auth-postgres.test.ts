import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { hash, compare } from 'bcryptjs';

const database = process.env.AUTH_TEST_DATABASE_URL;
// These fixtures reset authentication state. Reject non-local or durable targets.
if (database) {
  const target = new URL(database);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !/(?:test|scratch|disposable|migration)/i.test(target.pathname)) {
    throw new Error('AUTH_TEST_DATABASE_URL must name a disposable local test database.');
  }
}

const safe = ['postgresql://cammis@127.0.0.1:55491/dms_auth_test', 'postgresql://cammis@127.0.0.1:55491/dms_auth_migration'].includes(database ?? '');
const digest = (s: string) => createHash('sha256').update(s).digest('hex');

test('isolated PostgreSQL authentication regressions', { skip: !safe }, async t => {
  process.env.DATABASE_URL = database!;
  process.env.JWT_SECRET = 'test-secret-with-at-least-32-characters';
  process.env.NODE_ENV = 'test';
  process.env.AUTH_PROXY_SECRET = 'shared-test-secret-at-least-32-characters';
  process.env.RESEND_API_KEY = 'test-only'; process.env.RECOVERY_EMAIL_FROM = 'test@example.test'; process.env.RECOVERY_WEB_URL = 'https://example.test';
  const { prisma } = await import('../src/prisma'); const { buildServer } = await import('../src/server');
  await prisma.authAssistanceAudit.deleteMany(); await prisma.authRecoveryToken.deleteMany(); await prisma.authRefreshToken.deleteMany(); await prisma.authRefreshSession.deleteMany(); await prisma.authMailOutbox.deleteMany(); await prisma.authAttemptLimit.deleteMany();
  await prisma.workers.deleteMany({ where: { workerName: { in: ['Auth test', 'Auth manager'] } } }); await prisma.cooperative.deleteMany({ where: { cooperativeName: 'Auth test' } });
  const coop = await prisma.cooperative.create({ data:{cooperativeName:'Auth test'} });
  const password = Buffer.from(await hash('initial-pass', 4));
  const worker = await prisma.workers.create({ data:{workerName:'Auth test',cooperative:coop.cooperativeId,cpf:Buffer.from('33333333333'),userType:'1',birthDate:new Date('2000-01-01'),enterDate:new Date('2020-01-01'),pis:Buffer.from('0'),rg:Buffer.from('0'),password,email:'x@example.test',recoveryEmail:'old@example.test',recoveryEmailVerified:true} });
  const server = buildServer(); await server.ready();
  const login = async () => { const r = await server.inject({method:'POST',url:'/auth/login',payload:{cpf:'33333333333',password:'initial-pass',sessionVersion:2}}); assert.equal(r.statusCode,200); return r.json(); };
  const me = (token: string) => server.inject({method:'GET',url:'/auth/me',headers:{authorization:`Bearer ${token}`}});
  await t.test('login, refresh and profile save preserve verified recovery metadata', async () => {
    const session = await login();
    assert.equal(session.user.recoveryEmail,'old@example.test'); assert.equal(session.user.recoveryEmailVerified,true);
    const profile = await me(session.accessToken); assert.equal(profile.json().recoveryEmail,'old@example.test'); assert.equal(profile.json().recoveryEmailVerified,true);
    const changed = await server.inject({method:'PUT',url:'/auth/me',headers:{authorization:`Bearer ${session.accessToken}`},payload:{name:'Auth test revised'}});
    assert.equal(changed.statusCode,200); assert.equal(changed.json().user.recoveryEmail,'old@example.test'); assert.equal(changed.json().user.recoveryEmailVerified,true);
    const unchanged = await server.inject({method:'PUT',url:'/auth/me',headers:{authorization:`Bearer ${session.accessToken}`},payload:{}});
    assert.equal(unchanged.statusCode,200); assert.equal(unchanged.json().user.recoveryEmail,'old@example.test'); assert.equal(unchanged.json().user.recoveryEmailVerified,true);
    const refreshed = await server.inject({method:'POST',url:'/auth/refresh',payload:{refreshToken:session.refreshToken}});
    assert.equal(refreshed.statusCode,200); assert.equal(refreshed.json().user.recoveryEmail,'old@example.test'); assert.equal(refreshed.json().user.recoveryEmailVerified,true);
    await prisma.workers.update({where:{workerId:worker.workerId},data:{workerName:'Auth test'}});
  });
  await t.test('assisted recovery audit snapshots the cooperative', async () => {
    const manager = await prisma.workers.create({data:{workerName:'Auth manager',cooperative:coop.cooperativeId,cpf:Buffer.from('00000000999'),userType:'0',birthDate:new Date('2000-01-01'),enterDate:new Date('2020-01-01'),pis:Buffer.from('0'),rg:Buffer.from('0'),password,email:'manager@example.test'}});
    const response = await server.inject({method:'POST',url:'/auth/login',payload:{cpf:'00000000999',password:'initial-pass',sessionVersion:2}}); assert.equal(response.statusCode,200); assert.equal(response.json().user.recoveryEmail,null); assert.equal(response.json().user.recoveryEmailVerified,false);
    const managerAccess = response.json().accessToken; const managerHeaders = {authorization:`Bearer ${managerAccess}`};
    const managerProfile = await server.inject({method:'PUT',url:'/auth/me',headers:managerHeaders,payload:{name:'Auth manager'}});
    assert.equal(managerProfile.json().user.recoveryEmail,null); assert.equal(managerProfile.json().user.recoveryEmailVerified,false);
    const managerRefresh = await server.inject({method:'POST',url:'/auth/refresh',payload:{refreshToken:response.json().refreshToken}});
    assert.equal(managerRefresh.json().user.recoveryEmail,null); assert.equal(managerRefresh.json().user.recoveryEmailVerified,false);
    const assisted = await server.inject({method:'POST',url:'/auth/assisted-recovery',headers:{authorization:`Bearer ${response.json().accessToken}`},payload:{workerId:String(worker.workerId),currentPassword:'initial-pass',reason:'Solicitou ajuda'}}); assert.equal(assisted.statusCode,200);
    const audit = await prisma.authAssistanceAudit.findFirst({where:{managerId:manager.workerId,workerId:worker.workerId}});
    assert.equal((audit as unknown as {cooperativeId:bigint}|null)?.cooperativeId,coop.cooperativeId);
    const other = await prisma.cooperative.create({data:{cooperativeName:'Auth snapshot transfer'}});
    await prisma.workers.update({where:{workerId:worker.workerId},data:{cooperative:other.cooperativeId}});
    const saved = await prisma.authAssistanceAudit.findUniqueOrThrow({where:{id:audit!.id}}); assert.equal(saved.cooperativeId,coop.cooperativeId);
    await prisma.workers.update({where:{workerId:worker.workerId},data:{cooperative:coop.cooperativeId}}); await prisma.cooperative.delete({where:{cooperativeId:other.cooperativeId}});
  });
  await t.test('logout revokes access already issued to this session', async () => {
    const s = await login(); await server.inject({method:'POST',url:'/auth/logout',payload:{refreshToken:s.refreshToken}}); assert.equal((await me(s.accessToken)).statusCode,401);
  });
  await t.test('logout cleans only named owned push bindings with an expired bearer', async () => {
    const session = await login();
    const other = await prisma.workers.findFirstOrThrow({where:{workerName:'Auth manager'}});
    await prisma.workerPushToken.createMany({data:[
      {workerId:worker.workerId,token:'logout-current-device',platform:'android'},
      {workerId:worker.workerId,token:'logout-other-device',platform:'android'},
      {workerId:other.workerId,token:'logout-foreign-device',platform:'android'}
    ]});
    const expired = server.jwt.sign({userId:String(worker.workerId),authVersion:0},{expiresIn:'-1s'});
    assert.equal((await server.inject({method:'DELETE',url:'/devices/push-token',headers:{authorization:`Bearer ${expired}`},payload:{token:'logout-current-device'}})).statusCode,401);
    const response = await server.inject({method:'POST',url:'/auth/logout',headers:{authorization:`Bearer ${expired}`},payload:{refreshToken:session.refreshToken,pushTokens:['logout-current-device','logout-foreign-device']}});
    assert.equal(response.statusCode,200);
    assert.equal(await prisma.workerPushToken.findUnique({where:{token:'logout-current-device'}}),null);
    assert.ok(await prisma.workerPushToken.findUnique({where:{token:'logout-other-device'}}));
    assert.ok(await prisma.workerPushToken.findUnique({where:{token:'logout-foreign-device'}}));
    await prisma.workerPushToken.deleteMany({where:{token:{startsWith:'logout-'}}});
  });
  await t.test('logout cleans push after password change invalidates the access and refresh versions', async () => {
    const session = await login();
    const beforePasswordChange = await prisma.workers.findUniqueOrThrow({where:{workerId:worker.workerId}});
    await prisma.workerPushToken.create({data:{workerId:worker.workerId,token:'password-change-device',platform:'android'}});
    assert.equal((await server.inject({method:'PUT',url:'/auth/me',headers:{authorization:`Bearer ${session.accessToken}`},payload:{currentPassword:'initial-pass',newPassword:'58290417'}})).statusCode,200);
    assert.equal((await me(session.accessToken)).statusCode,401);
    const response = await server.inject({method:'POST',url:'/auth/logout',payload:{refreshToken:session.refreshToken,pushTokens:['password-change-device']}});
    assert.equal(response.statusCode,200);
    const binding = await prisma.workerPushToken.findUnique({where:{token:'password-change-device'}});
    await prisma.workers.update({where:{workerId:worker.workerId},data:{password,authVersion:beforePasswordChange.authVersion}});
    await prisma.workerPushToken.deleteMany({where:{token:'password-change-device'}});
    assert.equal(binding,null);
  });
  await t.test('replayed logout cannot delete a later registration by the same account', async () => {
    const old = await login();
    await prisma.workerPushToken.create({data:{workerId:worker.workerId,token:'same-account-device',platform:'android'}});
    await server.inject({method:'POST',url:'/auth/logout',payload:{refreshToken:old.refreshToken,pushTokens:['same-account-device']}});
    const successor = await login();
    const fresh = await server.inject({method:'POST',url:'/devices/push-token',headers:{authorization:`Bearer ${successor.accessToken}`},payload:{token:'same-account-device',platform:'android'}});
    assert.equal(fresh.statusCode,200);
    await server.inject({method:'POST',url:'/auth/logout',payload:{refreshToken:old.refreshToken,pushTokens:['same-account-device']}});
    assert.ok(await prisma.workerPushToken.findUnique({where:{token:'same-account-device'}}));
    assert.equal((await me(successor.accessToken)).statusCode,200);
    await prisma.workerPushToken.deleteMany({where:{token:'same-account-device'}});
  });
  for (const invalidation of ['logout', 'replay', 'password'] as const) {
    await t.test(`registration authenticated before ${invalidation} cannot commit after invalidation`, async () => {
      const old = await login();
      const originalVersion = (await prisma.workers.findUniqueOrThrow({where:{workerId:worker.workerId}})).authVersion;
      if (invalidation === 'replay') assert.equal((await server.inject({method:'POST',url:'/auth/refresh',payload:{refreshToken:old.refreshToken}})).statusCode,200);
      const original = prisma.authRefreshSession.findUnique.bind(prisma.authRefreshSession);
      let start!:()=>void; let release!:()=>void; let paused = false;
      const started = new Promise<void>(resolve=>{start=resolve;});
      const gate = new Promise<void>(resolve=>{release=resolve;});
      (prisma.authRefreshSession as any).findUnique = async (args:any) => {
        const snapshot = await original(args);
        if (!paused) { paused=true; start(); await gate; }
        return snapshot;
      };
      const pending = server.inject({method:'POST',url:'/devices/push-token',headers:{authorization:`Bearer ${old.accessToken}`},payload:{token:'delayed-device',platform:'android'}});
      try {
        await started;
        if (invalidation === 'logout') {
          await server.inject({method:'POST',url:'/auth/logout',payload:{refreshToken:old.refreshToken,pushTokens:['delayed-device']}});
          const other = await prisma.workers.findFirstOrThrow({where:{workerName:'Auth manager'}});
          await prisma.workerPushToken.create({data:{workerId:other.workerId,token:'delayed-device',platform:'android'}});
        } else if (invalidation === 'replay') {
          assert.equal((await server.inject({method:'POST',url:'/auth/refresh',payload:{refreshToken:old.refreshToken}})).statusCode,401);
        } else {
          await prisma.workers.update({where:{workerId:worker.workerId},data:{authVersion:{increment:1}}});
        }
        release(); const result = await pending;
        assert.equal(result.statusCode,401);
        const binding = await prisma.workerPushToken.findUnique({where:{token:'delayed-device'}});
        if (invalidation === 'logout') assert.notEqual(binding?.workerId,worker.workerId);
        else assert.equal(binding,null);
      } finally {
        release(); await pending; (prisma.authRefreshSession as any).findUnique=original;
        await prisma.workerPushToken.deleteMany({where:{token:'delayed-device'}});
        await prisma.workers.update({where:{workerId:worker.workerId},data:{authVersion:originalVersion}});
      }
    });
  }
  await t.test('refresh replay revokes the successor session', async () => {
    const s = await login(); const rotate = (token:string) => server.inject({method:'POST',url:'/auth/refresh',payload:{refreshToken:token}});
    const first = await rotate(s.refreshToken); assert.equal(first.statusCode,200); const successor = first.json(); assert.equal((await rotate(s.refreshToken)).statusCode,401); assert.equal((await rotate(successor.refreshToken)).statusCode,401); assert.equal((await me(successor.accessToken)).statusCode,401);
  });
  await t.test('concurrent refresh replay revokes even the winning successor', async () => {
    const s = await login(); const responses = await Promise.all([1,2].map(()=>server.inject({method:'POST',url:'/auth/refresh',payload:{refreshToken:s.refreshToken}})));
    assert.deepEqual(responses.map(r=>r.statusCode).sort(),[200,401]); const success = responses.find(r=>r.statusCode===200)!.json();
    assert.equal((await me(success.accessToken)).statusCode,401); assert.equal((await server.inject({method:'POST',url:'/auth/refresh',payload:{refreshToken:success.refreshToken}})).statusCode,401);
  });
  await t.test('concurrent bad logins cannot bypass the account failure budget', async () => {
    await prisma.authAttemptLimit.deleteMany();
    const responses = await Promise.all(Array.from({length:20},()=>server.inject({method:'POST',url:'/auth/login',payload:{cpf:'99999999999',password:'wrong'}})));
    assert.equal(responses.filter(r=>r.statusCode===401).length,10);
    assert.equal(responses.filter(r=>r.statusCode===429).length,10);
    const accountKey = digest('login:cpf:99999999999');
    await prisma.authAttemptLimit.update({where:{key:accountKey},data:{expiresAt:new Date(Date.now()-1000)}});
    assert.equal((await server.inject({method:'POST',url:'/auth/login',payload:{cpf:'99999999999',password:'wrong'}})).statusCode,401);
    assert.equal((await prisma.authAttemptLimit.findUnique({where:{key:accountKey}}))?.count,1);
    assert.equal((await server.inject({method:'POST',url:'/auth/login',payload:{cpf:'33333333333',password:'initial-pass'}})).statusCode,200);
  });
  await t.test('signed forwarded client addresses receive separate source budgets', async () => {
    await prisma.authAttemptLimit.deleteMany(); const key=process.env.AUTH_PROXY_SECRET!; const now=String(Math.floor(Date.now()/1000));
    const headers = (ip:string) => ({'x-dms-client-ip':ip,'x-dms-client-time':now,'x-dms-client-signature':createHmac('sha256',key).update(`${now}\nPOST\n/auth/forgot-password\n${ip}`).digest('hex')});
    for (const [cpf,ip] of [['00000000001','192.0.2.1'],['00000000002','192.0.2.2']]) assert.equal((await server.inject({method:'POST',url:'/auth/forgot-password',headers:headers(ip),payload:{cpf}})).statusCode,200);
    const one=await prisma.authAttemptLimit.findUnique({where:{key:digest('forgot:ip:192.0.2.1')}}); const two=await prisma.authAttemptLimit.findUnique({where:{key:digest('forgot:ip:192.0.2.2')}});
    assert.equal(one?.count,1); assert.equal(two?.count,1);
  });
  await t.test('successful logins do not spend the account failure budget', async () => {
    for (let i=0; i<11; i++) { const r = await server.inject({method:'POST',url:'/auth/login',payload:{cpf:'33333333333',password:'initial-pass'}}); assert.equal(r.statusCode,200); }
  });
  await t.test('stale authenticated password writer cannot overwrite a completed reset', async () => {
    await prisma.authAttemptLimit.deleteMany(); const s = await login();
    await prisma.authRecoveryToken.create({data:{id:randomUUID(),workerId:worker.workerId,authVersion:0,tokenHash:digest('race-reset'),purpose:'reset',expiresAt:new Date(Date.now()+600000)}});
    const original = prisma.workers.updateMany.bind(prisma.workers); let ready!:()=>void; let release!:()=>void;
    const blocked = new Promise<void>(resolve => { ready=resolve; }); const gate = new Promise<void>(resolve=>{ release=resolve; }); let first=true;
    (prisma.workers as any).updateMany = async (args:any) => { if (first && args.data.password) { first=false; ready(); await gate; } return original(args); };
    const stale = server.inject({method:'PUT',url:'/auth/me',headers:{authorization:`Bearer ${s.accessToken}`},payload:{currentPassword:'initial-pass',newPassword:'other-password'}});
    await blocked; const reset = await server.inject({method:'POST',url:'/auth/reset-password',payload:{token:'race-reset',newPassword:'58290417'}}); assert.equal(reset.statusCode,200); release(); const result = await stale; (prisma.workers as any).updateMany = original;
    const current = await prisma.workers.findUniqueOrThrow({where:{workerId:worker.workerId}}); assert.notEqual(result.statusCode,200); assert.equal(await compare('58290417',Buffer.from(current.password).toString()),true);
    await prisma.workers.update({where:{workerId:worker.workerId},data:{password,authVersion:{increment:1}}});
  });
  await t.test('replacing recovery email invalidates links to the previous mailbox', async () => {
    const currentVersion = (await prisma.workers.findUniqueOrThrow({where:{workerId:worker.workerId}})).authVersion;
    const old = await prisma.authRecoveryToken.create({data:{id:randomUUID(),workerId:worker.workerId,authVersion:currentVersion,tokenHash:digest('old-link'),purpose:'reset',expiresAt:new Date(Date.now()+600000)}});
    await prisma.authRecoveryToken.create({data:{id:randomUUID(),workerId:worker.workerId,authVersion:currentVersion,tokenHash:digest('confirm-link'),purpose:'confirm',email:'new@example.test',expiresAt:new Date(Date.now()+600000)}});
    assert.equal((await server.inject({method:'POST',url:'/auth/verify-recovery-email',payload:{token:'confirm-link'}})).statusCode,200);
    assert.equal((await server.inject({method:'POST',url:'/auth/reset-password',payload:{token:'old-link',newPassword:'58290417'}})).statusCode,400);
    assert.ok((await prisma.authRecoveryToken.findUnique({where:{id:old.id}}))?.consumedAt);
  });
  await t.test('concurrent email replacement and reset issuance leave no usable old-mailbox link', async () => {
    await prisma.authAttemptLimit.deleteMany();
    const current = await prisma.workers.update({where:{workerId:worker.workerId},data:{recoveryEmail:'race-old@example.test',recoveryEmailVerified:true}});
    await prisma.authRecoveryToken.create({data:{id:randomUUID(),workerId:worker.workerId,authVersion:current.authVersion,tokenHash:digest('race-confirm'),purpose:'confirm',email:'race-new@example.test',expiresAt:new Date(Date.now()+600000)}});
    const start = new Date();
    const results = await Promise.all([server.inject({method:'POST',url:'/auth/verify-recovery-email',payload:{token:'race-confirm'}}),server.inject({method:'POST',url:'/auth/forgot-password',payload:{cpf:'33333333333'}})]);
    assert.deepEqual(results.map(r=>r.statusCode),[200,200]);
    const oldLinks = await prisma.authRecoveryToken.findMany({where:{workerId:worker.workerId,purpose:'reset',email:'race-old@example.test',createdAt:{gte:start}}});
    assert.ok(oldLinks.every(r=>r.consumedAt));
  });
  await t.test('weak replacement passwords do not consume a valid reset link', async () => {
    const current = await prisma.workers.findUniqueOrThrow({where:{workerId:worker.workerId}});
    await prisma.authRecoveryToken.create({data:{id:randomUUID(),workerId:worker.workerId,authVersion:current.authVersion,tokenHash:digest('policy-link'),purpose:'reset',expiresAt:new Date(Date.now()+600000)}});
    for (let i=0; i<5; i++) assert.equal((await server.inject({method:'POST',url:'/auth/reset-password',payload:{token:'policy-link',newPassword:'11111111'}})).statusCode,400);
    assert.equal((await server.inject({method:'POST',url:'/auth/reset-password',payload:{token:'policy-link',newPassword:'58290417'}})).statusCode,200);
  });
  await t.test('concurrent reset token redemption succeeds only once', async () => {
    const current = await prisma.workers.findUniqueOrThrow({where:{workerId:worker.workerId}});
    await prisma.authRecoveryToken.create({data:{id:randomUUID(),workerId:worker.workerId,authVersion:current.authVersion,tokenHash:digest('double-reset'),purpose:'reset',expiresAt:new Date(Date.now()+600000)}});
    const responses = await Promise.all([1,2].map(()=>server.inject({method:'POST',url:'/auth/reset-password',payload:{token:'double-reset',newPassword:'58290417'}})));
    assert.deepEqual(responses.map(r=>r.statusCode).sort(),[200,400]);
  });
  await t.test('one-minute resend cooldown persists and mail stays encrypted', async () => {
    await prisma.authAttemptLimit.deleteMany(); await prisma.authMailOutbox.deleteMany();
    const request = () => server.inject({method:'POST',url:'/auth/forgot-password',payload:{cpf:'33333333333'}});
    assert.equal((await request()).statusCode,200); assert.equal((await request()).statusCode,200);
    const jobs = await prisma.authMailOutbox.findMany(); assert.equal(jobs.length,1); assert.doesNotMatch(jobs[0].payload,/race-new@example\.test|recuperar-senha/);
  });
  await t.test('outbox sends readable reset and change notices without disclosing passwords', async () => {
    const { enqueueMail, processOutbox } = await import('../src/lib/auth/outbox'); await prisma.authMailOutbox.deleteMany();
    await prisma.$transaction(async tx=>{ await enqueueMail(tx,{email:'new@example.test',token:'synthetic-token',purpose:'reset'}); await enqueueMail(tx,{email:'new@example.test',purpose:'notice'}); });
    const sent:any[]=[]; const oldFetch=globalThis.fetch; globalThis.fetch=(async (_url:any, options:any)=>{sent.push(JSON.parse(options.body)); return new Response('{}',{status:200});}) as typeof fetch;
    try { await processOutbox(); await processOutbox(); } finally { globalThis.fetch=oldFetch; }
    assert.equal(sent.length,2); const reset = sent.find(x=>x.subject==='Recuperar senha'); const notice = sent.find(x=>x.subject==='Sua senha foi alterada');
    assert.match(reset.text,/20 minutos/); assert.match(reset.text,/ignore/); assert.match(reset.html,/recuperar-senha/); assert.match(reset.html,/Redefinir senha/);
    assert.ok(notice); assert.doesNotMatch(JSON.stringify(sent),/58290417|33333333333|initial-pass/);
  });
  await t.test('forgot password does not wait for email network delivery', async () => {
    await prisma.authAttemptLimit.deleteMany();
    let release!: () => void; const oldFetch = globalThis.fetch; globalThis.fetch = (() => new Promise<Response>(resolve => { release=()=>resolve(new Response('{}',{status:200})); })) as typeof fetch;
    const request = server.inject({method:'POST',url:'/auth/forgot-password',payload:{cpf:'33333333333'}});
    const completed = await Promise.race([request.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),250))]);
    if (release) release(); await request; globalThis.fetch = oldFetch; assert.equal(completed,true);
  });
  await server.close(); await prisma.$disconnect();
});
