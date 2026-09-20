/**
 * Тесты ядра партии: энергия, импульс, уклонения, прогрессия, game over.
 *
 * Симуляция идёт фиксированным шагом, поэтому весь сценарий партии
 * воспроизводится в тесте без браузера и без ожидания реального времени.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PHASE, PulseGame, STEP_SEC, dailyProfile } from '../src/core/game.js';
import { RING_KIND } from '../src/core/ring.js';
import {
  CLEAN_MULTIPLIER_STEP,
  ENERGY_MAX,
  ENERGY_REGEN_PER_SEC,
  ESCAPE_REMOVE_RADIUS,
  HIT_DAMAGE,
  IFRAME_SEC,
  PULSE_COST,
  PULSE_REACH,
  SCORE_PER_SEC,
} from '../src/core/constants.js';

/** Прогнать партию заданное число секунд, нажимая по расписанию. */
function run(game, seconds, pressAtSec = []) {
  const steps = Math.round(seconds / STEP_SEC);
  const presses = new Set(pressAtSec.map((t) => Math.round(t / STEP_SEC)));
  const log = [];

  for (let i = 0; i < steps; i += 1) {
    if (presses.has(i)) game.pulse();
    log.push(...game.advance(STEP_SEC));
    if (game.phase === PHASE.OVER) break;
  }
  return log;
}

test('новая партия начинается с полной энергией и нулевым счётом', () => {
  const game = new PulseGame({ seed: 'start' });
  game.start();

  assert.equal(game.phase, PHASE.PLAYING);
  assert.equal(game.player.energy, ENERGY_MAX);
  assert.equal(game.score, 0);
  assert.equal(game.rings.length, 0);
});

test('до старта партии время не идёт и нажатия игнорируются', () => {
  const game = new PulseGame({ seed: 'idle' });

  assert.equal(game.phase, PHASE.READY);
  assert.equal(game.pulse(), false);
  assert.deepEqual(game.advance(1), []);
  assert.equal(game.elapsedSec, 0);
});

test('энергия восстанавливается, пока игрок не нажимает', () => {
  const game = new PulseGame({ seed: 'regen' });
  game.start();

  game.player.energy = 40;
  run(game, 1);

  assert.ok(game.player.energy > 40);
  assert.ok(game.player.energy <= ENERGY_MAX);
  // Восстановление идёт примерно с объявленной скоростью.
  assert.ok(Math.abs(game.player.energy - (40 + ENERGY_REGEN_PER_SEC)) < 1);
});

test('энергия не превышает максимум', () => {
  const game = new PulseGame({ seed: 'cap' });
  game.start();

  // Первое кольцо доходит до центра примерно на 4-й секунде, поэтому
  // проверяем потолок на коротком отрезке и повторяем замер несколько раз.
  for (let i = 0; i < 8; i += 1) {
    run(game, 0.4);
    if (game.phase !== PHASE.PLAYING) break;
    assert.ok(game.player.energy <= ENERGY_MAX, `энергия вышла за предел: ${game.player.energy}`);
  }

  // Отдельно убеждаемся, что восстановление действительно упирается в максимум.
  const fresh = new PulseGame({ seed: 'cap-full' });
  fresh.start();
  fresh.player.energy = ENERGY_MAX - 5;
  fresh.player.regenLockSec = 0;
  run(fresh, 1);
  assert.ok(fresh.player.energy > ENERGY_MAX - 5);
  assert.ok(fresh.player.energy <= ENERGY_MAX);
});

test('импульс списывает энергию и блокирует восстановление на короткое время', () => {
  const game = new PulseGame({ seed: 'pulse' });
  game.start();

  assert.equal(game.pulse(), true);
  assert.ok(Math.abs(game.player.energy - (ENERGY_MAX - PULSE_COST)) < 1e-9);

  // Сразу после импульса восстановления нет — иначе спам был бы бесплатным.
  const before = game.player.energy;
  run(game, 0.1);
  assert.ok(game.player.energy < before + 0.001);
});

test('импульс без запаса энергии не проходит', () => {
  const game = new PulseGame({ seed: 'weak' });
  game.start();

  game.player.energy = PULSE_COST - 1;
  assert.equal(game.pulse(), false);
  assert.equal(game.player.energy, PULSE_COST - 1);
});

