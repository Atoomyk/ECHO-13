/**
 * Константы PULSE.
 *
 * Модуль не зависит ни от DOM, ни от Node API: его импортируют и браузер,
 * и тесты, и сервер (для проверки общего сида дня).
 */

/** Номер версии правил. Меняется при правке баланса или формата сида. */
export const RULES_VERSION = 10;

/** Режимы партии: одиночный центр или два независимых (DUAL). */
export const GAME_MODE = Object.freeze({
  SINGLE: 'single',
  DUAL: 'dual',
});

/** Стороны dual: левый и правый центр. */
export const SIDE = Object.freeze({
  L: 'L',
  R: 'R',
});

/**
 * Смещение центров dual по X (мир ≈ [-1, 1]).
 * L = (−DUAL_CENTER_X, 0), R = (+DUAL_CENTER_X, 0).
 */
export const DUAL_CENTER_X = 1.2;

/** Единица игрового поля. Мир — квадрат [-1, 1] по обеим осям, центр (0, 0). */
export const WORLD_RADIUS = 1;

/** Радиус точки игрока в мировых единицах. */
export const PLAYER_RADIUS = 0.024;

/** Полный запас энергии. */
export const ENERGY_MAX = 100;

/**
 * Стоимость импульса. При regen 13 и интервале ~1.65 с устойчивый темп
 * держит бар; короткие серии джиттера больше не сливают запас в ноль.
 */
export const PULSE_COST = 10;

/** Энергия, восстанавливаемая за секунду, пока игрок не нажимает. */
export const ENERGY_REGEN_PER_SEC = 13;

/** Пауза восстановления энергии после импульса. */
export const REGEN_LOCKOUT_SEC = 0.2;

/**
 * Урон от касания кольца. С полного бара — около четырёх ошибок до конца
 * (чуть мягче прежних трёх), при этом AFK на plain всё ещё проигрывает.
 */
export const HIT_DAMAGE = 28;

/** Неуязвимость после касания: ошибка не убивает сразу. */
export const IFRAME_SEC = 0.45;

/** Радиус, на котором импульс перестаёт действовать: за ним кольцо уже не спасти. */
export const PULSE_REACH = 0.5;

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

/**
 * Сколько угроз может одновременно идти к центру.
 * Фактическая цель на поле — случайное число от 1 до min(MAX, level+1).
 */
export const FIELD_RINGS_MAX = 5;

/** Время между появлениями колец: в секундах с началом и полом сложности. */
export const SPAWN_INTERVAL_START_SEC = 1.65;
/**
 * Предел плотности волн. Согласован с окном реакции: игрок обязан успевать
 * отбивать каждое кольцо, но запас времени при этом остаётся небольшим.
 */
export const SPAWN_INTERVAL_MIN_SEC = 1.0;
export const SPAWN_INTERVAL_STEP_SEC = 0.08;
/** Множитель паузы до следующего кольца: от короткой серии до передышки. */
export const SPAWN_INTERVAL_JITTER_MIN = 0.7;
export const SPAWN_INTERVAL_JITTER_MAX = 1.55;

/**
 * Путь кольца от спавна до центра: старт, пол и шаг по времени партии (LV).
 * Не от номера спавна — иначе частые импульсы разгоняли бы очередь.
 * Шаг совпадает с уровнем: каждые 30 с travel короче на TRAVEL_STEP_SEC.
 */
export const TRAVEL_START_SEC = 3.0;
export const TRAVEL_MIN_SEC = 1.3;
export const TRAVEL_STEP_SEC = 0.14;
/** Секунд на одну ступень ускорения travel (как у LV). */
export const TRAVEL_LEVEL_SEC = 30;
/** Разброс времени подлёта относительно базы уровня: примерно ±50%. */
export const TRAVEL_JITTER_MIN = 0.5;
export const TRAVEL_JITTER_MAX = 1.5;

/** Толщина кольца по радиусу: базовая и максимальная у центра (визуальный сигнал). */
export const RING_THICKNESS_FAR = 0.004;
export const RING_THICKNESS_NEAR = 0.009;

/** Порог, после которого кольцо считается близким и утолщается. */
export const DANGER_RADIUS = 0.6;

/** Размер и вращение разрыва у рваного кольца (радианы). */
export const GAP_SPAN = 0.26;
export const GAP_SPIN_PER_SEC = 1.1;
/** Прицельный разрыв: совпадает с игроком чуть раньше центра (сек до crush). */
export const GAP_AIM_LEAD_SEC = 0.15;

/** Окно «чистого уклонения»: разрыв должен стоять у центра при входе в DANGER_RADIUS. */
export const CLEAN_WINDOW_RAD = 0.34;

/**
 * Ранний микс рваных в фазе PLAIN: с этой секунды часть колец уже с разрывом.
 * Только одиночные jagged. Профиль может задать earlyGapMixChance: 0.
 */
export const EARLY_GAP_MIX_SEC = 22;
/** Вероятность jagged вместо plain после EARLY_GAP_MIX_SEC (до порога jagged). */
export const EARLY_GAP_MIX_CHANCE = 0.25;
/**
 * После порога jaggedTimeSec — не 100% рваных: доля jagged, остальное plain.
 * Держим ниже половины, чтобы целые не «мелькали» на фоне копившихся дырок.
 * Профиль может переопределить jaggedPhaseChance.
 */
export const JAGGED_PHASE_CHANCE = 0.35;

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
 * Типы: plain → jagged → magnet (двойных слоёв нет).
 */
export const DAILY_PROFILES = Object.freeze([
  { name: 'КОЛЬЦА', jaggedTimeSec: 55, magnetTimeSec: 100 },
  { name: 'РОЙ', jaggedTimeSec: 45, magnetTimeSec: 90 },
  { name: 'ЖАТВА', jaggedTimeSec: 50, magnetTimeSec: 120 },
  { name: 'ВОЛНА', jaggedTimeSec: 40, magnetTimeSec: 95 },
  { name: 'ИГЛА', jaggedTimeSec: 65, magnetTimeSec: 110 },
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