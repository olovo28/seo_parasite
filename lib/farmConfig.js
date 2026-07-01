// Настройки «фарма» (прогрев + человечность регистрации + отпечаток Dolphin-профиля). Хранятся в таблице settings
// (ключи с префиксом farm.), с фолбэком на env, затем на дефолт. Одно определение полей — и для чтения, и для UI.

import { getSetting } from './settings.js';

export const FARM_FIELDS = [
  { key: 'warm_target_visits', type: 'int', def: 3, env: 'WARM_TARGET_VISITS', label: 'Дней прогрева (визитов по умолчанию)', group: 'Прогрев' },
  { key: 'warm_min_pages', type: 'int', def: 5, env: 'WARM_MIN_PAGES', label: 'Страниц за визит: минимум', group: 'Прогрев' },
  { key: 'warm_max_pages', type: 'int', def: 20, env: 'WARM_MAX_PAGES', label: 'Страниц за визит: максимум', group: 'Прогрев' },
  { key: 'warm_min_hours', type: 'int', def: 18, env: 'WARM_MIN_HOURS', label: 'Интервал между визитами: мин, ч', group: 'Прогрев' },
  { key: 'warm_max_hours', type: 'int', def: 30, env: 'WARM_MAX_HOURS', label: 'Интервал между визитами: макс, ч', group: 'Прогрев' },
  { key: 'warm_entry', type: 'enum', def: 'direct', opts: ['direct', 'google'], label: 'Заход на сайт (direct / google-referer)', group: 'Прогрев' },
  { key: 'push_subscribe', type: 'bool', def: true, label: 'Подписываться на пуш-уведомления сайта', group: 'Прогрев' },
  { key: 'register_humanize', type: 'bool', def: true, env: 'REGISTER_HUMANIZE', label: 'Обзор сайта перед регистрацией', group: 'Регистрация' },
  { key: 'register_browse_min', type: 'int', def: 5, env: 'REGISTER_BROWSE_MIN', label: 'Обзор перед формой: страниц мин', group: 'Регистрация' },
  { key: 'register_browse_max', type: 'int', def: 12, env: 'REGISTER_BROWSE_MAX', label: 'Обзор перед формой: страниц макс', group: 'Регистрация' },
  { key: 'dolphin_headless', type: 'bool', def: false, env: 'DOLPHIN_HEADLESS', label: 'Профиль без окна (headless)', group: 'Dolphin профиль' },
  { key: 'dolphin_canvas', type: 'enum', def: 'noise', opts: ['noise', 'real', 'off'], label: 'Canvas', group: 'Dolphin профиль' },
  { key: 'dolphin_webgl', type: 'enum', def: 'noise', opts: ['noise', 'real', 'off'], label: 'WebGL', group: 'Dolphin профиль' },
  { key: 'dolphin_clientrect', type: 'enum', def: 'noise', opts: ['noise', 'real'], label: 'ClientRects', group: 'Dolphin профиль' },
  { key: 'dolphin_mediadevices', type: 'enum', def: 'manual', opts: ['manual', 'real'], label: 'Media Devices', group: 'Dolphin профиль' },
  { key: 'dolphin_webrtc', type: 'enum', def: 'altered', opts: ['altered', 'real', 'disabled'], label: 'WebRTC', group: 'Dolphin профиль' },
];

function readVal(db, f) {
  let raw = null;
  try {
    raw = getSetting(db, 'farm.' + f.key);
  } catch { raw = null; }
  if ((raw == null || raw === '') && f.env && process.env[f.env] != null) raw = process.env[f.env];
  if (raw == null || raw === '') return f.def;
  if (f.type === 'int') return Number.isFinite(Number(raw)) ? Number(raw) : f.def;
  if (f.type === 'bool') return raw === '1' || raw === 'true' || raw === 'on';
  return raw;
}

// Полный конфиг фарма { warm_target_visits, ..., dolphin_canvas, ... }.
export function getFarmConfig(db) {
  const c = {};
  for (const f of FARM_FIELDS) c[f.key] = readVal(db, f);
  return c;
}

// Только настройки отпечатка Dolphin-профиля (для createProfile/startProfile). Best-effort, дефолты — как раньше.
export function getDolphinConfig(db) {
  const c = getFarmConfig(db);
  return {
    headless: c.dolphin_headless,
    canvas: c.dolphin_canvas,
    webgl: c.dolphin_webgl,
    clientRect: c.dolphin_clientrect,
    mediaDevices: c.dolphin_mediadevices,
    webrtc: c.dolphin_webrtc,
  };
}
