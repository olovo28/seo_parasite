// Генератор вымышленной личности для регистрации на сайтах сети DACH.
// Чистый JS (без внешних вызовов): имя/фамилия по полу, ник, регион (Bezirk), пароль под правила сайта.
// Значения location — реальные value из select #register_location на meinbezirk (reference/registration.page).

const FIRST_MALE = [
  'Lukas', 'Felix', 'Maximilian', 'Tobias', 'Jonas', 'David', 'Florian', 'Sebastian', 'Andreas', 'Markus',
  'Stefan', 'Michael', 'Thomas', 'Daniel', 'Christoph', 'Patrick', 'Martin', 'Alexander', 'Philipp', 'Simon',
  'Matthias', 'Bernhard', 'Manuel', 'Fabian', 'Dominik', 'Georg', 'Johannes', 'Wolfgang', 'Gregor', 'Raphael',
];
const FIRST_FEMALE = [
  'Anna', 'Lena', 'Sophie', 'Julia', 'Laura', 'Lisa', 'Sarah', 'Katharina', 'Johanna', 'Magdalena',
  'Theresa', 'Elena', 'Marie', 'Hannah', 'Carina', 'Nina', 'Verena', 'Christina', 'Eva', 'Barbara',
  'Stefanie', 'Melanie', 'Andrea', 'Claudia', 'Birgit', 'Petra', 'Sabine', 'Martina', 'Elisabeth', 'Cornelia',
];
const LAST = [
  'Gruber', 'Huber', 'Bauer', 'Wagner', 'Müller', 'Pichler', 'Steiner', 'Moser', 'Mayer', 'Hofer',
  'Leitner', 'Berger', 'Fuchs', 'Eder', 'Fischer', 'Schmid', 'Winkler', 'Weber', 'Schwarz', 'Maier',
  'Schneider', 'Reiter', 'Mayr', 'Schmidt', 'Wimmer', 'Egger', 'Brunner', 'Lang', 'Baumgartner', 'Auer',
  'Wolf', 'Aigner', 'Wallner', 'Ebner', 'Koller', 'Lehner', 'Haas', 'Lechner', 'Strobl', 'Url',
];

// Реальные value из #register_location (meinbezirk). Подмножество с разбросом по землям/округам Австрии.
const LOCATIONS = [
  ['2278', 'Wien'], ['2401', 'Favoriten'], ['2408', 'Leopoldstadt'], ['2407', 'Landstraße'],
  ['2413', 'Neubau'], ['2414', 'Ottakring'], ['2417', 'Simmering'], ['2402', 'Floridsdorf'],
  ['2400', 'Donaustadt'], ['2418', 'Währing'], ['2387', 'Innsbruck'], ['2373', 'Graz'],
  ['2311', 'Klagenfurt'], ['2355', 'Linz'], ['2369', 'Salzburg-Stadt'], ['2436', 'Bregenz'],
  ['2335', 'St. Pölten'], ['2320', 'Baden'], ['2332', 'Mödling'], ['2343', 'Wiener Neustadt'],
  ['2389', 'Kufstein'], ['2393', 'Schwaz'], ['2356', 'Linz-Land'], ['2374', 'Graz-Umgebung'],
  ['2363', 'Vöcklabruck'], ['2348', 'Braunau'], ['2315', 'Villach'], ['2439', 'Dornbirn'],
  ['2442', 'Feldkirch'], ['2333', 'Neunkirchen'],
];

const GENDERS = ['male', 'female', 'diverse'];

// Реальные пары PLZ/город Австрии (для адресного шага регистрации GMX).
// Города без точек/спецсимволов (точка в «St. Pölten» вызывала «Ungültige Zeichen»).
const AT_ADDRESSES = [
  ['1010', 'Wien'], ['1100', 'Wien'], ['1200', 'Wien'], ['8010', 'Graz'], ['8020', 'Graz'],
  ['4020', 'Linz'], ['5020', 'Salzburg'], ['6020', 'Innsbruck'], ['9020', 'Klagenfurt'], ['6900', 'Bregenz'],
  ['2500', 'Baden'], ['4600', 'Wels'], ['8700', 'Leoben'], ['4400', 'Steyr'], ['6800', 'Feldkirch'],
];
// Названия улиц без ß (ss) — на всякий случай против «Ungültige Zeichen».
const STREETS = [
  'Hauptstrasse', 'Bahnhofstrasse', 'Kirchengasse', 'Gartenweg', 'Lindenweg', 'Schulstrasse', 'Feldgasse',
  'Mozartstrasse', 'Wiener Strasse', 'Bergweg', 'Ringstrasse', 'Dorfstrasse', 'Birkenweg', 'Marktplatz',
];

const SPECIALS = '!@#$%&*?';
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const digit = () => Math.floor(Math.random() * 10);

