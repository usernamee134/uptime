# ⏱ uptime

Трекер времени на двоих: секундомер, онлайн-статус друг-друга, прогресс к 60 ч в неделю, графики, тепловая карта, ежедневные отчёты.

Стек: статический HTML/JS (GitHub Pages) + Supabase (Postgres, Auth, Realtime).

## Файлы

| Файл | Что это |
|---|---|
| `schema.sql` | таблицы, RLS, функции start/stop, realtime |
| `config.js` | URL и ключ Supabase, цель часов |
| `index.html`, `style.css`, `app.js` | сайт |

## 1. Supabase

1. Зарегайся на https://supabase.com → **New project** (регион поближе, например Frankfurt).
2. **SQL Editor** → New query → вставь весь `schema.sql` → **Run**. Должно быть `Success. No rows returned`.
   Потом так же — весь `migration.sql` (пауза, таймер, флажки).
3. **Project Settings → API** (или **API Keys**): скопируй
   - **Project URL** → `SUPABASE_URL` в `config.js`
   - **anon public** (или **publishable**, `sb_publishable_...`) → `SUPABASE_ANON_KEY`

   ⚠️ НЕ бери `service_role` / `secret` ключ — он обходит RLS.
4. **Authentication → URL Configuration → Site URL**: адрес сайта (сначала `http://localhost:8000`, потом адрес GitHub Pages). Туда ведёт ссылка из письма подтверждения.
5. Опционально: **Authentication → Sign In / Providers → Email → Confirm email** выключить, чтобы регистрироваться без письма.

## 2. Локальная проверка

```bash
cd ~/Projects/time-manager
python -m http.server 8000
```

Открыть http://localhost:8000 (через `file://` не заработает — ES-модули требуют http).

## 3. Деплой на GitHub Pages

```bash
git init && git add . && git commit -m "init"
git branch -M main
git remote add origin git@github.com:<ник>/time-manager.git
git push -u origin main
```

GitHub → репо → **Settings → Pages** → Source: **Deploy from a branch**, `main` / `/ (root)` → Save.
Через минуту сайт будет на `https://<ник>.github.io/time-manager/`. Не забудь поменять **Site URL** в Supabase (шаг 1.4).

## 4. Регистрация и закрытие доступа

1. Оба регистрируетесь на сайте (поле «Имя» — так вас видит друг).
2. **Authentication → Sign In / Providers → Allow new users to sign up** — выключить.
   Иначе любой, кто найдёт сайт, зарегается и увидит ваши данные (читать может любой залогиненный).

## Как это работает

- **Старт/стоп** — RPC `start_timer()` / `stop_timer()`, время берётся с сервера (`now()`), так что часы на компе не влияют. Секундомер живёт в базе: закрыл вкладку или открыл с телефона — он продолжает идти.
- Одновременно может идти только один секундомер на человека (уникальный индекс).
- Сессия через полночь делится между днями.
- Неделя Пн–Вс по локальному времени браузера.
- «к плану» — сравнение с равномерным темпом (60/7 ≈ 8.6 ч в день) на начало сегодняшнего дня.
- Друг обновляется в реальном времени (Supabase Realtime).
- Свои сессии можно удалить (если забыл остановить), отчёт за день — один, можно править; пустой отчёт = удаление.
- Цель меняется в `config.js` → `WEEKLY_GOAL_HOURS`.
