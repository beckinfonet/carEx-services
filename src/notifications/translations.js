// src/notifications/translations.js
//
// NI18N-03: RU-first backend notification copy with EN parity. Notification rows
// store i18n KEYS (titleKey/bodyKey) + params, NEVER rendered text (T-12-03-05 — no
// PII in the row). This map renders those keys for any server-side surface that needs
// the localized string (e.g. the Phase 13 push payload, the Phase 14 digest).
//
// CURRENCY: amounts render as KGS som (`сом` RU / `som` EN), NEVER ruble — Kyrgyzstan
// audience (project memory / audience-tone). Do not introduce ₽ / руб. here.
//
// Key sets MUST stay at strict RU/EN parity (enforced by
// __tests__/notification-translations-parity.test.js, mirroring the mobile
// translation-parity scanner): equal key sets, non-empty leaves, identical
// placeholder tokens per key.

// Format a numeric amount as KGS som. Locale-neutral grouping with a space thousands
// separator (matches the regional convention); appends the localized som token.
function formatSom(amount, somToken) {
  const n = Number(amount);
  const grouped = Number.isFinite(n)
    ? Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
    : String(amount);
  return `${grouped} ${somToken}`;
}

const TRANSLATIONS = {
  RU: {
    new_match: {
      title: 'Новый вариант по вашему поиску',
      body: '{makeModel} — {price}. Посмотрите, пока не уехало.',
    },
    price_drop: {
      title: 'Цена упала',
      body: '{makeModel} теперь {newPrice} (было {oldPrice}).',
    },
    booked: {
      title: 'Авто забронировали',
      body: '{makeModel} забронировали. Если ждали — поторопитесь со следующим.',
    },
    sold: {
      title: 'Авто продали',
      body: '{makeModel} ушло. Сохраните поиск, чтобы не упустить похожее.',
    },
    back_available: {
      title: 'Авто снова в продаже',
      body: '{makeModel} снова доступно. Бронь сорвалась — ваш шанс.',
    },

    // ── Generic PII-safe PUSH set (Phase 13 NPUSH-08 / D-07 / D-08b) ──────────
    // SEPARATE from the in-app copy above. The in-app bodies interpolate
    // {makeModel}/{price}/etc., which are HARD-BANNED from a lock-screen push.
    // These push_* entries carry a category-specific TITLE (D-08) + ONE canonical
    // generic BODY per category (D-07) with ZERO interpolation tokens — no
    // make/model, no price/KGS amount, no seller, no location. Routing detail
    // travels only in the FCM `data.deeplink`, never in this copy.
    // Rendered param-free via renderGenericPush(); the parity+PII test asserts
    // the absence of every {...} token.
    push_new_match: { title: 'Новый вариант по поиску', body: 'Откройте, чтобы посмотреть.' },
    push_price_drop: { title: 'Цена снизилась', body: 'Откройте, чтобы посмотреть.' },
    push_booked: { title: 'Авто забронировали', body: 'Откройте, чтобы посмотреть.' },
    push_sold: { title: 'Авто продали', body: 'Откройте, чтобы посмотреть.' },
    push_back_available: { title: 'Авто снова в продаже', body: 'Откройте, чтобы посмотреть.' },
  },
  EN: {
    new_match: {
      title: 'New match for your search',
      body: '{makeModel} — {price}. Take a look before it goes.',
    },
    price_drop: {
      title: 'Price dropped',
      body: '{makeModel} is now {newPrice} (was {oldPrice}).',
    },
    booked: {
      title: 'Car was booked',
      body: '{makeModel} got booked. If you were waiting, move on the next one.',
    },
    sold: {
      title: 'Car was sold',
      body: '{makeModel} is gone. Save a search so you don\'t miss the next.',
    },
    back_available: {
      title: 'Car is available again',
      body: '{makeModel} is back. The booking fell through — your shot.',
    },

    // Generic PII-safe PUSH set — EN parity (see RU block above for the contract).
    push_new_match: { title: 'New match for your search', body: 'Open to take a look.' },
    push_price_drop: { title: 'Price dropped', body: 'Open to take a look.' },
    push_booked: { title: 'Car was booked', body: 'Open to take a look.' },
    push_sold: { title: 'Car was sold', body: 'Open to take a look.' },
    push_back_available: { title: 'Car is available again', body: 'Open to take a look.' },
  },
};

// Som token per language (KGS — never ruble).
const SOM_TOKEN = { RU: 'сом', EN: 'som' };

// Interpolate {param} tokens in a template from a params object. Price-shaped params
// (price/oldPrice/newPrice) render through formatSom in the requested language.
function interpolate(template, params, language) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (params == null || params[key] == null) return '';
    if (key === 'price' || key === 'oldPrice' || key === 'newPrice') {
      return formatSom(params[key], SOM_TOKEN[language] || SOM_TOKEN.RU);
    }
    return String(params[key]);
  });
}

/**
 * Render a notification's title + body for a language.
 * @param {'RU'|'EN'} language
 * @param {string} key - one of new_match|price_drop|booked|sold|back_available
 * @param {object} params - interpolation params (makeModel, price, oldPrice, newPrice)
 * @returns {{ title: string, body: string }}
 */
function render(language, key, params = {}) {
  const lang = TRANSLATIONS[language] ? language : 'RU';
  const entry = TRANSLATIONS[lang][key];
  if (!entry) throw new Error(`Unknown notification key: ${key}`);
  return {
    title: interpolate(entry.title, params, lang),
    body: interpolate(entry.body, params, lang),
  };
}

/**
 * Render a GENERIC, PARAM-FREE push title + body for a language (Phase 13 NPUSH-08).
 *
 * Deliberately SEPARATE from render()/interpolate() (which expect params and would
 * leave empty interpolation slots). The push set is pre-resolved generic copy — no
 * make/model, no price, no seller, no location — so it can never leak PII to the
 * lock screen (D-08b). The caller (fcm.js) passes ONLY a key + language; identifying
 * detail lives in data.deeplink, never in this copy.
 *
 * @param {string} key - 'push_new_match' | ... | 'push_back_available'. The bare
 *                        category ('price_drop') is also accepted (push_ is prefixed).
 * @param {'RU'|'EN'} lang - falls back to RU for an unknown/absent language.
 * @returns {{ title: string, body: string }}
 */
function renderGenericPush(key, lang) {
  const language = TRANSLATIONS[lang] ? lang : 'RU';
  const pushKey = key.startsWith('push_') ? key : `push_${key}`;
  const entry = TRANSLATIONS[language][pushKey];
  if (!entry) throw new Error(`Unknown generic push key: ${pushKey}`);
  return { title: entry.title, body: entry.body };
}

module.exports = TRANSLATIONS;
module.exports.render = render;
module.exports.renderGenericPush = renderGenericPush;
module.exports.formatSom = formatSom;
module.exports.interpolate = interpolate;
module.exports.SOM_TOKEN = SOM_TOKEN;
