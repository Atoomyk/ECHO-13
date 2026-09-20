/**
 * Точка входа PULSE: связывает ядро правил, рендер, звук, ввод и интерфейс.
 *
 * Здесь и только здесь живут DOM, таймеры и сеть. Ядро об этом не знает,
 * поэтому его поведение проверяется тестами без браузера.
 */

import { PHASE, PulseGame, STEP_SEC, dailyProfile } from './core/game.js';
import { GAME_MODE, RULES_VERSION, SIDE } from './core/constants.js';
import { dayIndex, dailySeed } from './core/random.js';
import { shareGrid, shareText, summarize } from './core/result.js';
import {
  clearGateToken,
  fetchDaily,
  fetchGateStatus,
  fetchLeaderboard,
  getBest,
  getBestDaily,
  getGateToken,
  getPlayerName,
  getSoundEnabled,
  saveBest,
  setGateToken,
  setPlayerName,
  setSoundEnabled,
  submitScore,
  unlockGate,
  verifyGateToken,
} from './ui/api.js';
import { InputController } from './ui/input.js';
import { Renderer } from './ui/render.js';
import { Sound } from './ui/sound.js';

/** Интервал «тиков» пульсации: от 60 уд/мин в начале до 120 на пределе сложности. */
const TICK_MIN_INTERVAL_SEC = 1;
const TICK_MAX_INTERVAL_SEC = 0.5;

/** Партия считается «свежей»: первое нажатие запускает игру, а не тратит энергию. */
const game = new PulseGame();
const renderer = new Renderer(document.getElementById('field'));
const sound = new Sound();

let ticking = false;
let usingDaily = false;
let usingDual = false;
let dailyInfo = null;
let tickAccumulator = 0;
let lastFrameMs = performance.now();
let running = false;

/** Короткие ссылки на элементы интерфейса. */
const el = {
  hud: document.getElementById('hud'),
  score: document.getElementById('hud-score'),
  time: document.getElementById('hud-time'),
  energyBar: document.getElementById('hud-energy-bar'),
  energy: document.getElementById('hud-energy'),
  mode: document.getElementById('hud-mode'),
  pauseBtn: document.getElementById('btn-pause'),
  menu: document.getElementById('menu'),
  rules: document.getElementById('rules'),
  scores: document.getElementById('scores'),
  scoresTitle: document.getElementById('scores-title'),
  scoresList: document.getElementById('scores-list'),
  scoresEmpty: document.getElementById('scores-empty'),
  pause: document.getElementById('pause'),
  over: document.getElementById('over'),
  overTitle: document.getElementById('over-title'),
  overScore: document.getElementById('over-score'),
  overTime: document.getElementById('over-time'),
  overClean: document.getElementById('over-clean'),
  overHits: document.getElementById('over-hits'),
  overGrid: document.getElementById('over-grid'),
  overRecord: document.getElementById('over-record'),
  tapHint: document.getElementById('tap-hint'),
  bestScore: document.getElementById('best-score'),
  bestDaily: document.getElementById('best-daily'),
  name: document.getElementById('input-name'),
  soundBtn: document.getElementById('btn-sound'),
  toast: document.getElementById('toast'),
  rotateGate: document.getElementById('rotate-gate'),
  siteGate: document.getElementById('site-gate'),
  siteGateForm: document.getElementById('site-gate-form'),
  siteGatePassword: document.getElementById('site-gate-password'),
  siteGateError: document.getElementById('site-gate-error'),
};

/* ------------------------------------------------------------- утилиты */

/**
 * Показать только одну панель, остальные скрыть.
 * @param {HTMLElement|null} visible
 */
function showPanel(visible) {
  for (const panel of [el.menu, el.rules, el.scores, el.pause, el.over]) {
    panel.hidden = panel !== visible;
  }
  el.hud.hidden =
    visible === el.menu || visible === el.scores || visible === el.rules;
}

/** Сообщение внизу экрана. */
let toastTimer = 0;
function toast(message, ms = 1800) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.toast.hidden = true;
  }, ms);
}

/** Текущий интервал «тика» пульсации: ускоряется вместе со сложностью. */
function tickInterval() {
  const progress = Math.min(1, game.elapsedSec / 120);
  return TICK_MIN_INTERVAL_SEC + (TICK_MAX_INTERVAL_SEC - TICK_MIN_INTERVAL_SEC) * progress;
}

