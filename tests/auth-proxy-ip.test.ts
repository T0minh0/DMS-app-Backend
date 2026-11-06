import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { clientIp } from '../src/lib/auth/proxy-ip';
const secret = 'shared-test-secret-at-least-32-characters';
const ts = '1800000000', ip = '2001:db8::1';
const signature = (time:string, method:string, path:string, address:string) => createHmac('sha256',secret).update(`${time}\n${method}\n${path}\n${address}`).digest('hex');
test('trusted forwarding requires a current signature over canonical IP, method and path', () => {
  const headers = {'x-dms-client-ip':ip,'x-dms-client-time':ts,'x-dms-client-signature':signature(ts,'POST','/auth/reset-password',ip)};
  const request = {headers, method:'POST', url:'/auth/reset-password', ip:'127.0.0.1'};
  assert.equal(clientIp(request,secret,1800000000),ip);
  assert.equal(clientIp({...request,url:'/auth/forgot-password'},secret,1800000000),'127.0.0.1');
  assert.equal(clientIp(request,secret,1800000061),'127.0.0.1');
  assert.equal(clientIp({...request,headers:{...headers,'x-dms-client-signature':'0'.repeat(64)}},secret,1800000000),'127.0.0.1');
  assert.equal(clientIp(request,undefined,1800000000),'127.0.0.1');
});
