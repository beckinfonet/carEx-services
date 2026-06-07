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

module.exports = TRANSLATIONS;
module.exports.render = render;
module.exports.formatSom = formatSom;
module.exports.interpolate = interpolate;
module.exports.SOM_TOKEN = SOM_TOKEN;