/** Обновить HUD по текущему состоянию. */
function updateHud() {
  el.score.textContent = String(game.score);
  el.time.textContent = game.elapsedSec.toFixed(1);

  const ratio = game.player.energyRatio;
  el.energy.style.width = `${Math.round(ratio * 100)}%`;
  el.energy.classList.toggle('hud__energy-fill--low', ratio < 0.3);
  el.energyBar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));

  const level = `LV ${game.level}`;
  if (usingDual) {
    el.mode.textContent = `${level} · DUAL`;
  } else {
    el.mode.textContent = game.daily ? `${level} · ДЕНЬ` : level;
  }
}

/** Обновить строки личных рекордов в меню. */
function updateBestLabels() {
  el.bestScore.textContent = String(getBest());
  el.bestDaily.textContent = String(getBestDaily());
}

/* -------------------------------------------------------------- партия */

/**
 * Начать партию.
 * Single временно выключен: свободная игра всегда dual.
 * @param {object} [options]
 * @param {boolean} [options.daily]
 */
function startGame({ daily = false } = {}) {
  usingDaily = daily;
  usingDual = !daily;

  const profile = daily ? (dailyInfo?.profile ?? dailyProfile()) : undefined;
  const seed = daily ? (dailyInfo?.seed ?? dailySeed()) : `free-${Date.now()}`;
  const mode = usingDual ? GAME_MODE.DUAL : GAME_MODE.SINGLE;

  game.seed = seed;
  game.profile = profile ?? game.profile;
  game.daily = daily;
  game.mode = mode;
  game.start();

  showPanel(null);
  el.tapHint.hidden = false;
  const hintText = usingDual
    ? 'ЛКМ / ЛЕВАЯ ПОЛОВИНА · ПКМ / ПРАВАЯ'
    : 'НАЖМИ, ЧТОБЫ ИМПУЛЬС';
  // Сохраняем span пульсации, меняем только текстовый узел.
  const pulseMark = el.tapHint.querySelector('.tap-hint__pulse');
  el.tapHint.replaceChildren(pulseMark ?? document.createElement('span'), document.createTextNode(` ${hintText}`));
  if (pulseMark) pulseMark.className = 'tap-hint__pulse';
  updateHud();

  sound.unlock();
  ticking = false;
  tickAccumulator = 0;
  requestLandscape();
  updateOrientationGate();
}

/** Вернуться в главное меню. */
function goToMenu() {
  // READY, а не PAUSED: иначе Esc из меню снова запускал брошенную партию.
  game.phase = PHASE.READY;
  usingDual = false;
  pausedForRotate = false;
  sound.stopAmbient();
  ticking = false;
  showPanel(el.menu);
  el.tapHint.hidden = true;
  updateBestLabels();
  updateOrientationGate();
}

/** Поставить партию на паузу и показать панель. */
function pauseGame() {
  if (game.phase !== PHASE.PLAYING) return;
  game.pause();
  sound.stopAmbient();
  showPanel(el.pause);
}

/** Снять паузу, только если открыта панель паузы — не меню. */
function resumeGame() {
  if (game.phase !== PHASE.PAUSED) return;
  if (el.pause.hidden) return;
  game.resume();
  showPanel(null);
  if (ticking) sound.startAmbient();
}

/** Переключить паузу: Esc / P / кнопка в HUD. */
function togglePause() {
  if (game.phase === PHASE.PLAYING) pauseGame();
  else if (game.phase === PHASE.PAUSED) resumeGame();
}

/**
 * Обработать события, пришедшие из ядра.
 * @param {Array<object>} events
 * @returns {Array<object>} кольца, разрушенные импульсом: рендер рисует их осколками
 */
function handleEvents(events) {
  const bursts = [];

  for (const event of events) {
    switch (event.type) {
      case 'pulse':
        renderer.echo(event.ox ?? 0, event.oy ?? 0);
        // Голубая вспышка и «сброс в белый» только если кольцо реально отбито.
        if (event.pushed > 0) {
          renderer.tintPulse();
          bursts.push(...event.burst);
          sound.shatter(event.pushed);
        }
        sound.pulse(event.pushed);
        break;
      case 'weak':
        sound.weak();
        break;
      case 'clean':
        renderer.burst(event.ox ?? 0, event.oy ?? 0, 10, 0.5, 2);
        sound.clean(event.multiplier);
        break;
      case 'hit':
        renderer.flash();
        renderer.tintHit();
        sound.hit();
        break;
      case 'gameover':
        finishGame(event);
        break;
      default:
        break;
    }
  }

  return bursts;
}

