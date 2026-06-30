// Классификатор площадки-кандидата: по HTML определяет движок (PEIQ?), наличие UGC
// (регистрация + форма создания материала) и dofollow внешних ссылок. Логика над HTML — чистая
// (тестируется фикстурами); сетевой слой (classifyDomain) тонкий и инъектируемый.

import { parse } from 'node-html-parser';
import { ENGINES, UGC_REGISTER, UGC_CREATE, REGISTER_PATHS, findArticleLink, findRegisterLink } from './footprints.js';

// Движок по HTML среди известных (PEIQ приоритетно). Движок «квалифицируется», если есть однозначная
// сигнатура (weight>=2) ИЛИ суммарный скор >= 2. Возвращает { engine, score, hits, engines:{name:{score,hits,qualifies}} }.
export function detectEngine(html) {
  const s = String(html || '');
  const per = {};
  for (const [name, sigs] of Object.entries(ENGINES)) {
    const hits = [];
    let score = 0;
    let strong = false;
    for (const sig of sigs) {
      if (sig.re.test(s)) {
        hits.push(sig.key);
        score += sig.weight;
        if (sig.weight >= 2) strong = true;
      }
    }
    per[name] = { score, hits, qualifies: strong || score >= 2 };
  }
  let engine = null;
  if (per.peiq && per.peiq.qualifies) {
    engine = 'peiq'; // целевой движок — приоритет
  } else {
    for (const [name, r] of Object.entries(per)) {
      if (r.qualifies && (engine === null || r.score > per[engine].score)) engine = name;
    }
  }
  const chosen = engine ? per[engine] : { score: 0, hits: [] };
  return { engine, score: chosen.score, hits: chosen.hits, engines: per };
}

// Признаки UGC по HTML: { has_register: 1|0, has_ugc_form: 1|0 }.
export function detectUgc(html) {
  const s = String(html || '');
  return {
    has_register: UGC_REGISTER.test(s) ? 1 : 0,
    has_ugc_form: UGC_CREATE.test(s) ? 1 : 0,
  };
}

// dofollow внешних ссылок: 1 (есть внешние без rel=nofollow) | 0 (все внешние nofollow) | null (внешних нет).
// Эвристика по странице: точное поведение на UGC-страницах проверяется уже живой публикацией.
export function detectDofollow(html, domain) {
  let root;
  try {
    root = parse(String(html || ''));
  } catch {
    return null;
  }
  const host = String(domain || '').toLowerCase().replace(/^www\./, '');
  let external = 0;
  let follow = 0;
  for (const a of root.querySelectorAll('a[href]')) {
    const href = (a.getAttribute('href') || '').trim();
    const mm = href.match(/^https?:\/\/(?:www\.)?([^/]+)/i);
    if (!mm) continue; // относительные/якоря/mailto — внутренние, пропускаем
    const h = mm[1].toLowerCase();
    if (host && (h === host || h.endsWith('.' + host))) continue; // тот же сайт
    external += 1;
    const rel = (a.getAttribute('rel') || '').toLowerCase();
    if (!/\bnofollow\b/.test(rel)) follow += 1;
  }
  if (external === 0) return null;
  return follow > 0 ? 1 : 0;
}

// Полная классификация по набору HTML-страниц { home, article?, register?, domain }.
// article (страница-пример статьи) усиливает детект движка и точнее отражает dofollow контента.
export function classifyHtml({ home = '', article = '', register = '', domain } = {}) {
  const eng = detectEngine([home, article, register].join(' '));
  const ugc = detectUgc(home + ' ' + article);
  const ugcReg = register ? detectUgc(register) : { has_register: 0, has_ugc_form: 0 };
  const dofollow = detectDofollow(article || home, domain);
  const has_register = ugc.has_register || ugcReg.has_register ? 1 : 0;
  const has_ugc_form = ugc.has_ugc_form || ugcReg.has_ugc_form ? 1 : 0;
  return {
    engine: eng.engine,
    engine_score: eng.score,
    hits: eng.hits,
    engines: eng.engines,
    has_register,
    has_ugc_form,
    dofollow,
  };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}
function absUrl(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

// Сетевой слой: скачать homepage (+ страницу-статью + страницу регистрации) и классифицировать.
// Следит за редиректом на другой домен (мигрировал/припаркован). fetchImpl/timeout инъектируемы для тестов.
// Возвращает { ok, domain, finalUrl, redirected, redirectedTo, engine, engine_score, hits, has_register, has_ugc_form, dofollow, fetched, error? }.
export async function classifyDomain(domain, { fetchImpl, timeoutMs = 15000 } = {}) {
  const d = String(domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  const doFetch = fetchImpl || globalThis.fetch;
  const get = async (url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; site-prospector/1.0)' },
      });
      if (!res.ok) return null;
      const text = await res.text();
      return { text, url: res.url || url };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const home = await get(`https://${d}/`);
  if (home == null) return { ok: false, domain: d, error: 'homepage недоступна', fetched: [] };
  const finalHost = hostOf(home.url);
  const redirected = Boolean(finalHost && finalHost !== d);
  const fetched = ['home'];

  // Догрузить страницу-пример статьи (отпечатки PEIQ там сильнее).
  let article = '';
  const al = findArticleLink(home.text);
  if (al) {
    const ar = await get(absUrl(al, home.url) || al);
    if (ar) {
      article = ar.text;
      fetched.push('article');
    }
  }

  // Страница регистрации: ссылка из HTML, иначе перебор стандартных путей.
  let register = '';
  const regLink = findRegisterLink(home.text);
  const regCandidates = regLink ? [absUrl(regLink, home.url) || regLink] : REGISTER_PATHS.map((p) => `https://${finalHost || d}${p}`);
  for (const u of regCandidates) {
    const rr = await get(u);
    if (rr && /registrier|anmeld|register/i.test(rr.text)) {
      register = rr.text;
      fetched.push('register');
      break;
    }
  }

  const result = classifyHtml({ home: home.text, article, register, domain: finalHost || d });
  return { ok: true, domain: d, finalUrl: home.url, redirected, redirectedTo: redirected ? finalHost : null, ...result, fetched };
}
