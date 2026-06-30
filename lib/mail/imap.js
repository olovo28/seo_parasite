// Минимальный IMAP-клиент (без внешних зависимостей) для чтения писем подтверждения/одобрения.
// GMX блокирует IMAP с «чужого» IP → подключаемся ЧЕРЕЗ прокси аккаунта (HTTP CONNECT-туннель → TLS → IMAP).
// Возможностей ровно столько, сколько нужно: логин, SELECT INBOX, SEARCH, FETCH сырого письма,
// извлечение ссылок (с декодированием quoted-printable/base64-частей). Парсинг — best-effort.

import http from 'node:http';
import tls from 'node:tls';

// Открыть TLS-сокет к IMAP. Если задан proxy — через HTTP CONNECT-туннель; иначе напрямую.
function connectTls({ host, port, proxy, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => reject(e);
    if (!proxy?.host) {
      const sock = tls.connect({ host, port, servername: host, timeout: timeoutMs }, () => resolve(sock));
      sock.once('error', onErr);
      return;
    }
    const auth = proxy.login ? 'Basic ' + Buffer.from(`${proxy.login}:${proxy.password || ''}`).toString('base64') : undefined;
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}`, ...(auth ? { 'Proxy-Authorization': auth } : {}) },
      timeout: timeoutMs,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        // Прокси отказал в туннеле (напр. HTTP 503) — помечаем, чтобы наверху можно было сменить прокси и повторить.
        const e = new Error(`Прокси отклонил CONNECT (HTTP ${res.statusCode}).`);
        e.proxyError = true;
        e.proxyStatus = res.statusCode;
        return reject(e);
      }
      const sock = tls.connect({ socket, servername: host }, () => resolve(sock));
      sock.once('error', onErr);
    });
    // Не достучались до самого прокси (отказ соединения/таймаут) — это тоже вина прокси.
    req.once('error', (e) => {
      e.proxyError = true;
      onErr(e);
    });
    req.end();
  });
}

// Обёртка для тегированных IMAP-команд: шлём «aN CMD», копим ответ до строки «aN OK/NO/BAD».
function imapSession(sock) {
  let n = 0;
  let buffer = '';
  let waiter = null;
  sock.on('data', (d) => {
    buffer += d.toString('binary');
    if (waiter) {
      const re = new RegExp(`^${waiter.tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n`, 'm');
      const m = buffer.match(re);
      if (m) {
        const data = buffer;
        buffer = '';
        const w = waiter;
        waiter = null;
        w.resolve({ status: m[1], data });
      }
    }
  });
  // Дождаться приветствия сервера.
  const greeting = new Promise((res) => {
    const onG = () => {
      if (/\* OK/i.test(buffer)) {
        buffer = '';
        sock.off('data', onG);
        res();
      }
    };
    sock.on('data', onG);
  });
  function cmd(text, timeoutMs = 30000) {
    const tag = `a${++n}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`IMAP таймаут: ${text.slice(0, 20)}`)), timeoutMs);
      waiter = { tag, resolve: (r) => { clearTimeout(t); resolve(r); } };
      sock.write(`${tag} ${text}\r\n`);
    });
  }
  return { greeting, cmd };
}

// Декод quoted-printable (для тела/заголовков писем).
function decodeQP(s) {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Декод MIME-encoded-word в заголовке (=?utf-8?Q/B?...?=) — best-effort, для From/Subject.
function decodeHeader(s) {
  return String(s || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, txt) => {
    try {
      if (/b/i.test(enc)) return Buffer.from(txt, 'base64').toString('utf8');
      return Buffer.from(decodeQP(txt.replace(/_/g, ' ')), 'binary').toString('utf8');
    } catch {
      return txt;
    }
  });
}

// Из сырого письма достать from/subject и все http-ссылки (по тексту + декодированным частям).
function parseEmail(raw) {
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const head = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw;
  const grab = (name) => {
    const m = head.match(new RegExp(`^${name}:\\s*([\\s\\S]*?)(?=\\r?\\n[^\\s]|$)`, 'im'));
    return m ? decodeHeader(m[1].replace(/\r?\n\s+/g, ' ').trim()) : '';
  };
  // Кандидаты-тексты для поиска ссылок: сырое, QP-декодированное, и декодированные base64-блоки.
  const texts = [raw, decodeQP(raw)];
  for (const m of raw.matchAll(/Content-Transfer-Encoding:\s*base64[\s\S]*?\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/gi)) {
    try {
      texts.push(Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('utf8'));
    } catch {
      // пропускаем битый блок
    }
  }
  const links = new Set();
  for (const t of texts) {
    for (const m of t.matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) links.add(m[0].replace(/[.,;]+$/, ''));
  }
  return { from: grab('From'), subject: grab('Subject'), date: grab('Date'), links: [...links] };
}

// Прочитать последние письма INBOX. Возвращает массив { seq, from, subject, date, links } (новые первыми).
export async function fetchInbox({ host, port = 993, user, pass, proxy, max = 15, timeoutMs = 30000 } = {}) {
  const sock = await connectTls({ host, port, proxy, timeoutMs });
  try {
    const s = imapSession(sock);
    await s.greeting;
    const li = await s.cmd(`LOGIN "${user}" "${pass}"`);
    if (li.status !== 'OK') {
      const e = new Error('IMAP LOGIN отклонён (включён ли IMAP в ящике? верный ли пароль? доступ с этого IP?).');
      e.needLogin = true;
      throw e;
    }
    await s.cmd('SELECT INBOX');
    const sr = await s.cmd('SEARCH ALL');
    const ids = (sr.data.match(/\* SEARCH([0-9 ]*)/i)?.[1] || '').trim().split(/\s+/).filter(Boolean).map(Number);
    const pick = ids.slice(-max).reverse();
    const out = [];
    for (const seq of pick) {
      const f = await s.cmd(`FETCH ${seq} BODY.PEEK[]`);
      out.push({ seq, ...parseEmail(f.data) });
    }
    await s.cmd('LOGOUT').catch(() => {});
    return out;
  } finally {
    sock.end();
  }
}

// Найти письмо по фильтрам from/subject (regex). Возвращает первое подходящее или null.
export async function findEmailImap({ host, port, user, pass, proxy, fromMatch, subjectMatch, max = 15 } = {}) {
  const list = await fetchInbox({ host, port, user, pass, proxy, max });
  const fromRe = fromMatch ? (fromMatch instanceof RegExp ? fromMatch : new RegExp(fromMatch, 'i')) : null;
  const subjRe = subjectMatch ? (subjectMatch instanceof RegExp ? subjectMatch : new RegExp(subjectMatch, 'i')) : null;
  return (
    list.find((m) => (fromRe ? fromRe.test(m.from) : true) && (subjRe ? subjRe.test(m.subject) : true)) || null
  );
}

// Проверить доступность ящика по IMAP (логин + выбор INBOX). true/throws.
export async function verifyImap({ host, port, user, pass, proxy, timeoutMs = 30000 } = {}) {
  const sock = await connectTls({ host, port, proxy, timeoutMs });
  try {
    const s = imapSession(sock);
    await s.greeting;
    const li = await s.cmd(`LOGIN "${user}" "${pass}"`);
    if (li.status !== 'OK') throw new Error('IMAP LOGIN отклонён.');
    await s.cmd('LOGOUT').catch(() => {});
    return true;
  } finally {
    sock.end();
  }
}