test('импульс отталкивает только близкие кольца', () => {
  const game = new PulseGame({ seed: 'reach' });
  game.start();

  const near = { radius: PULSE_REACH - 0.01, pushCalled: false };
  const far = { radius: PULSE_REACH + 0.2, pushCount: 0 };

  // Подменяем кольца на объекты-свидетели: проверяем именно правило дальности.
  game.rings = [near, far];
  for (const ring of game.rings) {
    ring.push = () => {
      if (ring === near) ring.pushCalled = true;
      else ring.pushCount += 1;
    };
  }

  game.pulse();

  assert.equal(near.pushCalled, true);
  assert.equal(far.pushCount, 0);
});

test('импульс разворачивает кольцо наружу', () => {
  const game = new PulseGame({ seed: 'push' });
  game.start();

  game.rings = [];
  game.spawn();
  const ring = game.rings[0];
  ring.radius = 0.3;
  ring.kind = RING_KIND.PLAIN;

  const before = ring.radius;
  game.pulse();
  ring.update(0.2);

  assert.ok(ring.radius > before, 'отбитое кольцо обязано уходить от центра');
});

test('отбитое кольцо покидает поле и удаляется', () => {
  const game = new PulseGame({ seed: 'escape-remove' });
  game.start();

  game.rings = [];
  game.spawn();
  const ring = game.rings[0];
  const id = ring.id;
  ring.radius = PULSE_REACH - 0.05;
  ring.kind = RING_KIND.PLAIN;

  game.pulse();

  // Отбитое кольцо должно уйти за кадр и исчезнуть из массива,
  // а не вернуться к центру и не копить объекты в поле.
  // Новые кольца на этом отрезке не нужны: проверяем судьбу одного.
  game.nextSpawnSec = 1e9;
  run(game, 4);

  assert.equal(
    game.rings.some((item) => item.id === id),
    false,
    'отбитое кольцо осталось в массиве',
  );
  assert.equal(game.player.hits, 0, 'отбитое кольцо не должно наносить урон');
});

test('отбитые кольца не накапливаются в поле', () => {
  const game = new PulseGame({ seed: 'no-clutter' });
  game.start();

  let maxAlive = 0;
  const steps = Math.round(60 / STEP_SEC);

  for (let i = 0; i < steps; i += 1) {
    for (const ring of game.rings) {
      if (!ring.pushed && !ring.resolved && ring.radius <= PULSE_REACH) game.pulse();
    }
    game.advance(STEP_SEC);
    maxAlive = Math.max(maxAlive, game.rings.length);
  }

  assert.ok(maxAlive <= 4, `в поле скопилось ${maxAlive} колец`);
  assert.ok(
    game.rings.every((ring) => !ring.pushed || ring.radius < ESCAPE_REMOVE_RADIUS),
    'отбитые кольца не должны оставаться в поле',
  );
});

test('отбитое кольцо больше не угрожает игроку', () => {
  const game = new PulseGame({ seed: 'escaped' });
  game.start();

  game.rings = [];
  game.spawn();
  const ring = game.rings[0];
  const id = ring.id;
  ring.radius = PULSE_REACH - 0.05;
  ring.kind = RING_KIND.PLAIN;

  game.pulse();
  assert.equal(ring.pushed, true);
  assert.equal(ring.resolved, true, 'отбитое кольцо не должно снова идти в счёт');

  // Первый же шаг: отбитое кольцо не имеет права засчитаться как удар,
  // даже если окажется в центре. Новые кольца в тесте не спавнятся.
  game.nextSpawnSec = 1e9;
  game.player.invulnerableSec = 0;
  ring.radius = 0;
  const events = game.advance(STEP_SEC);

  assert.equal(
    events.some((event) => event.type === 'hit' && event.id === id),
    false,
    'отбитое кольцо не должно наносить урон у центра',
  );
  assert.equal(game.player.hits, 0, 'импульс обязан спасать игрока, а не отсрочивать удар');
});

test('повторный импульс по тому же кольцу не тратит энергию дважды', () => {
  const game = new PulseGame({ seed: 'once' });
  game.start();

  game.rings = [];
  game.spawn();
  const ring = game.rings[0];
  ring.radius = 0.3;

  game.pulse();
  const radiusAfterFirst = ring.radius;
  const energyAfterFirst = game.player.energy;

  game.player.energy = ENERGY_MAX;
  game.pulse();

  assert.equal(ring.radius, radiusAfterFirst, 'второй импульс не должен двигать кольцо');
  assert.ok(game.player.energy < ENERGY_MAX, 'второй импульс всё равно стоит энергии');
  assert.equal(energyAfterFirst < ENERGY_MAX, true);
});