// Пароль: ≥8, есть верх/низ/цифра/спецсимвол. Делаем ДЛИННЫМ (~16) и высокоэнтропийным —
// GMX отвергает слабые пароли («Das Passwort ist unsicher»), meinbezirk такой тоже принимает.
export function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = upper + lower + digits + SPECIALS;
  // гарантируем по символу каждого класса + добиваем случайными до 16
  let chars = [pick([...upper]), pick([...lower]), pick([...digits]), pick([...SPECIALS]), pick([...SPECIALS])];
  while (chars.length < 16) chars.push(pick([...all]));
  return chars.sort(() => Math.random() - 0.5).join('');
}

// Транслитерация немецких умляутов в латиницу (для логина email).
function deumlaut(s) {
  return String(s)
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/Ä/g, 'ae').replace(/Ö/g, 'oe').replace(/Ü/g, 'ue');
}

// Дата рождения совершеннолетнего (для формы регистрации GMX). { day, month, year }.
export function generateBirthdate() {
  const year = 1972 + Math.floor(Math.random() * 32); // ~1972..2003
  const month = 1 + Math.floor(Math.random() * 12);
  const day = 1 + Math.floor(Math.random() * 28);
  return { day, month, year };
}

// 10–20 ШАБЛОНОВ логина email (чтобы не палить единый паттерн массовой регистрации).
// f=имя, l=фамилия (латиница, нижний регистр), y=год рождения, d=случайные цифры.
const LOGIN_TEMPLATES = [
  (f, l) => `${f}.${l}`,
  (f, l) => `${f}${l}`,
  (f, l) => `${f[0]}.${l}`,
  (f, l) => `${f}.${l[0]}`,
  (f, l) => `${l}.${f}`,
  (f, l) => `${f}_${l}`,
  (f, l, y, d) => `${f}.${l}${d(2)}`,
  (f, l, y, d) => `${f}${l}${d(2)}`,
  (f, l, y) => `${f}.${l}${String(y).slice(2)}`,
  (f, l, y) => `${f}${l}${y}`,
  (f, l, y, d) => `${f}.${l}.${d(2)}`,
  (f, l, y, d) => `${f}${d(2)}${l}`,
  (f, l, y, d) => `${f[0]}${l}${d(3)}`,
  (f, l, y, d) => `${f}-${l}`,
  (f, l, y, d) => `${l}${f[0]}${d(2)}`,
  (f, l, y, d) => `${f}.${l}_${d(2)}`,
  (f, l, y, d) => `${f}${l[0]}${d(3)}`,
  (f, l, y) => `${f}.${l}.${y}`,
];

// Санитизация логина под правила GMX (латиница/цифры/.-_, начинается с буквы, 3..32).
function sanitizeLogin(s) {
  let v = deumlaut(s).toLowerCase().replace(/[^a-z0-9._-]/g, '');
  v = v.replace(/^[^a-z]+/, '').replace(/[._-]{2,}/g, '.').replace(/[._-]+$/, '');
  return v.slice(0, 32);
}

// Несколько вариантов логина (разные шаблоны) — пробуем по очереди, если занят.
export function generateLoginCandidates(first, last, birthYear, n = 8) {
  const f = deumlaut(first).toLowerCase().replace(/[^a-z]/g, '');
  const l = deumlaut(last).toLowerCase().replace(/[^a-z]/g, '');
  const d = (k) => String(Math.floor(Math.random() * 10 ** k)).padStart(k, '0');
  const tpls = LOGIN_TEMPLATES.slice().sort(() => Math.random() - 0.5); // случайный порядок шаблонов
  const out = [];
  for (const t of tpls) {
    const cand = sanitizeLogin(t(f, l, birthYear, d));
    if (cand.length >= 3 && !out.includes(cand)) out.push(cand);
    if (out.length >= n) break;
  }
  return out;
}

// Сгенерировать личность. locale пока влияет только на пометку (наполнение — австрийское/DACH).
// Возвращает { gender, first_name, last_name, name, location, location_label, password, birth, loginCandidates }.
export function generateIdentity({ locale = 'at' } = {}) {
  const gender = pick(GENDERS);
  const first_name = pick(gender === 'female' ? FIRST_FEMALE : FIRST_MALE);
  const last_name = pick(LAST);
  const [location, location_label] = pick(LOCATIONS);
  const birth = generateBirthdate();
  const [plz, city] = pick(AT_ADDRESSES);
  const address = { plz, city, street: `${pick(STREETS)} ${1 + Math.floor(Math.random() * 98)}` };
  return {
    locale,
    gender,
    first_name,
    last_name,
    name: `${first_name} ${last_name}`, // публичное имя профиля (поле register[name])
    location,
    location_label,
    password: generatePassword(),
    birth,
    address,
    loginCandidates: generateLoginCandidates(first_name, last_name, birth.year),
  };
}

export const _loginTemplatesCount = LOGIN_TEMPLATES.length;

export const _internal = { FIRST_MALE, FIRST_FEMALE, LAST, LOCATIONS, GENDERS };