/** Экран проигрыша: результат, рекорд, шаринг. */
function finishGame(event) {
  const result = summarize({
    score: event.score,
    elapsedSec: event.elapsedSec,
    hits: event.hits,
    cleanDodges: event.cleanDodges,
  });

  renderer.shatter(game.snapshot());
  sound.gameOver();
  sound.stopAmbient();
  ticking = false;

  const { isRecord } = saveBest(result.score, usingDaily);
  updateBestLabels();

  el.overTitle.textContent = usingDaily ? 'ЧЕЛЛЕНДЖ ДНЯ' : 'ИГРА ОКОНЧЕНА';
  el.overScore.textContent = String(result.score);
  el.overTime.textContent = `${result.elapsedSec.toFixed(1)} с`;
  el.overClean.textContent = String(result.cleanDodges);
  el.overHits.textContent = String(result.hits);
  el.overGrid.textContent = shareGrid(result);
  el.overRecord.hidden = !isRecord;

  showPanel(el.over);
  el.hud.hidden = true;

  // Результат уходит на сервер, но партия от сети не зависит.
  submitScore({
    mode: usingDaily ? 'daily' : 'free',
    player: getPlayerName(),
    score: result.score,
    elapsedSec: Number(result.elapsedSec.toFixed(2)),
    cleanDodges: result.cleanDodges,
    hits: result.hits,
    day: usingDaily ? dayIndex() : null,
  }).then((response) => {
    if (response?.rank) toast(`МЕСТО В ТАБЛИЦЕ ДНЯ: ${response.rank}`);
  });
}

/* ---------------------------------------------------------------- цикл */

/** Один кадр: правила, рендер, звук пульсации, HUD. */
function frame(now) {
  if (!running) return;

  const dt = Math.min(0.05, (now - lastFrameMs) / 1000);
  lastFrameMs = now;

  /** Кольца, разрушенные в этом кадре: рисуются осколками вместо целой дуги. */
  let bursts = [];

  if (game.phase === PHASE.PLAYING) {
    bursts = handleEvents(game.advance(dt));

    // «Сердце» тикает в такт: сначала реже, к пределу сложности — чаще.
    tickAccumulator += dt;
    if (tickAccumulator >= tickInterval()) {
      tickAccumulator = 0;
      sound.tick(60 + Math.round((game.elapsedSec / 120) * 60));
    }

    // Гул включается, когда игрок начал действовать, и снимается на паузе.
    if (ticking) sound.startAmbient();
    updateHud();
  }

  const bpm = 60 + Math.min(60, (game.elapsedSec / 120) * 60);
  renderer.draw(game.snapshot(), dt, bpm, bursts);

  window.requestAnimationFrame(frame);
}

/* ---------------------------------------------------------------- ввод */

const input = new InputController({
  isDual: () => usingDual && game.mode === GAME_MODE.DUAL,
  onPulse: (side) => {
    sound.unlock();

    if (game.phase === PHASE.READY || game.phase === PHASE.OVER) {
      startGame({ daily: usingDaily });
      return;
    }
    if (game.phase !== PHASE.PLAYING) return;

    // Первое нажатие после старта только «разогревает» звук и гул.
    if (!ticking) {
      ticking = true;
      sound.startAmbient();
    }

    if (usingDual) {
      game.pulse(side === SIDE.R ? SIDE.R : SIDE.L);
    } else {
      game.pulse();
    }
  },
  onPause: () => {
    togglePause();
  },
  onAnyKey: () => {
    sound.unlock();
    el.tapHint.hidden = true;
  },
});

/* ----------------------------------------------------------- интерфейс */

el.pauseBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  sound.unlock();
  togglePause();
});

document.getElementById('btn-dual').addEventListener('click', () => {
  usingDaily = false;
  dailyInfo = null;
  startGame({ daily: false });
});