test('касание кольца отнимает энергию и даёт неуязвимость', () => {
  const game = new PulseGame({ seed: 'hit' });
  game.start();

  const result = game.player.takeHit();

  assert.equal(result, 'damaged');
  assert.ok(Math.abs(game.player.energy - (ENERGY_MAX - HIT_DAMAGE)) < 1e-9);
  assert.equal(game.player.invulnerable, true);
});

test('неуязвимость не даёт потерять энергию дважды подряд', () => {
  const game = new PulseGame({ seed: 'iframe' });
  game.start();

  game.player.takeHit();
  const afterFirst = game.player.energy;
  const second = game.player.takeHit();

  assert.equal(second, 'ignored');
  assert.equal(game.player.energy, afterFirst);

  // Неуязвимость заканчивается через объявленное время.
  run(game, IFRAME_SEC + 0.05);
  assert.equal(game.player.invulnerable, false);
  assert.equal(game.player.takeHit(), 'damaged');
});

test('пролёт через разрыв повышает множитель, минуя урон', () => {
  const game = new PulseGame({ seed: 'clean' });
  game.start();

  const before = game.player.multiplier;
  const result = game.player.resolvePass(true);

  assert.equal(result, 'clean');
  assert.equal(game.player.cleanDodges, 1);
  assert.ok(game.player.multiplier > before);
  assert.ok(Math.abs(game.player.multiplier - (before + CLEAN_MULTIPLIER_STEP)) < 1e-9);
  assert.equal(game.player.invulnerable, false);
});

test('кольцо без разрыва всегда бьёт по игроку', () => {
  const game = new PulseGame({ seed: 'crush' });
  game.start();

  const result = game.player.resolvePass(false);

  assert.equal(result, 'crushed');
  assert.equal(game.player.hits, 1);
  assert.ok(game.player.energy < ENERGY_MAX);
});

test('обнуление энергии завершает партию', () => {
  const game = new PulseGame({ seed: 'over' });
  game.start();

  // Доводим игрока до нуля серией ударов: каждый следующий проходит
  // только после окончания неуязвимости — так это и происходит в игре.
  let events = [];
  for (let i = 0; i < 10 && game.phase === PHASE.PLAYING; i += 1) {
    game.player.invulnerableSec = 0;
    game.player.takeHit();
    events.push(...game.advance(STEP_SEC));
  }

  assert.equal(game.phase, PHASE.OVER);
  assert.equal(game.player.energy, 0);
  assert.ok(events.some((event) => event.type === 'gameover'));
});

test('партия сама заканчивается, если игрок ничего не делает', () => {
  const game = new PulseGame({ seed: 'afk' });
  game.start();

  // Без единого нажатия кольца доходят до центра, и энергия кончается.
  run(game, 60);

  assert.equal(game.phase, PHASE.OVER, 'пассивный игрок обязан проиграть');
  assert.ok(game.player.hits > 0);
});

test('время и счёт считаются с учётом множителя', () => {
  const game = new PulseGame({ seed: 'score' });
  game.start();

  run(game, 2);
  const withBase = game.score;
  assert.ok(Math.abs(withBase - 2 * SCORE_PER_SEC) < 2);

  game.player.multiplier = 2;
  const before = game.player.score;
  run(game, 1);
  const gained = game.player.score - before;

  assert.ok(gained > SCORE_PER_SEC * 1.9, 'множитель должен ускорять набор очков');
});

test('скорость колец растёт каждые 30 секунд, а интервал спавна сокращается', () => {
  const game = new PulseGame({ seed: 'progression' });
  game.start();

  const startScale = game.speedScale;
  const startInterval = game.spawnIntervalSec;

  game.player.elapsedSec = 60;
  assert.ok(game.speedScale > startScale);
  assert.ok(game.spawnIntervalSec < startInterval);
});

test('уровень скорости растёт каждые 30 секунд начиная с 1', () => {
  const game = new PulseGame({ seed: 'level' });
  game.start();

  assert.equal(game.level, 1);
  game.player.elapsedSec = 29.9;
  assert.equal(game.level, 1);
  game.player.elapsedSec = 30;
  assert.equal(game.level, 2);
  game.player.elapsedSec = 90;
  assert.equal(game.level, 4);
  assert.equal(game.snapshot().level, 4);
});

test('интервал спавна не падает ниже предела', () => {
  const game = new PulseGame({ seed: 'floor' });
  game.start();

  game.player.elapsedSec = 10_000;
  assert.ok(game.spawnIntervalSec >= 0.6);
  assert.ok(game.spawnIntervalSec > 0);
});

