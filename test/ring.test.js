/**
 * Тесты геометрии кольца: разрывы, толщина, скорость, отталкивание.
 * Модуль чистый, поэтому проверяется без браузера и без ожидания кадров.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Ring, RING_KIND, aimGapAtPlayer, angleDistance, createRing, normalizeAngle, pickKind, thicknessFor, travelSecondsFor } from '../src/core/ring.js';
import { mulberry32 } from '../src/core/random.js';
import {
  BASE_ESCAPE_SPEED,
  CLEAN_WINDOW_RAD,
  CRUSH_RADIUS,
  DANGER_RADIUS,
  ESCAPE_REMOVE_RADIUS,
  GAP_AIM_LEAD_SEC,
  GAP_SPAN,
  RING_THICKNESS_FAR,
  RING_THICKNESS_NEAR,
  SPAWN_RADIUS,
  TRAVEL_MIN_SEC,
  TRAVEL_START_SEC,
} from '../src/core/constants.js';

const PROFILE = { name: 'test', jaggedTimeSec: 90, magnetTimeSec: 120 };

test('нормализация угла приводит любые значения в [0, 2π)', () => {
  assert.equal(normalizeAngle(0), 0);
  assert.ok(Math.abs(normalizeAngle(-Math.PI / 2) - (Math.PI * 1.5)) < 1e-9);
  assert.ok(normalizeAngle(Math.PI * 7) >= 0);
  assert.ok(normalizeAngle(-Math.PI * 7) < Math.PI * 2);
});

test('угловая разница считается по короткой дуге', () => {
  const eps = 1e-9;
  assert.ok(Math.abs(angleDistance(0.1, Math.PI * 2 - 0.1) - 0.2) < eps);
  assert.ok(Math.abs(angleDistance(0, Math.PI) - Math.PI) < eps);
  assert.equal(angleDistance(1, 1), 0);
});

test('скорость кольца растёт по времени партии и упирается в предел', () => {
  assert.equal(travelSecondsFor(0), TRAVEL_START_SEC);
  assert.equal(travelSecondsFor(29.9), TRAVEL_START_SEC);
  assert.ok(travelSecondsFor(30) < TRAVEL_START_SEC);
  assert.equal(travelSecondsFor(1000), TRAVEL_MIN_SEC);
});

test('кольцо у центра толще, чем на краю', () => {
  assert.ok(Math.abs(thicknessFor(SPAWN_RADIUS) - RING_THICKNESS_FAR) < 1e-9);
  assert.ok(Math.abs(thicknessFor(0) - RING_THICKNESS_NEAR) < 1e-9);
  assert.ok(thicknessFor(DANGER_RADIUS / 2) > RING_THICKNESS_FAR);
  // Толщина никогда не выходит за объявленные границы, даже вне поля.
  assert.equal(thicknessFor(10), RING_THICKNESS_FAR);
  assert.equal(thicknessFor(-1), RING_THICKNESS_NEAR);
});

test('сплошное кольцо накрывает точку на своём радиусе и не накрывает вдали', () => {
  const ring = new Ring({ kind: RING_KIND.PLAIN, radius: 0.5, speed: 0.2 });
  assert.equal(ring.covers(0.5, 0), true);
  assert.equal(ring.covers(0.5, Math.PI), true);
  assert.equal(ring.covers(0.9, 0), false);
  assert.equal(ring.isInGap(0), false);
});

test('разрыв пропускает точку только внутри своего сектора', () => {
  const ring = new Ring({
    kind: RING_KIND.JAGGED,
    radius: 0.5,
    speed: 0.2,
    gapAngle: 0,
    spin: 0,
  });

  assert.equal(ring.isInGap(0), true);
  assert.equal(ring.isInGap(GAP_SPAN / 2 - 1e-6), true);
  assert.equal(ring.isInGap(GAP_SPAN), false);
  assert.equal(ring.isInGap(Math.PI), false);
  assert.equal(ring.covers(0.5, 0), false);
  assert.equal(ring.covers(0.5, Math.PI), true);
});

test('окно чистого пролёта шире видимого разрыва', () => {
  const ring = new Ring({
    kind: RING_KIND.JAGGED,
    radius: 0.5,
    speed: 0.2,
    gapAngle: 0,
    spin: 0,
  });

  const mid = (GAP_SPAN / 2 + CLEAN_WINDOW_RAD) / 2;
  assert.equal(ring.isInGap(mid), false);
  assert.equal(ring.isCleanPass(mid), true);
  assert.equal(ring.isCleanPass(CLEAN_WINDOW_RAD + 0.01), false);
});

test('aimGapAtPlayer ставит разрыв к подлёту, а не сразу на игрока', () => {
  const speed = SPAWN_RADIUS / 3;
  const spin = 1.1;
  const aimed = aimGapAtPlayer(SPAWN_RADIUS, speed, spin, 0, GAP_AIM_LEAD_SEC);

  assert.ok(angleDistance(aimed, 0) > GAP_SPAN / 2, 'на старте разрыв не смотрит в игрока');

  const eta = SPAWN_RADIUS / speed;
  const atLead = normalizeAngle(aimed + spin * (eta - GAP_AIM_LEAD_SEC));
  assert.ok(angleDistance(atLead, 0) < 1e-6, 'за lead до центра разрыв смотрит в игрока');
});

test('наведённое кольцо часто даёт чистый пролёт у центра', () => {
  let cleans = 0;
  let total = 0;
  for (let i = 0; i < 24; i += 1) {
    const ring = createRing({
      random: mulberry32(`aim-${i}`),
      index: i,
      elapsedSec: 95,
      speedScale: 1,
      profile: PROFILE,
    });
    if (ring.gapAngle === null) continue;
    total += 1;

    let guard = 0;
    while (ring.radius > CRUSH_RADIUS && guard < 20_000) {
      ring.update(1 / 120);
      guard += 1;
    }
    if (ring.isCleanPass(0)) cleans += 1;
  }

  assert.ok(total > 0);
  assert.ok(cleans >= Math.floor(total * 0.4), `ожидали частые чистые пролёты, получили ${cleans}/${total}`);
});

test('разрыв вращается вместе с кольцом', () => {
  const ring = new Ring({
    kind: RING_KIND.JAGGED,
    radius: 0.8,
    speed: 0.2,
    gapAngle: 0,
    spin: 1,
  });
  ring.update(0.5);
  assert.ok(Math.abs(ring.gapAngle - 0.5) < 1e-9);
  assert.ok(ring.radius < 0.8);
});

test('магнит тянет кольцо быстрее, когда оно вошло в зону притяжения', () => {
  const plain = new Ring({ kind: RING_KIND.PLAIN, radius: 0.4, speed: 0.2 });
  const magnet = new Ring({ kind: RING_KIND.MAGNET, radius: 0.4, speed: 0.2 });
  plain.update(0.1);
  magnet.update(0.1);

  assert.equal(magnet.pulling, true);
  assert.equal(plain.pulling, false);
  assert.ok(magnet.radius < plain.radius, 'магнит должен приблизиться сильнее');
});

test('вне зоны магнита притяжения нет', () => {
  const magnet = new Ring({ kind: RING_KIND.MAGNET, radius: 0.9, speed: 0.2 });
  magnet.update(0.1);
  assert.equal(magnet.pulling, false);
  assert.ok(Math.abs(magnet.radius - (0.9 - 0.02)) < 1e-9);
});

test('импульс разворачивает кольцо наружу', () => {
  const ring = new Ring({ kind: RING_KIND.PLAIN, radius: 0.2, speed: 0.3 });

  assert.equal(ring.pushed, false);
  assert.equal(ring.push(), 'pushed');
  assert.equal(ring.pushed, true);

  // Дальше кольцо удаляется от центра, а не приближается к нему.
  const before = ring.radius;
  ring.update(0.2);
  assert.ok(ring.radius > before, 'отбитое кольцо обязано двигаться наружу');
});

test('отбитое кольцо не возвращается к центру', () => {
  const ring = new Ring({ kind: RING_KIND.MAGNET, radius: 0.3, speed: 0.5 });
  ring.push();

  // Даже магнит не должен развернуться обратно: он летит только наружу.
  for (let i = 0; i < 300; i += 1) ring.update(1 / 120);

  assert.ok(ring.radius > ESCAPE_REMOVE_RADIUS, `кольцо осталось в поле: ${ring.radius}`);
});

test('отбитое кольцо улетает наружу быстрее, чем подлетало', () => {
  const ring = new Ring({ kind: RING_KIND.PLAIN, radius: 0.3, speed: 0.05 });
  ring.push();
  assert.ok(ring.escapeSpeed >= BASE_ESCAPE_SPEED, 'медленный отлёт оставит кольцо висеть у игрока');
});

test('повторный импульс по тому же кольцу ничего не меняет', () => {
  const ring = new Ring({ kind: RING_KIND.PLAIN, radius: 0.3, speed: 0.3 });
  ring.push();
  const speed = ring.escapeSpeed;

  assert.equal(ring.push(), 'already');
  assert.equal(ring.escapeSpeed, speed);
});

test('тип кольца включается по времени партии', () => {
  assert.equal(pickKind(0, PROFILE), RING_KIND.PLAIN);
  assert.equal(pickKind(89.9, PROFILE), RING_KIND.PLAIN);
  assert.equal(pickKind(90, PROFILE), RING_KIND.JAGGED);
  assert.equal(pickKind(120, PROFILE), RING_KIND.MAGNET);
  assert.equal(pickKind(999, PROFILE), RING_KIND.MAGNET);
});

test('ранний микс рваных включается только с PRNG и до jagged', () => {
  assert.equal(pickKind(30, PROFILE), RING_KIND.PLAIN);

  const alwaysMix = () => 0;
  assert.equal(pickKind(30, PROFILE, alwaysMix), RING_KIND.JAGGED);

  const neverMix = () => 0.99;
  assert.equal(pickKind(30, PROFILE, neverMix), RING_KIND.PLAIN);

  assert.equal(pickKind(0, PROFILE, alwaysMix), RING_KIND.PLAIN);
});

test('после порога jagged остаётся микс рваных и целых', () => {
  assert.equal(pickKind(90, PROFILE, () => 0), RING_KIND.JAGGED);
  assert.equal(pickKind(90, PROFILE, () => 0.99), RING_KIND.PLAIN);
});

test('createRing воспроизводим по сиду и всегда рождает кольцо вне поля', () => {
  const make = () =>
    ['a', 'b', 'c'].map((_, i) =>
      createRing({ random: mulberry32('seed-1'), index: i, elapsedSec: 0, speedScale: 1, profile: PROFILE }),
    );

  // Каждое кольцо строится из того же генератора: сравниваем стабильность параметров.
  const first = createRing({ random: mulberry32('seed-1'), index: 0, elapsedSec: 0, speedScale: 1, profile: PROFILE });
  const second = createRing({ random: mulberry32('seed-1'), index: 0, elapsedSec: 0, speedScale: 1, profile: PROFILE });

  assert.equal(first.radius, SPAWN_RADIUS);
  assert.equal(first.speed, second.speed);
  assert.equal(first.gapAngle, second.gapAngle);
  assert.equal(first.spin, second.spin);

  const all = make();
  assert.equal(all.length, 3);
  for (const ring of all) assert.ok(ring.radius >= SPAWN_RADIUS - 1e-9);
});

test('на старте кольцо — угроза: разрыв не смотрит в игрока', () => {
  for (let i = 0; i < 40; i += 1) {
    const ring = createRing({
      random: mulberry32(`seed-${i}`),
      index: i,
      elapsedSec: 90.5,
      speedScale: 1,
      profile: PROFILE,
    });
    if (ring.gapAngle === null) continue;
    assert.equal(ring.isInGap(0), false, `кольцо ${i} родилось с разрывом у игрока`);
  }
});

test('общий ускоритель сокращает время полёта', () => {
  const slow = createRing({ random: mulberry32(1), index: 0, elapsedSec: 0, speedScale: 1, profile: PROFILE });
  const fast = createRing({ random: mulberry32(1), index: 0, elapsedSec: 0, speedScale: 2, profile: PROFILE });
  assert.ok(fast.speed > slow.speed);
});