import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateIdentity, generatePassword, generateLoginCandidates, generateBirthdate, _internal, _loginTemplatesCount } from '../lib/identity.js';

test('generatePassword: соответствует правилам meinbezirk (≥8, верх/низ/цифра/спецсимвол)', () => {
  for (let i = 0; i < 200; i++) {
    const p = generatePassword();
    assert.ok(p.length >= 8, `длина ≥8: "${p}"`);
    assert.ok(/[A-Z]/.test(p), `есть заглавная: "${p}"`);
    assert.ok(/[a-z]/.test(p), `есть строчная: "${p}"`);
    assert.ok(/[0-9]/.test(p), `есть цифра: "${p}"`);
    assert.ok(/[!@#$%&*?]/.test(p), `есть спецсимвол: "${p}"`);
  }
});

test('generateIdentity: валидные поля и согласованность пола с именем', () => {
  for (let i = 0; i < 200; i++) {
    const id = generateIdentity();
    assert.ok(_internal.GENDERS.includes(id.gender));
    assert.ok(id.first_name && id.last_name);
    assert.equal(id.name, `${id.first_name} ${id.last_name}`);
    // location — валидный value из реального select
    assert.ok(_internal.LOCATIONS.some(([v]) => v === id.location));
    assert.ok(/^[0-9]+$/.test(id.location), 'location — числовой value');
    // имя из правильного набора по полу (diverse использует мужской набор)
    const pool = id.gender === 'female' ? _internal.FIRST_FEMALE : _internal.FIRST_MALE;
    assert.ok(pool.includes(id.first_name), `имя "${id.first_name}" из набора для пола ${id.gender}`);
    assert.ok(_internal.LAST.includes(id.last_name));
    // дата рождения и логины
    assert.ok(id.birth.year >= 1972 && id.birth.year <= 2003);
    assert.ok(id.birth.month >= 1 && id.birth.month <= 12 && id.birth.day >= 1 && id.birth.day <= 28);
    assert.ok(Array.isArray(id.loginCandidates) && id.loginCandidates.length >= 4);
  }
});

test('логины: 10-20 шаблонов, валидный формат, разнообразие', () => {
  assert.ok(_loginTemplatesCount >= 10 && _loginTemplatesCount <= 20, `шаблонов ${_loginTemplatesCount}`);
  const variety = new Set();
  for (let i = 0; i < 100; i++) {
    const cands = generateLoginCandidates('Müller', 'Groß', 1990, 8); // с умляутами → транслит
    for (const c of cands) {
      assert.ok(/^[a-z][a-z0-9._-]{2,31}$/.test(c), `валидный логин: "${c}"`);
      assert.ok(!/ä|ö|ü|ß/.test(c), `без умляутов: "${c}"`);
      variety.add(c);
    }
  }
  assert.ok(variety.size >= 10, `разнообразие логинов: ${variety.size}`);
});

test('generateBirthdate: совершеннолетний диапазон', () => {
  for (let i = 0; i < 50; i++) {
    const b = generateBirthdate();
    assert.ok(b.year >= 1972 && b.year <= 2003 && b.month >= 1 && b.month <= 12 && b.day >= 1 && b.day <= 28);
  }
});
