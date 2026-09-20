/**
 * Тесты входа на сайт: пароль, lockout, токены.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { HttpError } from '../server/app.js';
import { GATE_LOCK_MS, GATE_MAX_ATTEMPTS, SiteGate, safeEqualText } from '../server/gate.js';

test('safeEqualText сравнивает строки', () => {
  assert.equal(safeEqualText('12345', '12345'), true);
  assert.equal(safeEqualText('12345', '12346'), false);
  assert.equal(safeEqualText('a', 'aa'), false);
});

test('верный пароль выдаёт токен', () => {
  const gate = new SiteGate({ password: '12345' });
  const { token } = gate.unlock('1.2.3.4', '12345');
  assert.ok(token.length > 10);
  assert.equal(gate.verify(token), true);
});

test('неверный пароль отклоняется', () => {
  const gate = new SiteGate({ password: '12345' });
  assert.throws(() => gate.unlock('10.0.0.1', 'wrong'), (error) => {
    assert.equal(error instanceof HttpError, true);
    assert.equal(error.code, 'bad_password');
    assert.equal(error.status, 401);
    return true;
  });
});

test('три ошибки блокируют IP на 5 минут', () => {
  let now = 1_000_000;
  const gate = new SiteGate({ password: 'secret', now: () => now });
  const ip = '9.9.9.9';

  for (let i = 0; i < GATE_MAX_ATTEMPTS - 1; i += 1) {
    assert.throws(() => gate.unlock(ip, 'nope'), (e) => e.code === 'bad_password');
  }

  assert.throws(() => gate.unlock(ip, 'nope'), (error) => {
    assert.equal(error.code, 'locked');
    assert.equal(error.status, 429);
    return true;
  });

  const status = gate.status(ip);
  assert.equal(status.locked, true);
  assert.ok(status.retryAfterSec > 0);

  assert.throws(() => gate.unlock(ip, 'secret'), (e) => e.code === 'locked');

  now += GATE_LOCK_MS + 1;
  const { token } = gate.unlock(ip, 'secret');
  assert.ok(gate.verify(token));
});

test('пустой пароль отключает gate', () => {
  const gate = new SiteGate({ password: '' });
  assert.equal(gate.enabled, false);
  assert.equal(gate.verify('anything'), true);
  const { token } = gate.unlock('1.1.1.1', '');
  assert.ok(token);
});
