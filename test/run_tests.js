/**
 * Прогон логики бота версии 4 на заглушках Apps Script.
 * Запуск: node test/run_tests.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { state, sheet, propsStore, cacheStore, reset, realLog } = require('./stubs');

// Косвенный eval: объявления должны попасть в глобальную область, как в Apps Script.
const globalEval = eval;
globalEval(fs.readFileSync(path.join(__dirname, '..', 'src', 'Code.gs'), 'utf8'));

const CHAT = 401084071;
let uid = 9000;

const post = (update, secret = 'sekret') =>
  doPost({ parameter: { s: secret }, postData: { contents: JSON.stringify(update) } });

const startMsg = (payload) => ({
  update_id: ++uid,
  message: {
    chat: { id: CHAT },
    from: { id: CHAT, username: 'Rick_Styler', first_name: 'Sergei' },
    text: payload ? '/start ' + payload : '/start'
  }
});
const click = (step, choice, chatId = CHAT) => ({
  update_id: ++uid,
  callback_query: {
    id: 'cb' + uid, from: { id: chatId, username: 'Rick_Styler', first_name: 'Sergei' },
    message: { message_id: 50, chat: { id: chatId } },
    data: step + ':' + choice
  }
});
const questions = () => state.sent
  .filter((s) => s.method === 'sendMessage' && /из 5/.test(s.text || ''))
  .map((s) => s.text.match(/(\d) из 5/)[1]);
const row = () => sheet.rows[0];

const results = [];
function check(name, fn) {
  reset();
  global._sheet = null;
  try { fn(); results.push(['PASS', name, '']); }
  catch (err) { results.push(['FAIL', name, err.message]); }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: получено ${a}, ожидалось ${b}`);
}

/* ===== 1. ГЛАВНОЕ: сценарий зависания после второго вопроса ===== */
check('нажатие во время записи строки не ломает тест (баг v3)', () => {
  // Пока appendRow пишет строку, пользователь жмёт вариант первого вопроса.
  state.onSlowSheetWrite = () => post(click(0, 1));
  post(startMsg());

  const st = JSON.parse(cacheStore.get('st' + CHAT));
  eq(st.step, 1, 'шаг после ответа на первый вопрос');
  eq(st.answers, [1], 'ответы не стёрты');
  eq(questions(), ['1', '2'], 'отправленные вопросы');

  // Дальше тест должен идти, а не замирать.
  post(click(1, 1));
  eq(questions(), ['1', '2', '3'], 'третий вопрос пришёл');
  post(click(2, 1));
  post(click(3, 0));
  post(click(4, 0));
  eq(sheet.rows.length, 1, 'строк в таблице');
  eq(row()[12], 'завершил', 'статус');
  eq(row().slice(5, 10),
     ['5–6 класс', 'Ребёнок сам', 'Прошу ребёнка объяснить своими словами',
      'Перестанет думать сам', 'Да, и не раз'],
     'все пять ответов записаны');
});

/* ===== 2. повторная доставка одного и того же апдейта ===== */
check('повторная доставка update_id не плодит строк и вопросов', () => {
  const upd = startMsg();
  for (let i = 0; i < 54; i++) post(upd);
  eq(sheet.rows.length, 1, 'строк в таблице');
  eq(questions(), ['1'], 'вопросов отправлено');
});

check('повторная доставка нажатия не сдвигает шаг дважды', () => {
  post(startMsg());
  const c = click(0, 2);
  post(c); post(c); post(c);
  eq(JSON.parse(cacheStore.get('st' + CHAT)).step, 1, 'шаг');
  eq(questions(), ['1', '2'], 'вопросов отправлено');
});

/* ===== 3. полный проход ===== */
check('полный проход: одна строка, все поля, статус «завершил»', () => {
  post(startMsg('yt_shorts'));
  [1, 1, 3, 1, 0].forEach((c, i) => post(click(i, c)));
  eq(sheet.rows.length, 1, 'строк в таблице');
  const r = row();
  eq(questions(), ['1', '2', '3', '4', '5'], 'каждый вопрос по одному разу');
  eq(String(r[1]), String(CHAT), 'chat_id');
  eq(r[2], '@Rick_Styler', 'username');
  eq(r[4], 'yt_shorts', 'источник из deep link');
  eq(r[5], '5–6 класс', 'Класс');
  eq(r[6], 'Ребёнок сам', 'Кто пользуется');
  eq(r[7], 'Не проверяю, времени нет', 'Проверка');
  eq(r[8], 'Сдаст чужую ошибку под своим именем', 'Тревога');
  eq(r[9], 'Да, и не раз', 'Ошибки');
  eq(r[10], 'Контролёр', 'Сегмент');
  eq(r[11], 'Красная', 'Зона');
  eq(r[12], 'завершил', 'Статус');
  if (!r[13]) throw new Error('Дата финиша пустая');
  eq(cacheStore.has('st' + CHAT), false, 'состояние очищено после финиша');
});