document.getElementById('btn-daily').addEventListener('click', async () => {
  sound.unlock();
  // Сервер даёт общий сид дня; если он недоступен — считаем день локально.
  dailyInfo = (await fetchDaily()) ?? { seed: dailySeed(), profile: dailyProfile() };
  startGame({ daily: true });
});

document.getElementById('btn-scores').addEventListener('click', async () => {
  await openScores(false);
});

document.getElementById('btn-rules').addEventListener('click', () => {
  showPanel(el.rules);
});

document.getElementById('btn-rules-back').addEventListener('click', () => {
  showPanel(el.menu);
});

document.getElementById('btn-scores-back').addEventListener('click', () => {
  showPanel(el.menu);
});

document.getElementById('btn-resume').addEventListener('click', () => {
  resumeGame();
});

document.getElementById('btn-quit').addEventListener('click', () => {
  goToMenu();
});

document.getElementById('btn-again').addEventListener('click', () => {
  startGame({ daily: usingDaily });
});

document.getElementById('btn-menu').addEventListener('click', () => {
  goToMenu();
});

document.getElementById('btn-share').addEventListener('click', async () => {
  const result = summarize({
    score: game.score,
    elapsedSec: game.elapsedSec,
    hits: game.player.hits,
    cleanDodges: game.player.cleanDodges,
  });

  const day = dayIndex() - 20_000;
  const text = shareText(result, { daily: usingDaily, day });

  try {
    await navigator.clipboard.writeText(text);
    toast('РЕЗУЛЬТАТ СКОПИРОВАН');
  } catch {
    // Буфер обмена может быть недоступен: показываем текст, чтобы скопировать вручную.
    toast('СКОПИРУЙ ВРУЧНУЮ: ' + text.replace(/\n/g, ' '), 4000);
  }
});

el.soundBtn.addEventListener('click', () => {
  const enabled = !sound.enabled;
  sound.setEnabled(enabled);
  setSoundEnabled(enabled);
  el.soundBtn.textContent = enabled ? 'ЗВУК: ВКЛ' : 'ЗВУК: ВЫКЛ';
  el.soundBtn.setAttribute('aria-pressed', String(enabled));
  if (enabled) {
    sound.unlock();
    if (game.phase === PHASE.PLAYING) sound.startAmbient();
  }
});

el.name.addEventListener('change', () => {
  const clean = setPlayerName(el.name.value);
  el.name.value = clean;
});

/** Открыть таблицу рекордов. */
async function openScores(daily) {
  el.scoresTitle.textContent = daily ? 'РЕКОРДЫ ДНЯ' : 'РЕКОРДЫ';
  el.scoresList.replaceChildren();
  el.scoresEmpty.hidden = true;

  showPanel(el.scores);

  const data = await fetchLeaderboard({ limit: 10, daily });
  const entries = data?.entries ?? [];

  if (entries.length === 0) {
    el.scoresEmpty.hidden = false;
    return;
  }

  const player = getPlayerName();
  entries.forEach((entry, index) => {
    const item = document.createElement('li');

    const place = document.createElement('span');
    place.className = 'scores__place';
    place.textContent = `${index + 1}.`;

    const name = document.createElement('span');
    // Имя вводит игрок: только textContent, никакой разметки.
    name.textContent = entry.player || 'аноним';

    const score = document.createElement('span');
    score.className = 'scores__score';
    score.textContent = String(entry.score);

    if (player && entry.player === player) item.style.opacity = '1';
    else item.style.opacity = '0.75';

    item.append(place, name, score);
    el.scoresList.append(item);
  });
}

/* ------------------------------------------------------------- запуск */

/** Нужен ли ландшафт: узкий/тач-экран в портрете. */
function needsLandscape() {
  const portrait = window.innerHeight > window.innerWidth;
  if (!portrait) return false;
  const touch =
    window.matchMedia('(pointer: coarse)').matches ||
    navigator.maxTouchPoints > 0;
  const narrow = Math.min(window.innerWidth, window.innerHeight) <= 920;
  return touch || narrow;
}

/** Попытка lock — работает не везде (часто нужен fullscreen / жест). */
function requestLandscape() {
  const orientation = screen.orientation;
  if (!orientation || typeof orientation.lock !== 'function') return;
  orientation.lock('landscape').catch(() => {
    /* браузер отказал — остаётся оверлей */
  });
}

