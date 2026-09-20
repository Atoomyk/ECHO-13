/**
 * Рендер игрового поля на Canvas 2D.
 *
 * Стиль: чистый чёрный фон и белый свет. Свечение — альфа-градиент из
 * нескольких проходов, а не размытие: так кадр стоит одинаково дёшево
 * на слабом телефоне и не требует WebGL.
 *
 * Модуль ничего не решает про правила: он только рисует снимок состояния.
 */

import { GAP_SPAN, PULSE_REACH, RING_THICKNESS_FAR, SPAWN_RADIUS } from '../core/constants.js';
import { RING_KIND, angleDistance } from '../core/ring.js';

/** Сколько сегментов рисуется на кольцо: больше — плавнее, дороже. */
const ARC_STEP_RAD = 0.09;
/** Длина шлейфа после импульса, в секундах. */
const ECHO_LIFE_SEC = 0.3;
/** Сколько живёт вспышка от касания кольца. */
const FLASH_LIFE_SEC = 0.22;
/** Пул частиц: заранее созданные объекты вместо аллокаций в кадре. */
const PARTICLE_POOL = 420;
/** Длина фрагмента кольца: сколько сегментов рвёт радиус кольца. */
const RING_SEGMENT_LENGTH = 0.07;
/** Ниже этого радиуса кольцо уже в центре: рвать нечего, летит мелкая крошка. */
const BURST_MIN_SEGMENT_RADIUS = 0.12;
/** Запасная толщина осколка, если событие импульса пришло без thickness. */
const RING_THICKNESS_FALLBACK = RING_THICKNESS_FAR;
/** Сколько секунд точка горит красным после удара. */
const HIT_TINT_SEC = 0.22;
/** Сколько секунд точка горит голубым после успешного импульса. */
const PULSE_TINT_SEC = 0.2;
/** Цвет точки при успешном импульсе. */
const PULSE_TINT_COLOR = '#4FC3F7';
/** Цвет точки при попадании кольца. */
const HIT_TINT_COLOR = '#FF3B3B';

/**
 * Частица из пула. Создаётся один раз, дальше только переиспользуется.
 */
class Particle {
  constructor() {
    this.active = false;
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.life = 0;
    this.maxLife = 1;
    this.size = 1;
    this.spin = 0;
    this.rotation = 0;
    this.length = 0;
  }

  spawn(x, y, angle, speed, life, size) {
    this.active = true;
    this.x = x;
    this.y = y;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.life = life;
    this.maxLife = life;
    this.size = size;
    this.spin = 0;
    this.rotation = angle;
    this.length = 0;
  }

  /**
   * Осколок кольца: летит наружу по своему радиусу и закручивается.
   * Ориентация сохраняется от исходной касательной кольца.
   * @param {number} x
   * @param {number} y
   * @param {number} angle угол точки на кольце
   * @param {number} speed скорость отлёта
   * @param {number} life секунды
   * @param {number} length длина черты в пикселях буфера
   * @param {number} spin угловая скорость вращения, градусов в секунду
   */
  spawnShard(x, y, angle, speed, life, length, spin) {
    this.active = true;
    this.x = x;
    this.y = y;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.life = life;
    this.maxLife = life;
    this.size = 1;
    this.spin = spin;
    this.rotation = angle + Math.PI / 2;
    this.length = length;
  }