/* ===== 4. повторный /start ===== */
check('/start на нулевом шаге возобновляет, а не создаёт вторую строку', () => {
  post(startMsg());
  post(startMsg());
  post(startMsg());
  eq(sheet.rows.length, 1, 'строк в таблице');
  eq(questions(), ['1', '1', '1'], 'первый вопрос повторён без новых строк');
  const resumed = state.sent.filter((s) => /Продолжаем с того места/.test(s.text || ''));
  eq(resumed.length, 2, 'сообщений о возобновлении');
});

check('/start посреди теста возобновляет с текущего вопроса', () => {
  post(startMsg());
  post(click(0, 2));
  post(startMsg());
  eq(questions(), ['1', '2', '2'], 'возобновление со второго вопроса');
  eq(sheet.rows.length, 1, 'строк в таблице');
  eq(JSON.parse(cacheStore.get('st' + CHAT)).step, 1, 'шаг сохранён');
});

check('/start после завершения переиспользует строку', () => {
  post(startMsg());
  [0, 1, 1, 1, 0].forEach((c, i) => post(click(i, c)));
  eq(row()[12], 'завершил', 'статус после первого прохода');
  post(startMsg());
  eq(sheet.rows.length, 1, 'строк в таблице');
  eq(row()[12], 'начал', 'статус сброшен');
  eq(row()[5], '', 'ответы очищены');
});

/* ===== 5. старые и битые кнопки ===== */
check('нажатие на уже отвеченный вопрос не повторяет вопрос', () => {
  post(startMsg());
  post(click(0, 1));
  for (let i = 0; i < 5; i++) post(click(0, 3));
  eq(questions(), ['1', '2'], 'вопросов отправлено');
  eq(JSON.parse(cacheStore.get('st' + CHAT)).answers, [1], 'ответ не перезаписан');
});

check('битые callback_data не ломают обработчик', () => {
  post(startMsg());
  ['abc', '0:99', '9:0', ':', '0'].forEach((data) => {
    post({ update_id: ++uid, callback_query: { id: 'x' + uid, from: { id: CHAT },
      message: { message_id: 50, chat: { id: CHAT } }, data } });
  });
  eq(JSON.parse(cacheStore.get('st' + CHAT)).step, 0, 'шаг не сдвинулся');
  eq(questions(), ['1'], 'вопросов отправлено');
});

check('нажатие без состояния подсказывает /start', () => {
  post(click(0, 1));
  const hint = state.sent.filter((s) => /тест сбросился/.test(s.text || ''));
  eq(hint.length, 1, 'подсказок отправлено');
  eq(sheet.rows.length, 0, 'строк в таблице');
});

/* ===== 6. сбой отправки ===== */
check('если вопрос не ушёл, шаг откатывается и диалог не замирает', () => {
  post(startMsg());
  state.failSendMessage = true;
  post(click(0, 1));
  state.failSendMessage = false;

  eq(JSON.parse(cacheStore.get('st' + CHAT)).step, 0, 'шаг откатан');
  // Та же кнопка снова работает — диалог живой.
  post(click(0, 1));
  eq(questions().slice(-1), ['2'], 'второй вопрос пришёл после повтора');
});

/* ===== 7. прочий ввод и секрет ===== */
check('произвольный текст не создаёт строк', () => {
  post(startMsg());
  for (let i = 0; i < 3; i++) {
    post({ update_id: ++uid, message: { chat: { id: CHAT }, from: { id: CHAT }, text: 'привет' } });
  }
  eq(sheet.rows.length, 1, 'строк в таблице');
  eq(questions(), ['1'], 'вопросов отправлено');
  eq(JSON.parse(cacheStore.get('st' + CHAT)).step, 0, 'шаг не сдвинулся');
});

check('запрос с чужим секретом отбрасывается', () => {
  post(startMsg(), 'wrong');
  eq(sheet.rows.length, 0, 'строк в таблице');
  eq(state.sent.length, 0, 'сообщений отправлено');
});

check('без настроенного секрета бот продолжает работать', () => {
  propsStore.delete('WEBHOOK_SECRET');
  post(startMsg(), undefined);
  eq(questions(), ['1'], 'вопрос отправлен');
  propsStore.set('WEBHOOK_SECRET', 'sekret');
});

/* ===== 8. цена запроса ===== */
check('одно нажатие = не больше 2 обращений к Bot API', () => {
  post(startMsg());
  const f = state.fetch + state.fetchAll;
  post(click(0, 1));
  const spent = state.fetch + state.fetchAll - f;
  if (spent > 2) throw new Error('обращений: ' + spent);
});

check('блокировка не держится во время сети и таблицы', () => {
  // Если бы блокировка удерживалась, вложенный вызов получил бы false
  // и нажатие было бы потеряно — именно это ломало бота.
  state.onSlowSheetWrite = () => {
    if (state.lockHeld) throw new Error('блокировка удерживается во время записи в лист');
    post(click(0, 0));
  };
  post(startMsg());
  eq(questions(), ['1', '2'], 'нажатие обработано во время записи строки');
});

