/**
 * Ядро PULSE как единый модуль: браузер, тесты и сервер импортируют только отсюда.
 * Никаких DOM и Node API внутри — благодаря этому правила проверяются без окружения.
 */

export { Player } from './player.js';
export {
  Ring,
  RING_KIND,
  createRing,
  pickKind,
  travelSecondsFor,
  thicknessFor,
  normalizeAngle,
  angleDistance,
  aimGapAtPlayer,
  MAGNET_PULL,
  MAGNET_TURN_RADIUS,
} from './ring.js';
export {
  PulseGame,
  PHASE,
  STEP_SEC,
  DEFAULT_PROFILE,
  dailyProfile,
  PLAYER_HIT_RADIUS,
} from './game.js';
export {
  summarize,
  shareGrid,
  shareText,
  maxPlausibleScore,
} from './result.js';
export {
  hashSeed,
  mulberry32,
  dailySeed,
  dayIndex,
  dayKey,
  rangeBetween,
} from './random.js';
export * from './constants.js';