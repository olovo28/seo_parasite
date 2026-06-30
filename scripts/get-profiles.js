// Получение списка профилей Dolphin{anty} через Remote API.
//
// Запуск из корня проекта:
//   1) Положи API-токен в файл .env (см. .env.example)
//   2) node --env-file=.env scripts/get-profiles.js
//
// Токен берётся в приложении Dolphin{anty}: Настройки -> API (или в личном кабинете на сайте).

const API_BASE = 'https://dolphin-anty-api.com';

const token = process.env.DOLPHIN_API_TOKEN;
if (!token) {
  console.error('Не задан DOLPHIN_API_TOKEN. Создай .env с этим токеном (см. .env.example).');
  process.exit(1);
}

async function getProfiles({ page = 1, limit = 50 } = {}) {
  const url = `${API_BASE}/browser_profiles?page=${page}&limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
  }

  return res.json();
}

async function main() {
  const data = await getProfiles();
  const profiles = data.data ?? data;

  if (!Array.isArray(profiles) || profiles.length === 0) {
    console.log('Профили не найдены. Полный ответ:');
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  console.log(`Найдено профилей: ${profiles.length}\n`);
  for (const p of profiles) {
    console.log(`id=${p.id}\tname="${p.name}"\tstatus=${p.status?.name ?? '-'}`);
  }

  const profile6 = profiles.find((p) => p.name === 'Profile 6');
  if (profile6) {
    console.log(`\n>>> Profile 6 найден: id=${profile6.id}`);
  } else {
    console.log('\n>>> Profile 6 не найден среди первой страницы. Возможно, он на другой странице (увеличь limit).');
  }
}

main().catch((err) => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