/** Пауза партии, пока телефон в портрете (оверлей закрывает ввод). */
let pausedForRotate = false;

function updateOrientationGate() {
  const need = needsLandscape();
  if (el.rotateGate) el.rotateGate.hidden = !need;

  if (need) {
    if (game.phase === PHASE.PLAYING) {
      game.pause();
      sound.stopAmbient();
      pausedForRotate = true;
    }
    return;
  }

  if (pausedForRotate && game.phase === PHASE.PAUSED && el.pause.hidden) {
    game.resume();
    if (ticking) sound.startAmbient();
    pausedForRotate = false;
  }
}

/** Подстроить поле под размер окна и учесть системные настройки анимации. */
function handleResize() {
  renderer.resize();
  updateOrientationGate();
}

window.addEventListener('resize', handleResize);
window.addEventListener('orientationchange', () => {
  window.setTimeout(handleResize, 120);
});

// Уважаем системную настройку «меньше движения».
const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
renderer.setReducedMotion(motionQuery.matches);
motionQuery.addEventListener('change', (event) => renderer.setReducedMotion(event.matches));

const portraitQuery = window.matchMedia('(orientation: portrait)');
portraitQuery.addEventListener('change', updateOrientationGate);

// Возврат во вкладку не должен давать огромный пропуск времени.
document.addEventListener('visibilitychange', () => {
  lastFrameMs = performance.now();
  if (document.hidden && game.phase === PHASE.PLAYING) {
    pauseGame();
  }
});

function boot() {
  console.info(`[ECHO dual] RULES_VERSION=${RULES_VERSION}`);

  const savedName = getPlayerName();
  el.name.value = savedName;

  const soundOn = getSoundEnabled();
  sound.setEnabled(soundOn);
  el.soundBtn.textContent = soundOn ? 'ЗВУК: ВКЛ' : 'ЗВУК: ВЫКЛ';
  el.soundBtn.setAttribute('aria-pressed', String(soundOn));

  // Стартовое состояние: фоновая сцена с одним медленным кольцом.
  game.start();
  game.phase = PHASE.READY;
  game.pause();

  input.attach(document.getElementById('tap-surface'));
  showPanel(el.menu);
  updateBestLabels();
  updateOrientationGate();

  running = true;
  lastFrameMs = performance.now();
  window.requestAnimationFrame(frame);

  void runSiteGate();
}

/**
 * Показать ошибку на форме входа.
 * @param {string} message
 */
function setGateError(message) {
  if (!el.siteGateError) return;
  if (!message) {
    el.siteGateError.hidden = true;
    el.siteGateError.textContent = '';
    return;
  }
  el.siteGateError.hidden = false;
  el.siteGateError.textContent = message;
}

function hideSiteGate() {
  if (el.siteGate) el.siteGate.hidden = true;
}

/**
 * Вход по паролю: токен вкладки или форма.
 * @returns {Promise<void>}
 */
async function runSiteGate() {
  if (!el.siteGate || !el.siteGateForm) {
    hideSiteGate();
    return;
  }

  const status = await fetchGateStatus();
  if (status && status.enabled === false) {
    hideSiteGate();
    return;
  }

  const existing = getGateToken();
  if (existing && (await verifyGateToken(existing))) {
    hideSiteGate();
    return;
  }
  if (existing) clearGateToken();

  el.siteGate.hidden = false;
  setGateError('');
  if (status?.locked) {
    setGateError(`слишком много попыток — подождите ${status.retryAfterSec || 300} с`);
  }

  el.siteGateForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = el.siteGatePassword?.value ?? '';
    const submitBtn = el.siteGateForm.querySelector('button[type="submit"]');
    if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = true;
    setGateError('');

    const result = await unlockGate(password);
    if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = false;

    if (result.ok) {
      setGateToken(result.token);
      hideSiteGate();
      el.siteGatePassword.value = '';
      return;
    }

    if (result.error === 'locked') {
      setGateError(result.message || 'слишком много попыток — подождите 5 минут');
    } else if (result.error === 'bad_password') {
      setGateError('неверный пароль');
    } else {
      setGateError(result.message || 'не удалось войти');
    }
    el.siteGatePassword?.focus();
    el.siteGatePassword?.select();
  });

  el.siteGatePassword?.focus();
}

boot();