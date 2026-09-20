/**
 * Тесты API: валидация результатов, параметры дня, таблица рекордов, статика.
 * Все проверки идут на чистых функциях и файлах — сервер поднимать не нужно.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  HttpError,
  dailyPayload,
  leaderboardPayload,
  parseLeaderboardQuery,
  sanitizeText,
  validateScore,
} from '../server/app.js';
import { resolveSafePath } from '../server/static.js';
import { JsonStore, makeEntry, toPublic } from '../server/store.js';

const VALID = {
  mode: 'free',
  player: 'Максим',
  score: 1250,
  elapsedSec: 95.4,
  cleanDodges: 12,
  hits: 3,
};

test('корректный результат принимается и нормализуется', () => {
  const result = validateScore(VALID);

  assert.equal(result.mode, 'free');
  assert.equal(result.player, 'Максим');
  assert.equal(result.score, 1250);
  assert.equal(result.elapsedSec, 95.4);
  assert.equal(result.day, null);
});

test('режим по умолчанию — свободная игра', () => {
  const result = validateScore({ ...VALID, mode: undefined });
  assert.equal(result.mode, 'free');
});

test('неизвестный режим отклоняется', () => {
  assert.throws(() => validateScore({ ...VALID, mode: 'hack' }), (error) => {
    assert.equal(error instanceof HttpError, true);
    assert.equal(error.code, 'bad_mode');
    return true;
  });
});

test('отрицательные значения отклоняются', () => {
  assert.throws(() => validateScore({ ...VALID, score: -1 }), /отрицательные/);
  assert.throws(() => validateScore({ ...VALID, elapsedSec: -5 }), /отрицательные/);
});

test('нечисловые значения отклоняются', () => {
  assert.throws(() => validateScore({ ...VALID, score: 'много' }), (error) => error.code === 'bad_numbers');
  assert.throws(() => validateScore({ ...VALID, elapsedSec: null }), (error) => error.code === 'bad_numbers');
  assert.throws(() => validateScore({ ...VALID, hits: undefined }), (error) => error.code === 'bad_numbers');
});

test('счёт, невозможный за указанное время, отклоняется', () => {
  // За 10 секунд даже с максимальным множителем нельзя набрать миллион.
  assert.throws(
    () => validateScore({ ...VALID, score: 1_000_000, elapsedSec: 10 }),
    (error) => error.code === 'implausible_score',
  );
});

test('правдоподобный счёт на пределе множителя проходит', () => {
  const result = validateScore({ ...VALID, score: 4_000, elapsedSec: 100 });
  assert.equal(result.score, 4_000);
});

test('пустое имя заменяется на анонима', () => {
  assert.equal(validateScore({ ...VALID, player: '   ' }).player, 'аноним');
  assert.equal(validateScore({ ...VALID, player: null }).player, 'аноним');
});

test('управляющие символы вырезаются из имени', () => {
  const result = validateScore({ ...VALID, player: 'Мак\u0000сим\n' });
  assert.equal(result.player, 'Максим');
});

test('длинное имя обрезается до 24 символов', () => {
  const result = validateScore({ ...VALID, player: 'я'.repeat(80) });
  assert.equal(result.player.length, 24);
});

test('результат ежедневной партии получает номер дня', () => {
  const result = validateScore({ ...VALID, mode: 'daily', day: 20_000 });
  assert.equal(result.day, 20_000);
});

test('день из будущего подменяется сегодняшним', () => {
  const result = validateScore({ ...VALID, mode: 'daily', day: 9_999_999 });
  assert.ok(result.day < 9_999_999);
});

test('не-объект в теле запроса отклоняется', () => {
  assert.throws(() => validateScore(null), (error) => error.code === 'bad_payload');
  assert.throws(() => validateScore('строка'), (error) => error.code === 'bad_payload');
});

test('параметры дня одинаковы в течение суток UTC', () => {
  const morning = new Date('2026-09-19T00:00:01Z').getTime();
  const evening = new Date('2026-09-19T23:59:59Z').getTime();

  assert.deepEqual(dailyPayload(morning), dailyPayload(evening));
});

test('параметры дня меняются после полуночи UTC', () => {
  const before = new Date('2026-09-19T23:59:59Z').getTime();
  const after = new Date('2026-09-20T00:00:01Z').getTime();

  assert.notEqual(dailyPayload(before).seed, dailyPayload(after).seed);
});

test('сид дня содержит дату и узнаваемый префикс', () => {
  const payload = dailyPayload(Date.UTC(2026, 8, 19, 12));
  assert.equal(payload.seed, 'pulse-2026-09-19');
  assert.equal(payload.date, '2026-09-19');
  assert.equal(typeof payload.profile.name, 'string');
});

test('таблица рекордов по умолчанию — свободная игра на 10 строк', () => {
  const query = parseLeaderboardQuery(new URLSearchParams());
  assert.equal(query.mode, 'free');
  assert.equal(query.day, null);
  assert.equal(query.limit, 10);
});

test('предел строк ограничен сотней', () => {
  assert.equal(parseLeaderboardQuery(new URLSearchParams('limit=9999')).limit, 100);
  assert.equal(parseLeaderboardQuery(new URLSearchParams('limit=0')).limit, 1);
  assert.equal(parseLeaderboardQuery(new URLSearchParams('limit=abc')).limit, 10);
});

test('запрос дневной таблицы привязывается к текущему дню', () => {
  const query = parseLeaderboardQuery(new URLSearchParams('mode=daily'));
  assert.equal(query.mode, 'daily');
  assert.equal(typeof query.day, 'number');
});

test('позиция игрока находится в таблице, а неизвестный не получает места', () => {
  const rows = [
    { player: 'Аня', score: 900, elapsed_sec: 40, clean_dodges: 3, hits: 1 },
    { player: 'Борис', score: 700, elapsed_sec: 30, clean_dodges: 2, hits: 0 },
  ];

  assert.equal(leaderboardPayload(rows, 'Борис').rank, 2);
  assert.equal(leaderboardPayload(rows, 'Никто').rank, null);
  assert.equal(leaderboardPayload(rows, '').rank, null);
  assert.equal(leaderboardPayload(rows, 'Аня').entries[0].player, 'Аня');
});

test('публичная запись отдаёт числа нужных типов', () => {
  const publicEntry = toPublic({ player: 'Аня', score: '900', elapsed_sec: '40.5', clean_dodges: '3', hits: '1' });
  assert.equal(publicEntry.score, 900);
  assert.equal(publicEntry.elapsedSec, 40.5);
  assert.equal(publicEntry.cleanDodges, 3);
});

test('sanitizeText устойчив к неожиданным значениям', () => {
  assert.equal(sanitizeText(null, 10), '');
  assert.equal(sanitizeText(undefined, 10), '');
  assert.equal(sanitizeText(12345, 10), '12345');
  assert.equal(sanitizeText('abcdef', 3), 'abc');
});

test('день челленджа всегда положителен и не превышает сегодня', () => {
  const payload = dailyPayload();
  assert.ok(payload.day > 0);
  assert.ok(payload.day <= Math.floor(Date.now() / 86_400_000));
});

/* --------------------------------------------------------------- хранилище */

