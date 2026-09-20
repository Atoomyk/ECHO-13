/**
 * Ввод: мышь, тач, клавиатура и другие нажатия на кнопку.
 *
 * Single: всё сводится к «импульс» без стороны.
 * Dual: pointerdown даёт сторону L/R (половина экрана / кнопка мыши).
 */

import { PHASE } from '../core/game.js';
import { SIDE } from '../core/constants.js';

/** Пауза после касания, чтобы случайный второй тап не считался двойным нажатием. */
const TAP_GUARD_MS = 120;

export class InputController {
  /**
   * @param {object} handlers
   * @param {(side?: string) => void} handlers.onPulse
   * @param {() => void} handlers.onPause
   * @param {() => void} handlers.onAnyKey — разбудить звук и снять стартовую заглушку
   * @param {() => boolean} [handlers.isDual] — dual: резолвить сторону
   */
  constructor({ onPulse, onPause, onAnyKey, isDual = () => false }) {
    this.onPulse = onPulse;
    this.onPause = onPause;
    this.onAnyKey = onAnyKey;
    this.isDual = isDual;
    this.lastPulseAt = 0;

    this._boundPointer = this.handlePointer.bind(this);
    this._boundKey = this.handleKey.bind(this);
    this._boundContext = this.handleContextMenu.bind(this);
  }

  /** Подписаться на все источники ввода. */
  attach(target) {
    this.target = target;
    target.addEventListener('pointerdown', this._boundPointer, { passive: false });
    target.addEventListener('contextmenu', this._boundContext);
    window.addEventListener('keydown', this._boundKey);
  }

  /** Отписаться: вызывается при выгрузке, чтобы не оставлять слушателей. */
  detach() {
    this.target?.removeEventListener('pointerdown', this._boundPointer);
    this.target?.removeEventListener('contextmenu', this._boundContext);
    window.removeEventListener('keydown', this._boundKey);
  }

  /** ПКМ не должен открывать меню браузера на игровом поле. */
  handleContextMenu(event) {
    event.preventDefault();
  }

  /**
   * Сторона импульса: мышь — ЛКМ=L / ПКМ=R; тач — половина экрана.
   * @param {PointerEvent} event
   * @returns {string|undefined}
   */
  resolveSide(event) {
    if (!this.isDual()) return undefined;

    if (event.pointerType === 'mouse') {
      if (event.button === 2) return SIDE.R;
      return SIDE.L;
    }

    const rect = this.target.getBoundingClientRect();
    const mid = rect.left + rect.width / 2;
    return event.clientX < mid ? SIDE.L : SIDE.R;
  }

  /**
   * Нажатие мышью или тапом.
   * @param {PointerEvent} event
   */
  handlePointer(event) {
    if (event.target instanceof Element && event.target.closest('[data-ui]')) return;

    // В dual игнорируем среднюю кнопку; ЛКМ/ПКМ — стороны.
    if (event.pointerType === 'mouse' && event.button !== 0 && event.button !== 2) return;

    event.preventDefault();
    this.onAnyKey?.();
    this.firePulse(event.timeStamp, this.resolveSide(event));
  }

  /**
   * Клавиатура: пробел и Enter — импульс (в dual — левая сторона), Esc — пауза.
   * @param {KeyboardEvent} event
   */
  handleKey(event) {
    if (event.repeat) return;

    const code = event.code;
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      event.preventDefault();
      this.onAnyKey?.();
      const side = this.isDual() ? SIDE.L : undefined;
      this.firePulse(event.timeStamp, side);
      return;
    }

    if (code === 'Escape' || code === 'KeyP') {
      event.preventDefault();
      this.onPause?.();
    }
  }

  /**
   * Пропустить импульс, если он не является случайным дублем тапа.
   * @param {number} timestamp
   * @param {string} [side]
   */
  firePulse(timestamp, side) {
    const now = timestamp || Date.now();
    if (now - this.lastPulseAt < TAP_GUARD_MS) return;
    this.lastPulseAt = now;
    this.onPulse?.(side);
  }
}

/**
 * Заглушка на время, пока партия ещё не началась: первое нажатие запускает игру.
 * @param {() => boolean} isPlaying
 * @param {() => void} start
 * @returns {() => boolean} — true, если нажатие ушло на старт
 */
export function makeAutoStart(isPlaying, start) {
  return () => {
    if (isPlaying()) return false;
    start();
    return true;
  };
}

/** Обратная связь для интерфейса: на паузе игра не принимает импульсы. */
export function acceptsInput(phase) {
  return phase === PHASE.PLAYING;
}