  update(dt) {
    if (!this.active) return;
    this.life -= dt;
    if (this.life <= 0) {
      this.active = false;
      return;
    }
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Осколок кольца тормозит без гравитации и вращается вокруг себя.
    if (this.length > 0) {
      this.vx *= 0.94;
      this.vy *= 0.94;
      this.rotation += this.spin * dt;
      return;
    }

    // Затухание: частица тормозит и слегка «садится» вниз, как осыпающаяся пыль.
    this.vx *= 0.96;
    this.vy = this.vy * 0.96 + 0.35 * dt;
  }
}

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    /** Масштаб мир → пиксели: половина меньшей стороны минус отступ. */
    this.scale = 1;
    this.cx = 0;
    this.cy = 0;
    this.dpr = 1;
    /** Считает, сколько кадров подряд длится инверсия — эффект на один кадр. */
    this.invertFrames = 0;
    this.echoes = [];
    this.particles = Array.from({ length: PARTICLE_POOL }, () => new Particle());
    this.particleCursor = 0;
    this.reducedMotion = false;
    /** Пульсация точки синхронизирована с «сердцем»: 60 уд/мин, ускоряется к 120. */
    this.heartbeat = 0;
    /** Остаток вспышки точки: удар (красный) и импульс (голубой). */
    this.hitTintSec = 0;
    this.pulseTintSec = 0;
    this.resize();
  }

  /** Подогнать буфер под размер окна с учётом плотности пикселей. */
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));

    // На слабых телефонах ограничиваем DPR: 2x достаточно для резкой картинки.
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * this.dpr);
    this.canvas.height = Math.round(height * this.dpr);

    this.cx = this.canvas.width / 2;
    this.cy = this.canvas.height / 2;
    // Поле вписано в меньшую сторону: на широком экране кольца не растягиваются.
    this.scale = (Math.min(this.canvas.width, this.canvas.height) / 2) / SPAWN_RADIUS;
  }

  /** Включить режим без пульсации — для `prefers-reduced-motion`. */
  setReducedMotion(value) {
    this.reducedMotion = Boolean(value);
  }

  /** Перевести координаты мира в пиксели буфера. */
  toPixels(x, y) {
    return { x: this.cx + x * this.scale, y: this.cy + y * this.scale };
  }

  /** Запустить инверсию экрана: короткая вспышка при касании кольца. */
  flash() {
    this.invertFrames = 1;
  }

  /** Точка вспыхивает красным — кольцо дошло до центра. */
  tintHit(duration = HIT_TINT_SEC) {
    this.hitTintSec = Math.max(this.hitTintSec, duration);
  }

  /** Точка вспыхивает голубым — импульс списался. */
  tintPulse(duration = PULSE_TINT_SEC) {
    this.pulseTintSec = Math.max(this.pulseTintSec, duration);
  }

  /** Волна-эхо от импульса: расширяется и затухает за 300 мс. */
  echo() {
    this.echoes.push({ age: 0, radius: 0 });
  }

  /** Разлёт частиц из точки — используется при проигрыше и разрушении кольца. */
  burst(x, y, count, speed = 0.6, size = 2.4) {
    for (let i = 0; i < count; i += 1) {
      const particle = this.particles[this.particleCursor];
      this.particleCursor = (this.particleCursor + 1) % this.particles.length;

      const angle = Math.random() * Math.PI * 2;
      const velocity = speed * (0.35 + Math.random() * 0.65);
      particle.spawn(x, y, angle, velocity, 0.5 + Math.random() * 0.7, size * (0.5 + Math.random()));
    }
  }

  /**
   * Полный кадр.
   * @param {object} state снимок `PulseGame.snapshot()`
   * @param {number} dt секунды
   * @param {number} bpm текущий пульс точки
   * @param {Array<object>} [bursts] кольца, разрушенные импульсом в этом кадре
   */
  draw(state, dt, bpm = 60, bursts = []) {
    const ctx = this.ctx;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.invertFrames > 0 ? '#ffffff' : '#000000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const invert = this.invertFrames > 0;
    this.invertFrames = Math.max(0, this.invertFrames - 1);
    const fg = invert ? '#000000' : '#ffffff';

    this.heartbeat = (this.heartbeat + dt * (bpm / 60)) % 1;
    this.hitTintSec = Math.max(0, this.hitTintSec - dt);
    this.pulseTintSec = Math.max(0, this.pulseTintSec - dt);

    // Кольцо, отбитое этим кадром, рисуется уже осколками: иначе оно на один
    // кадр показалось бы целым рядом с собственным взрывом.
    const gone = new Set(bursts.map((item) => item.id));

    this.drawPulseReach(ctx, fg);
    this.drawRings(ctx, state.rings, fg, gone);
    this.drawEchoes(ctx, dt, fg);
    this.drawParticles(ctx, dt, fg);
    this.drawPlayer(ctx, state, fg);

    for (const burst of bursts) this.shatterRing(burst);
  }

  /** Едва заметная граница зоны импульса: подсказывает, что дальние кольца не оттолкнуть. */
  drawPulseReach(ctx, fg) {
    const radius = PULSE_REACH * this.scale;
    ctx.save();
    ctx.globalAlpha = 0.07;
    ctx.strokeStyle = fg;
    ctx.lineWidth = Math.max(1, 1 * this.dpr);
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** Кольца: сплошные, рваные (разрыв) и магнитные (тянущая пунктирная дуга). */
  drawRings(ctx, rings, fg, gone = null) {
    const maxSide = Math.max(this.canvas.width, this.canvas.height);

    for (const ring of rings) {
      // Отбитое кольцо уже взорвалось осколками: целую дугу больше не рисуем.
      if (ring.pushed) continue;
      if (gone !== null && gone.has(ring.id)) continue;
      const screenRadius = ring.radius * this.scale;
      if (screenRadius <= 0) continue;
      // Кольцо ушло за кадр: рисовать нечего.
      if (screenRadius > maxSide) continue;

      // Близко к центру кольцо уже не угроза: оно либо отбито, либо прошло.
      // Гасим его, чтобы в центре не скапливалась сплошная белая каша.
      const fade = Math.min(1, Math.max(0, (screenRadius - this.playerRadiusPx()) / (this.scale * 0.18)));
      if (fade <= 0) continue;

      const thickness = Math.max(1 * this.dpr, ring.thickness * this.scale);

      ctx.save();
      ctx.strokeStyle = fg;
      ctx.lineCap = 'round';
      ctx.globalAlpha = fade;

      this.drawRingGlow(ctx, screenRadius, thickness, fg, fade);
      ctx.globalAlpha = fade;
      this.drawRingBody(ctx, ring, screenRadius, thickness, fg);

      ctx.restore();
    }
  }

  /** Радиус точки игрока в пикселях: граница, за которой кольцо считается прошедшим. */
  playerRadiusPx() {
    return Math.max(6, 8 * this.dpr);
  }

  /**
   * Мягкое свечение кольца: три расширяющихся прохода с падающей альфой.
   * Свечение рисуется только у колец на подлёте: у близких к центру оно
   * сливалось в белое пятно и скрывало точку игрока.
   */
  drawRingGlow(ctx, screenRadius, thickness, fg, fade) {
    for (let pass = 3; pass >= 1; pass -= 1) {
      ctx.globalAlpha = 0.045 * pass * fade;
      ctx.lineWidth = thickness * (1 + pass * 1.6);
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, screenRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = fade;
  }

  /** Основная линия кольца с учётом разрыва. */
  drawRingBody(ctx, ring, screenRadius, thickness, fg) {
    ctx.lineWidth = thickness;
    ctx.globalAlpha = 1;

    if (ring.gapAngle === null) {
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, screenRadius, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }

    // Рисуем кольцо сегментами, пропуская сектор разрыва.
    const step = ARC_STEP_RAD;
    ctx.beginPath();
    let drawing = false;

    for (let angle = 0; angle <= Math.PI * 2 + step; angle += step) {
      // Снимок состояния — плоские данные, поэтому разрыв считаем по углу здесь же.
      const inGap = angleDistance(angle, ring.gapAngle) <= GAP_SPAN / 2;
      const x = this.cx + Math.cos(angle) * screenRadius;
      const y = this.cy + Math.sin(angle) * screenRadius;

      if (inGap) {
        drawing = false;
        continue;
      }
      if (!drawing) {
        ctx.moveTo(x, y);
        drawing = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // Края разрыва подсвечиваем: видно, куда наводить разрыв на подлёте.
    this.drawGapEdges(ctx, ring, screenRadius, thickness, fg);

    if (ring.kind === RING_KIND.MAGNET && ring.pulling) {
      this.drawMagnetHint(ctx, screenRadius, thickness, fg);
    }
  }

  /** Яркие кончики у края разрыва — ориентир для «дырка = тайминг». */
  drawGapEdges(ctx, ring, screenRadius, thickness, fg) {
    const half = 0.13;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = thickness * 1.4;
    ctx.strokeStyle = fg;

    for (const side of [-1, 1]) {
      const angle = ring.gapAngle + side * half;
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, screenRadius, angle - 0.05, angle + 0.05);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Пунктир внутри магнитного кольца: показывает, что оно потянет к центру. */
  drawMagnetHint(ctx, screenRadius, thickness, fg) {
    const inner = Math.max(0, screenRadius - thickness * 3);
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = thickness * 0.7;
    ctx.setLineDash([screenRadius * 0.06, screenRadius * 0.09]);
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, inner, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** Волны-эхо от импульса. */
  drawEchoes(ctx, dt, fg) {
    const alive = [];
    for (const echo of this.echoes) {
      echo.age += dt;
      if (echo.age >= ECHO_LIFE_SEC) continue;

      const progress = echo.age / ECHO_LIFE_SEC;
      echo.radius = progress * PULSE_REACH * this.scale;

      ctx.save();
      ctx.globalAlpha = (1 - progress) * 0.5;
      ctx.strokeStyle = fg;
      ctx.lineWidth = Math.max(1 * this.dpr, 3 * this.dpr * (1 - progress));
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, echo.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      alive.push(echo);
    }
    this.echoes = alive;
  }

  /** Частицы из пула: обновляются и рисуются одним проходом. */
  drawParticles(ctx, dt, fg) {
    ctx.save();
    ctx.fillStyle = fg;
    ctx.strokeStyle = fg;
    ctx.lineCap = 'round';

    for (const particle of this.particles) {
      if (!particle.active) continue;
      particle.update(dt);
      if (!particle.active) continue;

      const ratio = particle.life / particle.maxLife;
      const screen = this.toPixels(particle.x, particle.y);

      // Осколок кольца — вращающаяся белая черта, остальные частицы — квадратики.
      if (particle.length > 0) {
        const half = Math.max(1.5, particle.length * ratio * this.dpr) / 2;
        const dx = Math.cos(particle.rotation) * half;
        const dy = Math.sin(particle.rotation) * half;

        ctx.globalAlpha = ratio * 0.85;
        ctx.lineWidth = Math.max(1, this.dpr);
        ctx.beginPath();
        ctx.moveTo(screen.x - dx, screen.y - dy);
        ctx.lineTo(screen.x + dx, screen.y + dy);
        ctx.stroke();
        continue;
      }

      const size = Math.max(1, particle.size * ratio * this.dpr);

      // Квадратики вместо кругов: дешевле и совпадает с минималистичным стилем.
      ctx.globalAlpha = ratio * 0.9;
      ctx.fillRect(screen.x - size / 2, screen.y - size / 2, size, size);
    }

    ctx.restore();
  }

  /** Точка игрока: свечение, тело и пульсация в такт «сердцу». */
  drawPlayer(ctx, state, fg) {
    const beat = this.reducedMotion ? 1 : 1 + Math.sin(this.heartbeat * Math.PI * 2) * 0.08;
    const base = Math.max(4, 6 * this.dpr) * beat;
    const alpha = state.invulnerable ? 0.45 : 1;
    // Удар важнее импульса: при одновременных вспышках остаётся красный.
    const color = this.hitTintSec > 0
      ? HIT_TINT_COLOR
      : this.pulseTintSec > 0
        ? PULSE_TINT_COLOR
        : fg;

    // Свечение: несколько концентрических кругов с малой альфой.
    ctx.save();
    ctx.fillStyle = color;
    for (let pass = 4; pass >= 1; pass -= 1) {
      ctx.globalAlpha = alpha * 0.05 * pass;
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, base * (1 + pass * 0.9), 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, base, 0, Math.PI * 2);
    ctx.fill();

    // Кольцо прицела при высокой точности: маленькая метка внутри точки.
    if (state.multiplier >= 2 && !this.reducedMotion) {
      ctx.globalAlpha = alpha * 0.55;
      ctx.strokeStyle = color === fg ? '#000000' : fg;
      ctx.lineWidth = Math.max(1, 1.5 * this.dpr);
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, base * 0.4, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Взрыв кольца на осколки в точке, где его застал импульс.
   *
   * Осколки расходятся не в стороны, а по радиусам наружу: игрок видит, что
   * кольцо именно разорвано, а не проглочено. Разрыв не рвётся: в нём осколков
   * нет — это визуально подтверждает, что дырка была настоящей.
   *
   * @param {object} ring плоская геометрия из события импульса
   * @param {number} [power] доля от базовой скорости разлёта
   */
  shatterRing(ring, power = 1) {
    if (!(ring.radius > 0)) return;

    // У самого центра сегменты слишком короткие: сыплем крошку вместо дуг.
    if (ring.radius < BURST_MIN_SEGMENT_RADIUS) {
      const dust = Math.min(18, 6 + Math.round(ring.radius * 40));
      for (let i = 0; i < dust; i += 1) {
        const angle = (i / dust) * Math.PI * 2 + (ring.id % 7) * 0.1;
        this.burst(Math.cos(angle) * ring.radius, Math.sin(angle) * ring.radius, 1, 0.5 * power, 2);
      }
      return;
    }

    const length = Math.max(RING_SEGMENT_LENGTH, this.playerRadiusPx() / this.scale) / ring.radius;
    const count = Math.max(6, Math.min(28, Math.round((Math.PI * 2) / length)));

    // Шаг углов берём от id кольца: соседние кольца рассыпаются по-разному,
    // но один и тот же кадр повторяется предсказуемо — без Math.random().
    const seed = (ring.id % 16) / 16;
    const speed = (0.45 + ring.radius * 0.55) * power;
    const thickness = Number.isFinite(ring.thickness) ? ring.thickness : RING_THICKNESS_FALLBACK;

    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2 + seed;
      if (ring.gapAngle !== null && angleDistance(angle, ring.gapAngle) <= GAP_SPAN / 2) continue;

      const particle = this.particles[this.particleCursor];
      this.particleCursor = (this.particleCursor + 1) % this.particles.length;

      const jitter = 0.9 + ((i * 37 + ring.id * 11) % 21) / 100;
      const life = 0.26 + ((i * 13 + ring.id * 7) % 20) / 100;
      const spin = ((i % 2) * 2 - 1) * 480;
      const size = Math.max(1 * this.dpr, thickness * this.scale * 0.8);

      particle.spawnShard(
        Math.cos(angle) * ring.radius,
        Math.sin(angle) * ring.radius,
        angle,
        speed * jitter,
        life,
        size,
        spin,
      );
    }
  }

  /** Рассыпать кольца при проигрыше: точки уходят к центру и гаснут. */
  shatter(state) {
    for (const ring of state.rings) {
      if (ring.radius <= 0) continue;
      const screenRadius = ring.radius * this.scale;
      const count = Math.min(14, 4 + Math.round(screenRadius / 24));

      for (let i = 0; i < count; i += 1) {
        const angle = (i / count) * Math.PI * 2;
        const x = Math.cos(angle) * ring.radius;
        const y = Math.sin(angle) * ring.radius;
        // Частицы летят к центру: кольцо «схлопывается» на игроке.
        this.burst(x, y, 1, 0.35, 3);
      }
    }
  }
}