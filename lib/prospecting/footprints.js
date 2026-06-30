// Footprint-сигнатуры движков и утилиты дискавери (parasite SEO).
// Главный донор-движок — PEIQ (meinbezirk.at): площадки на нём переиспользуют существующий адаптер.
// Здесь — чистые функции (без сети): сигнатуры для классификатора, генератор Google-дорков и
// извлечение доменов из произвольного текста (вставка выдачи SERP / страницы клиентов PEIQ).

// Регэкспы-сигнатуры PEIQ. weight — вклад в скор; powered-by однозначен.
export const PEIQ_SIGNATURES = [
  { key: 'powered-by-peiq', re: /powered by peiq/i, weight: 2 },
  { key: 'peiq-domain', re: /peiq\.de/i, weight: 1 },
  { key: 'article-id', re: /_a\d{4,}/, weight: 1 }, // URL-суффикс статьи: ..._a6979166
  { key: 'wysibb', re: /article_content_text|wysibb/i, weight: 1 }, // форма публикации
  { key: 'ugc-terms', re: /b[uü]rgerreporter|leserreporter|regionaut|schnappschuss/i, weight: 1 },
];

// Сигнатуры других движков — чтобы корректно НЕ принять их за PEIQ и подсказать, что это (для адаптера).
export const WORDPRESS_SIGNATURES = [
  { key: 'wp-login', re: /wp-login\.php/i, weight: 2 },
  { key: 'generator-wp', re: /<meta[^>]+name=["']generator["'][^>]+wordpress/i, weight: 2 },
  { key: 'wp-content', re: /\/wp-content\//i, weight: 1 },
  { key: 'wp-includes', re: /\/wp-includes\//i, weight: 1 },
  { key: 'wp-json', re: /\/wp-json\b/i, weight: 1 },
];

// Реестр движков (порядок = приоритет при равенстве). PEIQ — целевой, проверяется первым.
export const ENGINES = {
  peiq: PEIQ_SIGNATURES,
  wordpress: WORDPRESS_SIGNATURES,
};

// Пути-кандидаты страницы регистрации (если ссылку не нашли в HTML).
export const REGISTER_PATHS = ['/register', '/registrieren', '/anmelden', '/user/register', '/registrierung'];

// Первая ссылка-статья по footprint PEIQ (_aNNNN) — для догрузки страницы статьи (там отпечатки сильнее).
export function findArticleLink(html) {
  const m = String(html || '').match(/href=["']([^"']*_a\d{4,}[^"']*)["']/i);
  return m ? m[1] : null;
}

// Ссылка регистрации из HTML: по href (/register…) или по тексту (registrieren/anmelden/kostenlos).
export function findRegisterLink(html) {
  const s = String(html || '');
  // по href
  const byHref = s.match(/href=["']([^"']*(?:register|registrier|anmeld)[^"']*)["']/i);
  if (byHref) return byHref[1];
  // по тексту якоря
  const a = s.match(/<a[^>]+href=["']([^"']+)["'][^>]*>\s*[^<]*(?:registrieren|kostenlos anmelden|jetzt anmelden|konto erstellen)[^<]*<\/a>/i);
  return a ? a[1] : null;
}

// Признаки UGC (наличие регистрации и формы создания материала).
export const UGC_REGISTER = /\/register\b|kostenlos anmelden|jetzt anmelden|registrieren|konto erstellen/i;
export const UGC_CREATE = /\/a\/article\/new|beitrag erstellen|beitrag verfassen|schnappschuss|artikel erstellen/i;

// Google-дорки по footprint PEIQ. seed — опц. гео/ниша ("site:.at", "Wien", ...).
export function buildDorks(seed = '') {
  const s = String(seed || '').trim();
  const suffix = s ? ` ${s}` : '';
  return [
    `"powered by peiq"${suffix}`,
    `"Bürgerreporter" "Beitrag erstellen"${suffix}`,
    `"Leserreporter" intext:"angemeldet bleiben"${suffix}`,
    `inurl:_a intitle:Regionaut${suffix}`,
    `"Regionauten" "Schnappschuss"${suffix}`,
  ];
}

// Домены, которые НИКОГДА не кандидаты (сам вендор, соцсети, CDN, consent, аналитика, поисковики).
const NOISE = [
  'peiq.de', 'gogol-medien.de', 'google', 'gstatic', 'googleapis', 'googletagmanager', 'google-analytics',
  'doubleclick', 'facebook', 'fbcdn', 'instagram', 'twitter', 'x.com', 't.co', 'youtube', 'youtu.be',
  'linkedin', 'pinterest', 'tiktok', 'whatsapp', 'telegram', 'apple.com', 'microsoft', 'cloudflare',
  'cdn', 'jsdelivr', 'unpkg', 'jquery', 'bootstrapcdn', 'fontawesome', 'gravatar', 'schema.org', 'w3.org',
  'onetrust', 'cookielaw', 'cleverpush', 'sourcepoint', 'sp-prod', 'consensu', 'usercentrics',
  'wikipedia', 'wikimedia', 'archive.org', 'amazon', 'amazonaws', 'akamai', 'gmpg.org',
];

function isNoise(domain) {
  return NOISE.some((n) => domain === n || domain.includes(n));
}

// Извлечь домены из произвольного текста (HTML/выдача/список). Нормализует (без www/схемы/порта),
// дедуп, отбрасывает мусорные. Возвращает массив голых доменов в порядке первого появления.
export function extractDomains(text, { extraNoise = [] } = {}) {
  const out = [];
  const seen = new Set();
  const noiseSet = new Set(extraNoise.map((d) => String(d).toLowerCase()));
  // Хосты из URL и «голые» домены вида example.de / sub.example.co.uk.
  const re = /\b(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    let d = m[1].toLowerCase().replace(/\.$/, '');
    // отбросить чисто файловые «домены» (foo.js, foo.png), оставшиеся от путей
    if (/\.(js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|json|xml|map|mp4|pdf)$/i.test(d)) continue;
    if (seen.has(d) || isNoise(d) || noiseSet.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out;
}
