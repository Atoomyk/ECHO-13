/**
 * Константы PULSE.
 *
 * Модуль не зависит ни от DOM, ни от Node API: его импортируют и браузер,
 * и тесты, и сервер (для проверки общего сида дня).
 */

/** Номер версии правил. Меняется при правке баланса или формата сида. */
export const RULES_VERSION = 1;

/** Единица игрового поля. Мир — квадрат [-1, 1] по обеим осям, центр (0, 0). */
export const WORLD_RADIUS = 1;

/** Радиус точки игрока в мировых единицах. */
export const PLAYER_RADIUS = 0.024;

/** Полный запас энергии. */
export const ENERGY_MAX = 100;

/** Стоимость одного импульса. Восстановление 18 ед/с даёт запас прочности на ошибку. */
export const PULSE_COST = 12;

/** Энергия, восстанавливаемая за секунду, пока игрок не нажимает. */
export const ENERGY_REGEN_PER_SEC = 12;

/** Пауза восстановления энергии после импульса. */
export const REGEN_LOCKOUT_SEC = 0.25;

/**
 * Урон от касания кольца. Три ошибки подряд — конец партии:
 * цена ошибки заметна, но не отнимает игру мгновенно.
 */
export const HIT_DAMAGE = 30;

/** Неуязвимость после касания: ошибка не убивает сразу. */
export const IFRAME_SEC = 0.4;

/** Радиус, на котором импульс перестаёт действовать: за ним кольцо уже не спасти. */
export const PULSE_REACH = 0.72;

/**
 * Окно реакции: сколько секунд кольцо идёт от границы зоны импульса до центра.
 * Держим его не меньше секунды — на телефоне с задержкой ввода этого хватает,
 * а при интервале 2.5 с в поле живёт не больше двух колец.
 */
export const REACTION_WINDOW_SEC = 1.05;

/** Кольцо, ушедшее за этот радиус, считается пройденным и удаляется. */
export const CRUSH_RADIUS = 0.012;

/**
 * Скорость, с которой отбитое кольцо покидает поле.
 * Быстрее подлёта, чтобы кольцо уходило за кадр, а не висело у игрока.
 */
export const BASE_ESCAPE_SPEED = 0.9;

/**
 * За этим радиусом отбитое кольцо считается улетевшим и удаляется.
 * Чуть больше SPAWN_RADIUS: кольцо успевает выйти за край кадра.
 */
export const ESCAPE_REMOVE_RADIUS = 1.7;

/** Гарантированный зазор между соседними кольцами при спавне. */
export const MIN_RING_GAP = 0.22;

/** Кольца рождаются за пределами поля, чтобы входить в кадр плавно. */
export const SPAWN_RADIUS = 1.5;

/** Время между появлениями колец: в секундах с началом и полом сложности. */
export const SPAWN_INTERVAL_START_SEC = 2.1;
/**
 * Предел плотности волн. Согласован с окном реакции: игрок обязан успевать
 * отбивать каждое кольцо, но запас времени при этом остаётся небольшим.
 */
export const SPAWN_INTERVAL_MIN_SEC = 1.15;
export const SPAWN_INTERVAL_STEP_SEC = 0.1;

/**
 * Путь кольца от спавна до центра: в секундах, старт, пол и шаг.
 * Пол выведен из окна реакции: кольцо обязано проходить зону импульса
 * не быстрее, чем игрок способен на неё отреагировать.
 */
export const TRAVEL_START_SEC = 3.6;
export const TRAVEL_MIN_SEC = 1.35;
export const TRAVEL_STEP_SEC = 0.18;

/** Толщина кольца по радиусу: базовая и максимальная у центра (визуальный сигнал). */
export const RING_THICKNESS_FAR = 0.004;
export const RING_THICKNESS_NEAR = 0.009;

/** Порог, после которого кольцо считается близким и утолщается. */
export const DANGER_RADIUS = 0.6;

/** Размер и вращение разрыва у рваного кольца (радианы). */
export const GAP_SPAN = 0.26;
export const GAP_SPIN_PER_SEC = 1.1;
/** Прицельный разрыв: за столько секунд до подлёта окно наводится на центр. */
export const GAP_AIM_LEAD_SEC = 0.42;

/** Окно «чистого уклонения»: разрыв должен стоять у центра при входе в DANGER_RADIUS. */
export const CLEAN_WINDOW_RAD = 0.34;

/** Множители за чистые уклонения и штраф за касание. */
export const CLEAN_MULTIPLIER_STEP = 0.09;
export const CLEAN_MULTIPLIER_MAX = 4;
export const HIT_MULTIPLIER_DROP = 0.25;
export const MULTIPLIER_MIN = 1;

/** Базовый счёт за секунду выживания. */
export const SCORE_PER_SEC = 10;

/** Формат дневной сетки: сколько колец показывать в эмодзи-строке. */
export const DAILY_BUCKETS = 12;

/**
 * Профиль дня: детерминированный пресет поверх одного сида.
 * Списки неизменяемы — по номеру дня выбирается один профиль.
 */
export const DAILY_PROFILES = Object.freeze([
  { name: 'КОЛЬЦА', doubleTimeSec: 60, jaggedTimeSec: 90, magnetTimeSec: 120 },
  { name: 'РОЙ', doubleTimeSec: 45, jaggedTimeSec: 80, magnetTimeSec: 110 },
  { name: 'ЖАТВА', doubleTimeSec: 70, jaggedTimeSec: 75, magnetTimeSec: 150 },
  { name: 'ВОЛНА', doubleTimeSec: 30, jaggedTimeSec: 100, magnetTimeSec: 105 },
  { name: 'ИГЛА', doubleTimeSec: 90, jaggedTimeSec: 120, magnetTimeSec: 130 },
]);

/** Длина суток в миллисекундах — сид дня меняется в 00:00 UTC. */
export const DAY_MS = 86_400_000;

/** Максимальная продолжительность шага симуляции: защита от длинных кадров. */
export const MAX_FRAME_SEC = 0.05;

/**
 * Сколько кольца ждёт до конца жизни: SPAWN_RADIUS / базовая скорость.
 * Базовая скорость выводится из TRAVEL_START_SEC, поэтому держим их вместе.
 */
export const BASE_RING_SPEED = SPAWN_RADIUS / TRAVEL_START_SEC;