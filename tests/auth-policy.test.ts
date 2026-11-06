import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { validNewPassword } from '../src/lib/auth/password';

test('numeric worker passwords require eight nontrivial digits', () => {
  for (const value of ['123456','11111111','12345678','87654321','123456789']) assert.equal(validNewPassword(value, 'worker'), false, value);
  assert.equal(validNewPassword('58290417', 'worker'), true);
  assert.equal(validNewPassword('abcdef', 'worker'), true);
  assert.equal(validNewPassword('abcde', 'worker'), false);
});
test('manager passwords are not relaxed to numeric PIN policy', () => {
  assert.equal(validNewPassword('123456', 'manager'), true);
  assert.equal(validNewPassword('12345', 'manager'), false);
});
