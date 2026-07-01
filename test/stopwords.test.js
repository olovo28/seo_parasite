import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStopWords, findStopWords } from '../lib/generateArticle.js';

test('parseStopWords: запятые/точки-с-запятой/строки → уникальный список без пустых', () => {
  assert.deepEqual(parseStopWords('Casino, Wetten\nspielen ,Casino'), ['Casino', 'Wetten', 'spielen']);
  assert.deepEqual(parseStopWords('a; b;; c'), ['a', 'b', 'c']);
  assert.deepEqual(parseStopWords(''), []);
  assert.deepEqual(parseStopWords(null), []);
});

test('findStopWords: регистронезависимо и по границам слова (подстроку внутри слова НЕ ловит)', () => {
  const words = ['Casino', 'spielen'];
  assert.deepEqual(findStopWords('Das beste CASINO in Wien', words), ['Casino']);
  assert.deepEqual(findStopWords('Wir spielen heute', words), ['spielen']);
  // «casino» не внутри «Kasse»; «spielen» есть в «Verspielen», но с буквой перед → не граница → не матч
  assert.deepEqual(findStopWords('Die Kasse und Verspielen', words), []);
  assert.deepEqual(findStopWords('nichts verboten hier', words), []);
  // несколько сразу
  assert.deepEqual(findStopWords('Casino und spielen', words).sort(), ['Casino', 'spielen']);
});