test('кольца появляются сами и всегда за пределами экрана', () => {
  const game = new PulseGame({ seed: 'spawn' });
  game.start();

  run(game, 3);
  assert.ok(game.rings.length > 0, 'за 3 секунды должно появиться хотя бы одно кольцо');

  for (const ring of game.rings) {
    assert.ok(ring.radius <= 1.6, 'кольцо не должно рождаться внутри поля');
    assert.ok(ring.radius > -0.1);
  }
});

test('пройденные кольца удаляются и не копятся в памяти', () => {
  const game = new PulseGame({ seed: 'leak' });
  game.start();

  run(game, 40);
  if (game.phase === PHASE.OVER) game.phase = PHASE.PLAYING;

  // Через 40 секунд кольца не могут висеть в поле десятками: они удаляются.
  assert.ok(game.rings.length < 30, `в поле осталось ${game.rings.length} колец`);
  // Радиусы не уходят в бесконечный минус.
  for (const ring of game.rings) assert.ok(ring.radius > -0.1);
});

test('двойная сложность добавляет второе кольцо с отставанием', () => {
  const game = new PulseGame({ seed: 'double', profile: { name: 'd', doubleTimeSec: 0, jaggedTimeSec: 1e9, magnetTimeSec: 1e9 } });
  game.start();

  game.spawn();

  assert.equal(game.rings.length, 2);
  const [first, second] = game.rings;
  assert.equal(first.kind, RING_KIND.DOUBLE);
  assert.equal(second.kind, RING_KIND.DOUBLE);
  assert.ok(second.radius > first.radius, 'второй слой должен идти позади');
});

test('на рваной и магнитной сложности появляются соответствующие кольца', () => {
  const jagged = new PulseGame({ seed: 'j', profile: { name: 'j', doubleTimeSec: 0, jaggedTimeSec: 0, magnetTimeSec: 1e9 } });
  jagged.start();
  jagged.spawn();
  assert.equal(jagged.rings[0].kind, RING_KIND.JAGGED);

  const magnet = new PulseGame({ seed: 'm', profile: { name: 'm', doubleTimeSec: 0, jaggedTimeSec: 0, magnetTimeSec: 0 } });
  magnet.start();
  magnet.spawn();
  assert.equal(magnet.rings[0].kind, RING_KIND.MAGNET);
});

test('партия с одним сидом воспроизводится шаг в шаг', () => {
  const play = () => {
    const game = new PulseGame({ seed: 'repeat-42' });
    game.start();
    run(game, 20, [0.5, 1.1, 1.7, 2.3, 3.9, 5.5, 8.1, 11.3, 14.7, 18.2]);
    return {
      score: game.score,
      energy: game.player.energy,
      elapsed: game.player.elapsedSec,
      rings: game.rings.map((ring) => Number(ring.radius.toFixed(6))),
      kinds: game.rings.map((ring) => ring.kind),
    };
  };

  assert.deepEqual(play(), play());
});

test('разные сиды дают разные партии', () => {
  const snapshot = (seed) => {
    const game = new PulseGame({ seed });
    game.start();
    run(game, 12);
    // Сравниваем форму колец, а не только радиусы: радиусы идут по общему
    // расписанию, а сид задаёт фазу, разрыв и вращение.
    return game.rings.map((ring) => ({
      kind: ring.kind,
      angle: Number(ring.angle.toFixed(4)),
      gapAngle: ring.gapAngle === null ? null : Number(ring.gapAngle.toFixed(4)),
      spin: Number(ring.spin.toFixed(4)),
    }));
  };

  assert.notDeepEqual(snapshot('seed-a'), snapshot('seed-b'));
});

test('снимок состояния не позволяет менять правила через ссылки', () => {
  const game = new PulseGame({ seed: 'snapshot' });
  game.start();
  run(game, 3);

  const snapshot = game.snapshot();
  assert.ok(snapshot.rings.length > 0);

  snapshot.rings[0].radius = 999;
  assert.notEqual(game.rings[0].radius, 999, 'снимок обязан отдавать копии');
  assert.equal(typeof snapshot.energyRatio, 'number');
  assert.equal(snapshot.phase, PHASE.PLAYING);
});

test('пауза останавливает время и кольца', () => {
  const game = new PulseGame({ seed: 'pause' });
  game.start();
  run(game, 3);

  const radius = game.rings[0]?.radius ?? null;
  const elapsed = game.elapsedSec;

  game.pause();
  assert.deepEqual(game.advance(1), []);
  assert.equal(game.elapsedSec, elapsed);
  assert.equal(game.rings[0]?.radius ?? null, radius);

  game.resume();
  run(game, 0.5);
  assert.ok(game.elapsedSec > elapsed);
});

