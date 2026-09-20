/**
 * Ввод: мышь, тач, клавиатура и другие нажатия на кнопку.
 *
 * Вся PULSE — одна кнопка, поэтому модуль сводит всё разнообразие ввода
 * к двум событиям: «импульс» и «пауза». Он не знает о правилах игры.
 */

import { PHASE } from '../core/game.js';

/** Пауза после касания, чтобы случайный второй тап не считался двойным нажатием. */
const TAP_GUARD_MS = 120;

export class InputController {
  /**
   * @param {object} handlers
   * @param {() => void} handlers.onPulse
   * @param {() => void} handlers.onPause
   * @param {() => void} handlers.onAnyKey — разбудить звук и снять стартовую заглушку
   */
  constructor({ onPulse, onPause, onAnyKey }) {
    this.onPulse = onPulse;
    this.onPause = onPause;
    this.onAnyKey = onAnyKey;
    this.lastPulseAt = 0;

    this._boundPointer = this.handlePointer.bind(this);
    this._boundKey = this.handleKey.bind(this);
  }

  /** Подписаться на все источники ввода. */
  attach(target) {
    this.target = target;
    target.addEventListener('pointerdown', this._boundPointer, { passive: false });
    window.addEventListener('keydown', this._boundKey);
  }

  /** Отписаться: вызывается при выгрузке, чтобы не оставлять слушателей. */
  detach() {
    this.target?.removeEventListener('pointerdown', this._boundPointer);
    window.removeEventListener('keydown', this._boundKey);
  }

  /**
   * Нажатие мышью или тапом.
   * @param {PointerEvent} event
   */
  handlePointer(event) {
    // Не перехватываем нажатия по интерфейсу: кнопки меню должны работать.
    if (event.target instanceof Element && event.target.closest('[data-ui]')) return;

    event.preventDefault();
    this.onAnyKey?.();
    this.firePulse(event.timeStamp);
  }

  /**
   * Клавиатура: пробел и Enter — импульс, Esc — пауза.
   * @param {KeyboardEvent} event
   */
  handleKey(event) {
    if (event.repeat) return;

    const code = event.code;
    if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      // Пробел прокручивает страницу, если его не остановить.
      event.preventDefault();
      this.onAnyKey?.();
      this.firePulse(event.timeStamp);
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
   */
  firePulse(timestamp) {
    const now = timestamp || Date.now();
    if (now - this.lastPulseAt < TAP_GUARD_MS) return;
    this.lastPulseAt = now;
    this.onPulse?.();
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