test('JSON-хранилище сохраняет и отдаёт рекорды по убыванию', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-'));
  const file = path.join(dir, 'scores.json');
  const store = new JsonStore(file);

  store.insert(makeEntry({ ...VALID, score: 100 }));
  store.insert(makeEntry({ ...VALID, score: 500 }));
  store.insert(makeEntry({ ...VALID, score: 300 }));

  const top = store.top({ mode: 'free', day: null, limit: 2 });
  assert.equal(top[0].score, 500);
  assert.equal(top[1].score, 300);
  assert.equal(store.stats('free').games, 3);
  assert.equal(store.stats('free').best, 500);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('JSON-хранилище разделяет свободные рекорды и дневные', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-'));
  const store = new JsonStore(path.join(dir, 'scores.json'));

  store.insert(makeEntry({ ...VALID, mode: 'free', score: 100 }));
  store.insert(makeEntry({ ...VALID, mode: 'daily', score: 900, day: 20_000 }));

  assert.equal(store.top({ mode: 'free', day: null, limit: 10 }).length, 1);
  assert.equal(store.top({ mode: 'daily', day: 20_000, limit: 10 }).length, 1);
  assert.equal(store.top({ mode: 'daily', day: 1, limit: 10 }).length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------------------------------------------------------------- статика */

test('безопасный путь остаётся внутри корня проекта', () => {
  const root = path.resolve('.');

  assert.ok(resolveSafePath(root, '/')?.endsWith('index.html'));
  assert.ok(resolveSafePath(root, '/styles.css')?.endsWith('styles.css'));
  assert.equal(resolveSafePath(root, '/../../secret.txt'), null);
  assert.equal(resolveSafePath(root, '/..%2f..%2fsecret.txt'), null);
});

test('любая попытка выйти из корня блокируется', () => {
  const root = path.resolve('.');

  // Сырой путь, закодированный, смешанный и с обратными слэшами Windows.
  const attacks = [
    '/../../package.json',
    '/..%2f..%2fpackage.json',
    '/%2e%2e/%2e%2e/package.json',
    '/src/../../package.json',
    '/..\\..\\package.json',
    '/%2e%2e%5c%2e%2e%5cpackage.json',
  ];

  for (const attack of attacks) {
    assert.equal(resolveSafePath(root, attack), null, `обход не заблокирован: ${attack}`);
  }
});

test('битая кодировка в пути не ломает разбор', () => {
  const root = path.resolve('.');
  assert.equal(resolveSafePath(root, '/%zz'), null);
  assert.equal(resolveSafePath(root, '/%e0%a4%a'), null);
});