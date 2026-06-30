// Конвертация HTML (как генерирует Claude + наш блок ссылок) в BBCode,
// который принимает редактор WysiBB на meinbezirk.at.
//
// Поддерживаемые теги сайта: [h2], [b], [i], [list]/[*], [urlnt=URL]…[/url].
// На сайте доступен только один уровень заголовка (H2) — h2/h3 → [h2].

import { parse, NodeType } from 'node-html-parser';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code) => {
    if (code in ENTITIES) return ENTITIES[code];
    if (code[0] === '#') {
      const num = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(num) ? String.fromCodePoint(num) : m;
    }
    return m;
  });
}

function nodeToBB(node) {
  if (node.nodeType === NodeType.TEXT_NODE) {
    return decodeEntities(node.rawText).replace(/\s+/g, ' ');
  }
  if (node.nodeType !== NodeType.ELEMENT_NODE) return '';

  const tag = node.rawTagName ? node.rawTagName.toLowerCase() : '';
  const inner = node.childNodes.map(nodeToBB).join('');

  switch (tag) {
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return `[h2]${inner.trim()}[/h2]\n\n`;
    case 'p':
      return `${inner.trim()}\n\n`;
    case 'br':
      return '\n';
    case 'strong':
    case 'b':
      return `[b]${inner.trim()}[/b]`;
    case 'em':
    case 'i':
      return `[i]${inner.trim()}[/i]`;
    case 'u':
      return `[u]${inner.trim()}[/u]`;
    case 'blockquote':
      return `[quote]${inner.trim()}[/quote]\n\n`;
    case 'ul':
    case 'ol':
      return `[list]${inner}[/list]\n\n`;
    case 'li':
      return `[*]${inner.trim()}[/*]`;
    case 'a': {
      const href = decodeEntities(node.getAttribute('href') || '');
      return `[urlnt=${href}]${inner.trim()}[/urlnt]`;
    }
    default:
      // div, span, section и пр. — прозрачно отдаём содержимое
      return inner;
  }
}

// HTML → BBCode. Нормализует лишние пустые строки.
export function htmlToBBCode(html) {
  const root = parse(String(html));
  const out = root.childNodes.map(nodeToBB).join('');
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