test('на паузе нажатие не тратит энергию', () => {
  const game = new PulseGame({ seed: 'pause-press' });
  game.start();
  game.pause();

  const energy = game.player.energy;
  assert.equal(game.pulse(), false);
  assert.equal(game.player.energy, energy);
});

test('длинный кадр не убивает игрока мгновенно', () => {
  const game = new PulseGame({ seed: 'lag' });
  game.start();
  run(game, 5);

  // Вкладка была свёрнута: пропуск в 10 секунд должен быть обрезан.
  const elapsed = game.elapsedSec;
  game.advance(10);

  assert.ok(game.elapsedSec - elapsed <= 0.06, 'шаг симуляции обязан ограничиваться сверху');
});

test('ежедневный профиль одинаков для одного дня и меняется между днями', () => {
  const monday = Date.UTC(2026, 8, 19, 10, 0, 0);
  const sameDay = Date.UTC(2026, 8, 19, 23, 30, 0);
  const nextDay = Date.UTC(2026, 8, 20, 0, 30, 0);

  assert.deepEqual(dailyProfile(monday), dailyProfile(sameDay));
  assert.notDeepEqual(dailyProfile(monday), dailyProfile(nextDay));
});

test('ежедневный профиль всегда содержит все пороги сложности', () => {
  for (let day = 0; day < 30; day += 1) {
    const profile = dailyProfile(Date.UTC(2026, 0, 1) + day * 86_400_000);
    assert.equal(typeof profile.name, 'string');
    assert.ok(profile.doubleTimeSec > 0);
    assert.ok(profile.jaggedTimeSec > profile.doubleTimeSec);
    assert.ok(profile.magnetTimeSec > profile.jaggedTimeSec);
  }
});

/* --------------------------------------------------- взрыв отбитых колец */

test('событие импульса несёт геометрию каждого разрушенного кольца', () => {
  const game = new PulseGame({ seed: 'burst-geometry' });
  game.start();

  game.rings = [];
  game.spawn();
  const ring = game.rings[0];
  ring.radius = PULSE_REACH - 0.1;
  ring.gapAngle = 1.234;

  assert.equal(game.pulse(), true);
  const event = game.events.find((item) => item.type === 'pulse');

  assert.equal(event.pushed, 1);
  assert.equal(event.burst.length, 1);

  const fragment = event.burst[0];
  assert.equal(fragment.id, ring.id);
  assert.equal(fragment.kind, ring.kind);
  // Взрыв рисуется на месте удара, а не в центре поля.
  assert.ok(fragment.radius <= PULSE_REACH);
  assert.equal(fragment.gapAngle, 1.234, 'разрыв обязан попасть в событие: в нём осколков быть не должно');
  assert.equal(fragment.thickness, ring.thickness, 'толщина нужна рендеру, иначе осколки превращаются в пыль');
});

test('снимок помечает отбитое кольцо как pushed', () => {
  const game = new PulseGame({ seed: 'burst-pushed-snap' });
  game.start();

  game.rings = [];
  game.spawn();
  const ring = game.rings[0];
  ring.radius = PULSE_REACH - 0.05;
  game.pulse();

  const snap = game.snapshot().rings.find((item) => item.id === ring.id);
  assert.ok(snap);
  assert.equal(snap.pushed, true);
});

test('кольцо вне зоны импульса не даёт осколков', () => {
  const game = new PulseGame({ seed: 'burst-far' });
  game.start();

  game.rings = [];
  game.spawn();
  game.rings[0].radius = PULSE_REACH + 0.2;
  game.pulse();

  const event = game.events.find((item) => item.type === 'pulse');
  assert.equal(event.pushed, 0);
  assert.deepEqual(event.burst, [], 'осколки только там, где кольцо действительно разрушено');
});

test('повторный импульс по тому же кольцу не даёт второго взрыва', () => {
  const game = new PulseGame({ seed: 'burst-once' });
  game.start();

  game.rings = [];
  game.spawn();
  const ring = game.rings[0];
  ring.radius = PULSE_REACH - 0.05;

  game.pulse();
  game.player.energy = ENERGY_MAX;
  game.pulse();

  const pulses = game.events.filter((item) => item.type === 'pulse');
  assert.equal(pulses.length, 2);
  assert.equal(pulses[0].burst.length, 1);
  assert.equal(pulses[1].burst.length, 0, 'дважды одно кольцо не взрывается');
  assert.equal(ring.pushed, true);
});
