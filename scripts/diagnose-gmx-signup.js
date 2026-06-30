// Диагностика формы РЕГИСТРАЦИИ нового ящика GMX. Снимает: точку входа в регистрацию, поля формы
// (желаемый email + домен, пароль, Anrede, имя/фамилия, дата рождения, страна/индекс), тип капчи
// (CaptchaFox sitekey) и момент шага с телефоном. Ничего не отправляет. Прокси — первая из AT-1.txt.
//
//   npm run diagnose-gmx-signup        (нужен открытый Dolphin)

import { readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseProxy } from '../lib/accounts.js';
import { launchProfileWithProxy, cleanupProfile } from '../lib/browser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Первая прокси из reference/AT-1.txt
const proxyLine = readFileSync(join(ROOT, 'reference', 'AT-1.txt'), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
if (!proxyLine) throw new Error('AT-1.txt пуст.');
const proxy = parseProxy(proxyLine);

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const dir = join(ROOT, 'diagnostics', `gmx-signup-${ts}`);
mkdirSync(dir, { recursive: true });
const log = (m) => {
  console.log(m);
  appendFileSync(join(dir, '00-log.txt'), m + '\n');
};

// Принять consent (Sourcepoint/ppp) в любом фрейме: кнопка «Akzeptieren…», без «настроек/отклонить».
async function acceptConsent(page) {
  for (let i = 0; i < 3; i++) {
    for (const frame of [page, ...page.frames()]) {
      const clicked = await frame
        .evaluate(() => {
          const els = [...document.querySelectorAll('button, a, [role="button"], [title]')];
          const ok = els.find((e) => {
            const t = (e.textContent || e.title || '').trim().toLowerCase();
            if (!t || t.length > 40) return false;
            if (/abo|premium|einstellung|verwalt|ablehn|mehr|details/.test(t)) return false;
            return /akzeptier|zustimmen|einverstanden|alle annehmen|accept all/.test(t);
          });
          if (ok) { ok.click(); return (ok.textContent || ok.title || '').trim().slice(0, 30); }
          return null;
        })
        .catch(() => null);
      if (clicked) { log(`consent: «${clicked}»`); await sleep(1500); return true; }
    }
    await sleep(800);
  }
  return false;
}

// Снять поля/триггеры по всем фреймам (включая shadow-less). Для каждого фрейма — inputs/selects/кнопки.
async function probe(page, label) {
  const out = [];
  for (const f of page.frames()) {
    const info = await f
      .evaluate(() => {
        const inputs = [...document.querySelectorAll('input, select')].map((i) => ({ tag: i.tagName, type: i.type, name: i.name, id: i.id, ph: i.placeholder, dt: i.getAttribute('data-testid') }));
        const buttons = [...document.querySelectorAll('button, a[href], [role="button"]')]
          .map((b) => ({ id: b.id, dt: b.getAttribute('data-testid'), href: b.getAttribute('href'), txt: (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30) }))
          .filter((b) => b.txt || b.dt);
        const sk = (document.documentElement.innerHTML || '').match(/sk_[A-Za-z0-9]+/);
        const captchafox = /captchafox/i.test(document.documentElement.innerHTML || '');
        return { inputs, buttons: buttons.slice(0, 40), captchafox, captchaSiteKey: sk ? sk[0] : null };
      })
      .catch(() => null);
    if (info && (info.inputs.length || info.captchafox)) out.push({ frame: (f.url() || '').slice(0, 90), ...info });
  }
  writeFileSync(join(dir, `${label}.json`), JSON.stringify(out, null, 2));
  log(`[${label}] фреймов с полями: ${out.length}`);
  for (const p of out) {
    log(`  frame ${p.frame} | inputs=${p.inputs.length} captchafox=${p.captchafox} sitekey=${p.captchaSiteKey || '-'}`);
    for (const i of p.inputs.slice(0, 25)) log(`     ${i.tag} type=${i.type} name=${i.name} id=${i.id} dt=${i.dt} ph=«${i.ph}»`);
  }
  return out;
}

let browser;
let profileId;
try {
  log(`Прокси ${proxy.host}:${proxy.port}. Поднимаю профиль…`);
  const launched = await launchProfileWithProxy({ proxy });
  browser = launched.browser;
  profileId = launched.profileId;
  const page = launched.page;

  // Прямой URL формы регистрации (найден диагностикой). defaultCountry=AT — Австрия.
  const ENTRY = process.env.GMX_SIGNUP_URL || 'https://registrierung.gmx.net/?defaultCountry=AT';
  log(`Открываю ${ENTRY}`);
  await page.goto(ENTRY, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await acceptConsent(page);
  await sleep(2500);
  await acceptConsent(page);
  await sleep(1500);
  writeFileSync(join(dir, '01-entry.html'), await page.content());
  await page.screenshot({ path: join(dir, '01-entry.png'), fullPage: false }).catch(() => {});

  log(`URL: ${page.url()}`);
  log('Фреймы:');
  for (const f of page.frames()) log(`   ${(f.name() || '').slice(0, 30)} ${(f.url() || '').slice(0, 90)}`);

  // Заглушки для прохода по шагам (НИЧЕГО не отправляем до SMS; на шаге телефона — стоп).
  const FILL = {
    firstName: 'Lukas', lastName: 'Gruber', birthDay: '14', birthMonth: '6', birthYear: '1990',
    emailLocalPart: 'lukas.gruber' + Math.floor(Math.random() * 9000 + 1000), email: 'lukas.gruber' + Math.floor(Math.random() * 9000 + 1000),
    password: 'Xk7mwqp!23a', passwordRetype: 'Xk7mwqp!23a', passwordConfirm: 'Xk7mwqp!23a',
  };

  for (let step = 1; step <= 5; step++) {
    await acceptConsent(page);
    const fields = await probe(page, `step${step}-fields`);
    await page.screenshot({ path: join(dir, `step${step}.png`), fullPage: true }).catch(() => {});
    writeFileSync(join(dir, `step${step}.html`), await page.content());

    // Если появилось поле телефона/SMS — стоп (дальше нужен реальный номер).
    const hasPhone = fields.some((fr) => fr.inputs.some((i) => /phone|mobile|tel|sms|code/i.test(`${i.name} ${i.id} ${i.dt} ${i.ph}`)));
    if (hasPhone) { log(`Шаг ${step}: обнаружено поле телефона/SMS — останавливаюсь (нужен реальный номер).`); break; }

    // Заполняем распознанные поля по id/name (главный фрейм).
    const filled = await page
      .evaluate((map) => {
        const set = (el, v) => { el.focus(); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
        const done = [];
        for (const [k, v] of Object.entries(map)) {
          const el = document.querySelector(`#${k}, [name="${k}"], [data-testid="${k}-input"]`);
          if (el && el.tagName === 'INPUT') { set(el, v); done.push(k); }
        }
        // select-ы (Anrede/домен/страна) — берём первый осмысленный вариант.
        for (const sel of document.querySelectorAll('select')) {
          const opt = [...sel.options].find((o) => o.value && o.value !== '0' && !/--/.test(o.textContent));
          if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        }
        return done;
      }, FILL)
      .catch(() => []);
    log(`Шаг ${step}: заполнено полей: ${filled.join(', ') || '—'}`);

    // Жмём основную кнопку «дальше» (Weiter / Konto erstellen / submit).
    const clicked = await page
      .evaluate(() => {
        const btns = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')];
        const b = btns.find((x) => /weiter|konto erstellen|registrieren|fortfahren|continue|next/i.test((x.textContent || x.value || '').trim()))
          || document.querySelector('button[type="submit"]');
        if (b) { b.click(); return (b.textContent || b.value || 'submit').trim().slice(0, 30); }
        return null;
      })
      .catch(() => null);
    log(`Шаг ${step}: кнопка «${clicked || '—'}»`);
    if (!clicked) break;
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await sleep(3500);
  }
} catch (e) {
  log(`ОШИБКА: ${e.message}`);
} finally {
  await cleanupProfile(browser, profileId);
  log(`Готово. Артефакты: ${dir}`);
}
process.exit(0);
