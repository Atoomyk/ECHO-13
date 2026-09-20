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
/** RGB голубого импульса / полной оболочки. */
const PULSE_RGB = Object.freeze({ r: 79, g: 195, b: 247 });
/** RGB удара. */
const HIT_RGB = Object.freeze({ r: 255, g: 59, b: 59 });

/**
 * @param {{r: number, g: number, b: number}} a
 * @param {{r: number, g: number, b: number}} b
 * @param {number} t
 * @returns {{r: number, g: number, b: number}}
 */
function mixRgb(a, b, t) {
  const u = Math.min(1, Math.max(0, t));
  return {
    r: Math.round(a.r + (b.r - a.r) * u),
    g: Math.round(a.g + (b.g - a.g) * u),
    b: Math.round(a.b + (b.b - a.b) * u),
  };
}

/** @param {{r: number, g: number, b: number}} c */
function cssRgb(c, a = 1) {
  if (a >= 1) return `rgb(${c.r}, ${c.g}, ${c.b})`;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

/** Затемнить цвет для «низа» шара. */
function shadeRgb(c, factor) {
  return {
    r: Math.round(c.r * factor),
    g: Math.round(c.g * factor),
    b: Math.round(c.b * factor),
  };
}

/**
 * Угроза для окраски точки.
 * @param {Array<object>} rings
 * @returns {{danger: number, safe: number}} danger 0…1 (plain/magnet), safe 0…1 (jagged в reach)
 */
function threatFromRings(rings) {
  let danger = 0;
  let safe = 0;
  for (const ring of rings) {
    if (ring.pushed) continue;
    if (ring.radius > PULSE_REACH || ring.radius <= 0) continue;
    // От 0 у границы reach до 1 у центра — плавное краснение.
    const raw = 1 - ring.radius / PULSE_REACH;
    const eased = Math.min(1, Math.max(0, Math.pow(raw, 0.85)));

    if (ring.kind === RING_KIND.JAGGED) {
      if (eased > safe) safe = eased;
      continue;
    }
    if (ring.kind === RING_KIND.PLAIN || ring.kind === RING_KIND.MAGNET) {
      if (eased > danger) danger = eased;
    }
  }
  return { danger, safe };
}

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

    this.drawRings(ctx, state.rings, fg, gone);
    this.drawEchoes(ctx, dt, fg);
    this.drawParticles(ctx, dt, fg);
    this.drawPlayer(ctx, state, fg);

    for (const burst of bursts) this.shatterRing(burst);
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

      this.drawRingGlow(ctx, ring, screenRadius, thickness, fg, fade);
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
   * Свечение повторяет разрыв — иначе дырка заливается и «пропадает».
   */
  drawRingGlow(ctx, ring, screenRadius, thickness, fg, fade) {
    for (let pass = 3; pass >= 1; pass -= 1) {
      ctx.globalAlpha = 0.045 * pass * fade;
      ctx.lineWidth = thickness * (1 + pass * 1.6);
      this.strokeRingPath(ctx, ring, screenRadius);
    }
    ctx.globalAlpha = fade;
  }

  /** Обвести кольцо с учётом разрыва (или полный круг, если разрыва нет). */
  strokeRingPath(ctx, ring, screenRadius) {
    if (ring.gapAngle === null) {
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, screenRadius, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }

    const step = ARC_STEP_RAD;
    ctx.beginPath();
    let drawing = false;

    for (let angle = 0; angle <= Math.PI * 2 + step; angle += step) {
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
  }

  /** Основная линия кольца с учётом разрыва. */
  drawRingBody(ctx, ring, screenRadius, thickness, fg) {
    ctx.lineWidth = thickness;
    ctx.globalAlpha = 1;
    this.strokeRingPath(ctx, ring, screenRadius);

    if (ring.gapAngle !== null) {
      this.drawGapEdges(ctx, ring, screenRadius, thickness, fg);
    }

    if (ring.kind === RING_KIND.MAGNET) {
      // Пунктир всегда: magnet без разрыва, иначе его не отличить от plain.
      this.drawMagnetHint(ctx, screenRadius, thickness, fg, ring.pulling);
    }
  }

  /** Яркие кончики у края разрыва — ориентир для «дырка = тайминг». */
  drawGapEdges(ctx, ring, screenRadius, thickness, fg) {
    const half = GAP_SPAN / 2;
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

  /**
   * Пунктир внутри магнитного кольца: показывает, что оно потянет к центру.
   * @param {boolean} [pulling] в зоне тяги — ярче
   */
  drawMagnetHint(ctx, screenRadius, thickness, fg, pulling = false) {
    const inner = Math.max(0, screenRadius - thickness * 3);
    ctx.save();
    ctx.globalAlpha = pulling ? 0.55 : 0.28;
    ctx.lineWidth = thickness * (pulling ? 0.9 : 0.7);
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

  /** Точка игрока: объёмный шар с бликом, оболочка энергии, сигналы угрозы. */
  drawPlayer(ctx, state, fg) {
    const beat = this.reducedMotion ? 1 : 1 + Math.sin(this.heartbeat * Math.PI * 2) * 0.06;
    const base = Math.max(5, 7 * this.dpr) * beat;
    const alpha = state.invulnerable ? 0.45 : 1;
    const energy = Math.min(1, Math.max(0, state.energyRatio ?? 1));
    const { danger, safe } = threatFromRings(state.rings || []);
    const white = { r: 255, g: 255, b: 255 };
    const silver = { r: 210, g: 220, b: 230 };

    // Базовый цвет ядра: удар > импульс > опасность > рваное > белый/серебро.
    let core = mixRgb(white, silver, 0.2);
    if (this.hitTintSec > 0) {
      core = HIT_RGB;
    } else if (this.pulseTintSec > 0) {
      core = { ...PULSE_RGB };
    } else if (danger > 0) {
      core = mixRgb(white, HIT_RGB, danger);
    } else if (safe > 0) {
      core = mixRgb(white, PULSE_RGB, safe * 0.45);
    }

    // Блик медленно «перетекает» по сфере.
    const shimmer = this.reducedMotion ? 0 : this.heartbeat * Math.PI * 2;
    const hx = Math.cos(shimmer) * base * 0.32;
    const hy = Math.sin(shimmer * 0.85) * base * 0.28 - base * 0.12;

    ctx.save();

    // Мягкое свечение вокруг шара.
    const glow = ctx.createRadialGradient(this.cx, this.cy, base * 0.2, this.cx, this.cy, base * 3.2);
    glow.addColorStop(0, cssRgb(core, alpha * 0.28));
    glow.addColorStop(0.45, cssRgb(core, alpha * 0.08));
    glow.addColorStop(1, cssRgb(core, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, base * 3.2, 0, Math.PI * 2);
    ctx.fill();

    // Оболочка энергии.
    const shellRadius = base * (1.55 + energy * 1.35);
    const shellWidth = Math.max(1, (1.2 + energy * 2.2) * this.dpr);
    let shellCalm = white;
    let shellAlpha;
    if (energy < 0.25) {
      shellCalm = white;
      shellAlpha = alpha * (0.22 + energy * 0.8);
    } else {
      const blueT = (energy - 0.25) / 0.75;
      shellCalm = mixRgb(white, PULSE_RGB, 0.35 + blueT * 0.65);
      shellAlpha = alpha * (0.35 + energy * 0.45);
    }
    let shellColor = cssRgb(shellCalm);
    if (danger > 0 && this.hitTintSec <= 0 && this.pulseTintSec <= 0) {
      shellColor = cssRgb(mixRgb(shellCalm, HIT_RGB, danger));
      shellAlpha = Math.min(1, shellAlpha + danger * 0.3);
    } else if (energy < 0.25) {
      shellColor = fg;
    }
    ctx.globalAlpha = shellAlpha;
    ctx.strokeStyle = shellColor;
    ctx.lineWidth = shellWidth;
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, shellRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Объёмное тело: градиент от блика к тёмному краю.
    const body = ctx.createRadialGradient(
      this.cx + hx,
      this.cy + hy,
      base * 0.05,
      this.cx,
      this.cy,
      base,
    );
    const hi = mixRgb(white, core, 0.15);
    const mid = core;
    const lo = shadeRgb(mixRgb(core, { r: 20, g: 24, b: 28 }, 0.35), 0.55);
    body.addColorStop(0, cssRgb(hi, alpha));
    body.addColorStop(0.45, cssRgb(mid, alpha));
    body.addColorStop(1, cssRgb(lo, alpha));
    ctx.globalAlpha = 1;
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, base, 0, Math.PI * 2);
    ctx.fill();

    // Спекулярный блик — маленькое «стеклянное» пятно.
    const specR = base * 0.42;
    const spec = ctx.createRadialGradient(
      this.cx + hx * 1.1,
      this.cy + hy * 1.1,
      0,
      this.cx + hx * 1.1,
      this.cy + hy * 1.1,
      specR,
    );
    spec.addColorStop(0, `rgba(255, 255, 255, ${alpha * 0.9})`);
    spec.addColorStop(0.35, `rgba(255, 255, 255, ${alpha * 0.35})`);
    spec.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = spec;
    ctx.beginPath();
    ctx.arc(this.cx + hx * 1.1, this.cy + hy * 1.1, specR, 0, Math.PI * 2);
    ctx.fill();

    // Холодный обод снизу-справа — лёгкий серебристый перелив.
    if (!this.reducedMotion || danger <= 0) {
      const rim = ctx.createRadialGradient(
        this.cx - hx * 0.6,
        this.cy - hy * 0.4,
        base * 0.3,
        this.cx,
        this.cy,
        base,
      );
      const rimTint =
        this.pulseTintSec > 0
          ? PULSE_RGB
          : danger > 0
            ? mixRgb(silver, HIT_RGB, danger * 0.6)
            : mixRgb(silver, PULSE_RGB, 0.25 + energy * 0.35);
      rim.addColorStop(0, 'rgba(0,0,0,0)');
      rim.addColorStop(0.7, cssRgb(rimTint, alpha * 0.12));
      rim.addColorStop(1, cssRgb(rimTint, alpha * 0.35));
      ctx.fillStyle = rim;
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, base, 0, Math.PI * 2);
      ctx.fill();
    }

    // Разрыв смотрит в центр: тонкое кольцо-подсказка «можно не жать».
    if (state.gapAligned && !this.reducedMotion) {
      ctx.globalAlpha = alpha * 0.7;
      ctx.strokeStyle = PULSE_TINT_COLOR;
      ctx.lineWidth = Math.max(1, 1.5 * this.dpr);
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, Math.max(shellRadius * 1.08, base * 1.85), 0, Math.PI * 2);
      ctx.stroke();
    }

    // Кольцо прицела при высокой точности.
    if (state.multiplier >= 2 && !this.reducedMotion) {
      ctx.globalAlpha = alpha * 0.5;
      ctx.strokeStyle = this.hitTintSec > 0 || this.pulseTintSec > 0 ? fg : 'rgba(0,0,0,0.55)';
      ctx.lineWidth = Math.max(1, 1.5 * this.dpr);
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, base * 0.38, 0, Math.PI * 2);
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