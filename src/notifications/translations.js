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
    // In-app copy for the broadcast new-listing fan-out (Phase 15 Req 7 / D-08).
    // DISTINCT from new_match (saved-search). PII-free: zero {param} tokens — no
    // make/model/price/seller (the broadcast row carries no per-listing detail in
    // its copy; routing lives in the deeplink). NOT routed through
    // KEYS_BY_EVENT.new_listing (that stays mapped to new_match for saved-search).
    new_listing: {
      title: 'Новые объявления',
      body: 'Появились новые авто. Откройте, чтобы посмотреть.',
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
    // Broadcast new-listing push (Phase 15 Req 7 / D-08) — generic, param-free.
    push_new_listing: { title: 'Новые объявления', body: 'Появились новые авто. Откройте, чтобы посмотреть.' },

    // ── Slice 3: seller unlocked a buyer's request contact ───────────────────
    request_unlock: {
      title: 'Продавец заинтересован',
      body: 'Продавец заинтересован в вашей заявке: {makeModel}. Откройте, чтобы посмотреть.',
    },
    push_request_unlock: { title: 'Продавец заинтересован', body: 'Откройте, чтобы посмотреть.' },

    // ── Daily DIGEST set (Phase 14 NDIG-03 / D-04) ───────────────────────────
    // ONE localized morning push bundling a buyer's pending daily-cadence matches.
    // The ONLY dynamic value is the integer {count} (T-14-01-01 — no make/model/
    // price/seller/uid ever enters this copy). The RU title needs grammatically-
    // correct 3-form agreement (1 машина / 2-4 машины / 5+/0/11-14 машин), so the
    // title template stores a `#NOUN#` sentinel that renderDigest() replaces with
    // the pluralizeRu-selected form from digest_noun_forms. Parity stays intact:
    // the stored title carries exactly one {count} placeholder both languages, and
    // the sentinel is NOT a {param} token so the parity scanner ignores it.
    // Plain push_* register (NOT the UNHINGED tier) per D-04.
    digest_title: { title: '{count} #NOUN#' },
    digest_body: { body: 'Откройте, чтобы посмотреть.' },
    // 3-form noun phrase resolved at render time by pluralizeRu (one/few/many).
    // Full adjective+noun agreement folded into each form so the rendered title
    // reads grammatically: "1 новая машина" / "3 новые машины" / "5 новых машин".
    digest_noun_forms: {
      one: 'новая машина',
      few: 'новые машины',
      many: 'новых машин',
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
    // In-app broadcast new-listing copy — EN parity (see RU block for the contract).
    new_listing: {
      title: 'New listings',
      body: 'New cars just landed. Open to take a look.',
    },

    // Generic PII-safe PUSH set — EN parity (see RU block above for the contract).
    push_new_match: { title: 'New match for your search', body: 'Open to take a look.' },
    push_price_drop: { title: 'Price dropped', body: 'Open to take a look.' },
    push_booked: { title: 'Car was booked', body: 'Open to take a look.' },
    push_sold: { title: 'Car was sold', body: 'Open to take a look.' },
    push_back_available: { title: 'Car is available again', body: 'Open to take a look.' },
    // Broadcast new-listing push — EN parity (generic, param-free).
    push_new_listing: { title: 'New listings', body: 'New cars just landed. Open to take a look.' },

    // Slice 3: seller unlocked a buyer's request contact — EN parity.
    request_unlock: {
      title: 'A seller is interested',
      body: 'A seller is interested in your request: {makeModel}. Tap to view.',
    },
    push_request_unlock: { title: 'A seller is interested', body: 'Tap to view.' },

    // Daily DIGEST set — EN parity (see RU block for the contract). EN uses a simple
    // singular/plural noun; the same #NOUN# sentinel + {count} placeholder shape so
    // the parity scanner sees identical {param} tokens on both sides.
    digest_title: { title: '{count} #NOUN#' },
    digest_body: { body: 'Open to take a look.' },
    digest_noun_forms: {
      one: 'new match',
      few: 'new matches',
      many: 'new matches',
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

/**
 * Select the Russian plural form for a count using the standard 3-form rule.
 *   mod10 === 1 && mod100 !== 11            → forms[0] (one):  1, 21, 101 …
 *   mod10 in 2..4 && !(mod100 in 12..14)    → forms[1] (few):  2-4, 22-24 …
 *   otherwise                                → forms[2] (many): 0, 5-20, 11-14 …
 *
 * @param {number} n - the (non-negative integer) count.
 * @param {[string,string,string]} forms - [one, few, many] word forms.
 * @returns {string} the selected form.
 */
function pluralizeRu(n, forms) {
  const abs = Math.abs(Math.trunc(Number(n) || 0));
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

/**
 * Render the localized daily-digest push title (+ body) for a count.
 *
 * The ONLY interpolated value is the integer count (T-14-01-01 — no PII). RU resolves
 * the 3-form noun phrase via pluralizeRu; EN uses simple singular (n===1) / plural.
 * The stored digest_title template carries `{count}` plus a `#NOUN#` sentinel that is
 * replaced here with the selected form. This is what Plan 02's sendDigest calls.
 *
 * @param {'RU'|'EN'} language
 * @param {number} count
 * @returns {{ title: string, body: string }}
 */
function renderDigest(language, count) {
  const lang = TRANSLATIONS[language] ? language : 'RU';
  const block = TRANSLATIONS[lang];
  const f = block.digest_noun_forms;
  const noun = lang === 'RU'
    ? pluralizeRu(count, [f.one, f.few, f.many])
    : (Number(count) === 1 ? f.one : f.few);
  const title = interpolate(block.digest_title.title, { count }, lang).replace('#NOUN#', noun);
  return { title, body: block.digest_body.body };
}

module.exports = TRANSLATIONS;
module.exports.render = render;
module.exports.pluralizeRu = pluralizeRu;
module.exports.renderDigest = renderDigest;
module.exports.renderGenericPush = renderGenericPush;
module.exports.formatSom = formatSom;
module.exports.interpolate = interpolate;
module.exports.SOM_TOKEN = SOM_TOKEN;