/* ===== 9. два пользователя ===== */
check('два пользователя не мешают друг другу', () => {
  const OTHER = 777;
  post(startMsg());
  post({ update_id: ++uid, message: { chat: { id: OTHER },
    from: { id: OTHER, username: 'other', first_name: 'Other' }, text: '/start' } });
  post(click(0, 0));
  post(click(0, 3, OTHER));
  eq(sheet.rows.length, 2, 'строк в таблице');
  const mine = sheet.rows.find((r) => String(r[1]) === String(CHAT));
  const theirs = sheet.rows.find((r) => String(r[1]) === String(OTHER));
  eq(mine[5], '1–4 класс', 'ответ первого пользователя');
  eq(theirs[5], '10–11 класс', 'ответ второго пользователя');
  eq(propsStore.get('r' + CHAT), '2', 'номер строки первого');
  eq(propsStore.get('r' + OTHER), '3', 'номер строки второго');
});

/* ===== 10. обслуживание ===== */
check('dedupeSheet склеивает дубли и сохраняет ответы', () => {
  const mk = (t, klass, kto, chat = CHAT) => [t, String(chat), '@Rick_Styler', 'Sergei',
    'прямой', klass, kto, '', '', '', '', '', 'начал', '', ''];
  sheet.rows.push(mk('14:41:54', '', ''));
  sheet.rows.push(mk('14:42:09', '7–9 класс', ''));
  sheet.rows.push(mk('14:44:18', '', 'Пока никто'));
  sheet.rows.push(mk('14:47:23', '5–6 класс', 'Ребёнок сам'));
  sheet.rows.push(mk('15:00:00', '10–11 класс', 'Оба', 777));

  const dry = dedupeSheet();
  eq(dry.duplicates, 3, 'дублей найдено');
  eq(sheet.rows.length, 5, 'пробный прогон ничего не удалил');

  dedupeSheet(true);
  eq(sheet.rows.length, 2, 'строк осталось');
  const mine = sheet.rows.find((r) => String(r[1]) === String(CHAT));
  eq(mine[0], '14:41:54', 'дата старта самая ранняя');
  eq(mine[5], '5–6 класс', 'Класс поднят из дубля');
  eq(mine[6], 'Ребёнок сам', 'Кто пользуется поднят из дубля');
  eq(propsStore.get('r' + CHAT), '2', 'номера строк пересобраны');
  eq(propsStore.get('r777'), '3', 'номер строки второго пользователя');
});

check('очиститьТаблицу сбрасывает номера строк и состояния', () => {
  post(startMsg());
  post(click(0, 1));
  if (!propsStore.get('r' + CHAT)) throw new Error('номер строки не сохранён');
  очиститьТаблицу();
  eq(sheet.rows.length, 0, 'строк в таблице');
  eq(propsStore.has('r' + CHAT), false, 'номер строки удалён');
  eq(cacheStore.has('st' + CHAT), false, 'состояние сброшено');
  // После очистки бот должен нормально начать заново.
  post(startMsg());
  eq(sheet.rows.length, 1, 'новая строка создана');
  eq(questions().slice(-1), ['1'], 'первый вопрос отправлен');
});

check('selfTest без ошибок', () => { eq(selfTest(), [], 'ошибки selfTest'); });

/* ===== 11. все комбинации ответов ===== */
check('любая комбинация ответов даёт заполненную строку', () => {
  let n = 0;
  for (let a = 0; a < 4; a++) {
    for (let b = 0; b < 4; b++) {
      for (let c = 0; c < 4; c++) {
        reset(); global._sheet = null;
        post(startMsg());
        [a, b, c, a, b].forEach((choice, i) => post(click(i, choice)));
        const r = sheet.rows[0];
        for (let col = 5; col <= 11; col++) {
          if (r[col] === '') throw new Error(`пустой столбец ${col + 1} при ${a}/${b}/${c}`);
        }
        if (r[12] !== 'завершил') throw new Error('статус не «завершил» при ' + [a, b, c]);
        n++;
      }
    }
  }
  eq(n, 64, 'комбинаций проверено');
});

/* ===== 12. восстановление потерянных записей ===== */
check('финиш дописывает ответы, не попавшие в лист по ходу теста', () => {
  post(startMsg());
  post(click(0, 1));
  // Имитируем потерю номера строки посреди теста.
  propsStore.delete('r' + CHAT);
  const saved = sheet.rows[0][1];
  sheet.rows[0][1] = '';                   // строку по chat_id больше не найти
  post(click(1, 1));
  post(click(2, 1));
  sheet.rows[0][1] = saved;                // строка снова находится
  post(click(3, 1));
  post(click(4, 1));
  const r = sheet.rows[0];
  eq(r.slice(5, 10).filter(String).length, 5, 'все пять ответов на месте');
  eq(r[12], 'завершил', 'статус');
});

const failed = results.filter((r) => r[0] === 'FAIL');
realLog('');
results.forEach(([st, name, msg]) =>
  realLog(`  ${st === 'PASS' ? '✓' : '✗'} ${name}${msg ? '\n      ' + msg : ''}`));
realLog(`\n${results.length - failed.length}/${results.length} тестов прошли\n`);
process.exit(failed.length ? 1 : 0);
