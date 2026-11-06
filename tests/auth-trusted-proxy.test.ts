import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.DATABASE_URL = 'postgresql://dummy:dummy@localhost:5432/dummy';
process.env.JWT_SECRET = 'test-secret-with-at-least-32-characters';
process.env.NODE_ENV = 'test';
process.env.DMS_TRUSTED_PROXY_CIDRS = '10.0.1.0/24, 198.51.100.0/24, 2001:db8:1::/48';

test('Fastify uses forwarded IP only across configured trusted proxies', async () => {
  const { buildServer } = await import('../src/server');
  const server = buildServer();
  server.get('/test-ip', async req => ({ ip: req.ip }));
  await server.ready();
  const lookup = async (remoteAddress:string, forwarded:string) => (await server.inject({method:'GET',url:'/test-ip',remoteAddress,headers:{'x-forwarded-for':forwarded}})).json().ip;
  assert.equal(await lookup('10.0.1.4','192.0.2.123, 203.0.113.9, 198.51.100.10'),'203.0.113.9');
  assert.equal(await lookup('10.0.1.4','203.0.113.9, 192.0.2.3'),'192.0.2.3');
  assert.equal(await lookup('192.0.2.88','203.0.113.9, 198.51.100.10'),'192.0.2.88');
  assert.equal(await lookup('10.0.1.4','2001:db8:2::5, 2001:db8:1::10'),'2001:db8:2::5');
  await server.close();
});

test('trust defaults off and unsafe proxy configurations fail closed', async () => {
  const { buildServer } = await import('../src/server');
  const server = buildServer(''); server.get('/test-ip', async req => ({ip:req.ip}));
  const response = await server.inject({method:'GET',url:'/test-ip',remoteAddress:'10.0.1.4',headers:{'x-forwarded-for':'203.0.113.9'}});
  assert.equal(response.json().ip,'10.0.1.4'); await server.close();
  assert.throws(() => buildServer('', 'cf-connecting-ip'));
  for (const unsafe of ['0.0.0.0/0','::/0','true','10.0.1.0/33','10.0.1.0/24,,198.51.100.0/24']) assert.throws(() => buildServer(unsafe),undefined,unsafe);
});

test('Cloudflare client header overrides untrusted forwarding only from an explicit trusted peer', async () => {
  const { buildServer } = await import('../src/server');
  const server = buildServer('10.0.1.28/32', 'cf-connecting-ip');
  server.get('/test-ip', async req => ({ ip: req.ip })); await server.ready();
  const lookup = async (remoteAddress:string, headers:Record<string,string>) => (await server.inject({method:'GET',url:'/test-ip',remoteAddress,headers})).json().ip;
  assert.equal(await lookup('10.0.1.28', {'cf-connecting-ip':'203.0.113.9'}), '203.0.113.9');
  assert.equal(await lookup('10.0.1.28', {'cf-connecting-ip':'203.0.113.9','x-forwarded-for':'192.0.2.55'}), '203.0.113.9');
  assert.equal(await lookup('10.0.1.28', {'cf-connecting-ip':'2001:db8::42'}), '2001:db8::42');
  assert.equal(await lookup('10.0.1.29', {'cf-connecting-ip':'203.0.113.9','x-forwarded-for':'192.0.2.55'}), '10.0.1.29');
  assert.equal(await lookup('10.0.1.28', {'cf-connecting-ip':'203.0.113.9, 192.0.2.55','x-forwarded-for':'192.0.2.55'}), '10.0.1.28');
  assert.equal(await lookup('10.0.1.28', {'x-forwarded-for':'192.0.2.55'}), '10.0.1.28');
  assert.equal(await lookup('10.0.1.28', {'cf-connecting-ip':'not-an-ip','x-forwarded-for':'192.0.2.55'}), '10.0.1.28');
  await server.close();
});

test('Cloudflare client header is ignored by default', async () => {
  const { buildServer } = await import('../src/server');
  const server = buildServer('10.0.1.28/32'); server.get('/test-ip', async req => ({ip:req.ip}));
  const response = await server.inject({method:'GET',url:'/test-ip',remoteAddress:'10.0.1.28',headers:{'cf-connecting-ip':'203.0.113.9'}});
  assert.equal(response.json().ip,'10.0.1.28'); await server.close();
});
