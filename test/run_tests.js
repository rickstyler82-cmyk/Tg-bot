/**
 * Прогон логики бота версии 4 на заглушках Apps Script.
 * Запуск: node test/run_tests.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { state, sheet, logSheet, propsStore, cacheStore, reset, realLog } = require('./stubs');

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
        reset();
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

/* ===== 13. ДИАГНОСТИКА ===== */

const logRows = () => logSheet.rows.map((r) => ({ outcome: r[1], chat: r[3], event: r[4], details: r[7] }));

check('журнал пишет строку на каждое обновление', () => {
  post(startMsg());
  post(click(0, 1));
  const rows = logRows();
  eq(rows.length, 2, 'записей в журнале');
  eq(rows[0].outcome, 'обработан', 'итог по /start');
  eq(rows[1].outcome, 'обработан', 'итог по нажатию');
  eq(String(rows[0].chat), String(CHAT), 'chat_id в журнале');
  if (!/сообщение: \/start/.test(rows[0].event)) throw new Error('событие: ' + rows[0].event);
  if (!/кнопка: 0:1/.test(rows[1].event)) throw new Error('событие: ' + rows[1].event);
  if (!/план: start/.test(rows[0].details)) throw new Error('план: ' + rows[0].details);
  if (!/план: answer/.test(rows[1].details)) throw new Error('план: ' + rows[1].details);
});

check('отказ по секрету попадает в журнал с причиной', () => {
  post(startMsg(), 'wrong');
  const rows = logRows();
  eq(rows.length, 1, 'записей в журнале');
  eq(rows[0].outcome, 'ОТБРОШЕН: СЕКРЕТ', 'итог');
  if (!/не совпадает/.test(rows[0].details)) throw new Error('причина: ' + rows[0].details);
});

check('вебхук без секрета виден в журнале как причина молчания', () => {
  doPost({ parameter: {}, postData: { contents: JSON.stringify(startMsg()) } });
  const rows = logRows();
  eq(rows[0].outcome, 'ОТБРОШЕН: СЕКРЕТ', 'итог');
  if (!/нет параметра s/.test(rows[0].details)) throw new Error('причина: ' + rows[0].details);
  if (!/resetBot/.test(rows[0].details)) throw new Error('в причине нет подсказки');
});

check('ENFORCE_SECRET = off снимает проверку', () => {
  propsStore.set('ENFORCE_SECRET', 'off');
  doPost({ parameter: {}, postData: { contents: JSON.stringify(startMsg()) } });
  eq(questions(), ['1'], 'вопрос отправлен');
  eq(logRows()[0].outcome, 'обработан', 'итог');
  propsStore.delete('ENFORCE_SECRET');
});

check('отсутствие TOKEN видно в журнале', () => {
  propsStore.delete('TOKEN');
  global.TOKEN = null;
  post(startMsg());
  const rows = logRows();
  eq(rows[0].outcome, 'ОШИБКА: НЕТ TOKEN', 'итог');
  if (!/Свойства скрипта/.test(rows[0].details)) throw new Error('нет подсказки: ' + rows[0].details);
  global.TOKEN = 'TEST:TOKEN';
  propsStore.set('TOKEN', 'TEST:TOKEN');
});

check('отказ Bot API попадает в журнал с описанием', () => {
  post(startMsg());
  state.failSendMessage = true;
  post(click(0, 1));
  state.failSendMessage = false;
  const last = logRows().slice(-1)[0];
  eq(last.outcome, 'ОШИБКА BOT API', 'итог');
  if (!/bot was blocked/.test(last.details)) throw new Error('описание: ' + last.details);
});

check('исключение в обработчике попадает в журнал со следом', () => {
  const original = global.runPlan_;
  global.runPlan_ = () => { throw new Error('тестовый сбой'); };
  post(startMsg());
  global.runPlan_ = original;
  const rows = logRows();
  eq(rows[0].outcome, 'ИСКЛЮЧЕНИЕ', 'итог');
  if (!/тестовый сбой/.test(rows[0].details)) throw new Error('след: ' + rows[0].details);
});

check('битый JSON не остаётся без записи', () => {
  doPost({ parameter: { s: 'sekret' }, postData: { contents: '{не json' } });
  eq(logRows()[0].outcome, 'БИТЫЙ JSON', 'итог');
});

check('пустой запрос не остаётся без записи', () => {
  doPost({ parameter: { s: 'sekret' }, postData: { contents: '' } });
  eq(logRows()[0].outcome, 'ПУСТОЙ ЗАПРОС', 'итог');
});

check('уровень журнала off и errors', () => {
  setLogLevel('off');
  post(startMsg());
  eq(logRows().length, 0, 'при off записей нет');

  setLogLevel('errors');
  post(click(0, 1));                       // успешное действие
  eq(logRows().length, 0, 'успех при errors не пишется');
  post(startMsg(), 'wrong');               // сбой
  eq(logRows().length, 1, 'сбой при errors пишется');
  setLogLevel('all');
});

check('/diag отвечает версией и chat_id', () => {
  post({ update_id: ++uid, message: { chat: { id: CHAT }, from: { id: CHAT }, text: '/diag' } });
  const reply = state.sent.filter((s) => /Диагностика/.test(s.text || ''))[0];
  if (!reply) throw new Error('ответа на /diag нет');
  if (reply.text.indexOf(CODE_VERSION) === -1) throw new Error('нет версии: ' + reply.text);
  if (reply.text.indexOf(String(CHAT)) === -1) throw new Error('нет chat_id');
  eq(sheet.rows.length, 0, '/diag не создаёт строк в ответах');
});

check('doGet отдаёт отчёт с версией, без секрета — без лишнего', () => {
  const open = JSON.parse(doGet({ parameter: {} }).getContent());
  eq(open['версия_кода'], CODE_VERSION, 'версия в отчёте');
  eq(open['токен_задан'], true, 'токен');
  if (open['вебхук']) throw new Error('без ключа вебхук показывать нельзя');
  if (!open['подсказка']) throw new Error('нет подсказки про ключ');

  const full = JSON.parse(doGet({ parameter: { k: 'sekret' } }).getContent());
  if (!full['вебхук']) throw new Error('с ключом вебхук должен быть');
  if (!full['последние_события']) throw new Error('с ключом нужны последние события');
});

check('checkHealth видит устаревшее развёртывание', () => {
  state.liveBody = JSON.stringify({ 'версия_кода': '4.0' });
  const text = checkHealth();
  if (!/РАЗВЁРНУТА СТАРАЯ ВЕРСИЯ/.test(text)) throw new Error('не распознано:\n' + text);
  if (!/Версия: Новая/.test(text)) throw new Error('нет инструкции что делать');
});

check('checkHealth видит развёрнутый старый код без диагностики', () => {
  state.liveBody = 'ok';
  const text = checkHealth();
  if (!/РАЗВЁРНУТА СТАРАЯ ВЕРСИЯ/.test(text)) throw new Error('не распознано:\n' + text);
});

check('checkHealth видит вебхук без секрета', () => {
  state.webhookInfo = { url: 'https://script.google.com/macros/s/AKfycbxI3rdvrCC9mFwi4PbFESqW9iGQY91fogZdr4afhuWsGsYX42cnLMMGJaHaXdaNqTV3/exec', pending_update_count: 0 };
  const text = checkHealth();
  if (!/ОТБРАСЫВАЮТСЯ ПО СЕКРЕТУ/.test(text)) throw new Error('не распознано:\n' + text);
});

check('checkHealth видит очередь недоставленных и ошибку доставки', () => {
  state.webhookInfo = {
    url: 'https://script.google.com/macros/s/AKfycbxI3rdvrCC9mFwi4PbFESqW9iGQY91fogZdr4afhuWsGsYX42cnLMMGJaHaXdaNqTV3/exec?s=sekret',
    pending_update_count: 17,
    last_error_message: 'Wrong response from the webhook: 302 Found',
    last_error_date: 1789450000
  };
  const text = checkHealth();
  if (!/17 недоставленных/.test(text)) throw new Error('очередь не видна:\n' + text);
  if (!/302 Found/.test(text)) throw new Error('ошибка доставки не видна');
});

check('checkHealth говорит прямо, что журнал пуст', () => {
  const text = checkHealth();
  if (!/Журнал пуст/.test(text)) throw new Error('не сказано про пустой журнал:\n' + text);
  if (!/не вызывает скрипт/.test(text)) throw new Error('нет вывода о причине');
});

check('checkHealth на здоровом боте не находит проблем', () => {
  propsStore.set('ADMIN_CHAT_ID', String(CHAT));
  post(startMsg());
  const text = checkHealth();
  if (!/Проблем не найдено/.test(text)) throw new Error('ложная тревога:\n' + text);
});

check('checkHealth не падает при недоступной таблице', () => {
  const original = global.getSheet;
  global.getSheet = () => { throw new Error('таблица недоступна'); };
  const text = checkHealth();
  global.getSheet = original;
  if (!/таблица недоступна/.test(text)) throw new Error('ошибка не показана:\n' + text);
});

check('tailLog и ping не падают на пустом журнале', () => {
  eq(tailLog(5), [], 'пустой журнал');
  eq(ping(), false, 'без ADMIN_CHAT_ID отправлять некому');
  post(startMsg());
  propsStore.set('ADMIN_CHAT_ID', String(CHAT));
  eq(ping(), true, 'проверочное сообщение отправлено');
  if (tailLog(5).length === 0) throw new Error('журнал должен быть непустым');
});

check('журнал не роняет обработчик, если лист недоступен', () => {
  const original = global.logSheet_;
  global.logSheet_ = () => { throw new Error('лист журнала недоступен'); };
  post(startMsg());
  global.logSheet_ = original;
  eq(questions(), ['1'], 'вопрос всё равно отправлен');
});

check('resetBot прямо сообщает, что вебхук не установлен', () => {
  const originalTg = global.tg;
  global.tg = (method, payload) => {
    if (method === 'setWebhook') return JSON.stringify({ ok: false, description: 'Failed to resolve host' });
    return originalTg(method, payload);
  };
  resetBot();
  global.tg = originalTg;
  const log = state.logs.join('\n');
  if (!/ВЕБХУК НЕ УСТАНОВЛЕН/.test(log)) throw new Error('нет громкого сообщения:\n' + log);
  if (!/бот молчит на всё/.test(log)) throw new Error('нет вывода о последствиях');
  if (!/WEBAPP_URL/.test(log)) throw new Error('нет подсказки про адрес');
});

check('resetBot создаёт секрет и сообщает о совпадении версий', () => {
  propsStore.delete('WEBHOOK_SECRET');
  resetBot();
  if (!propsStore.get('WEBHOOK_SECRET')) throw new Error('секрет не создан');
  const log = state.logs.join('\n');
  if (!/вебхук установлен/.test(log)) throw new Error('нет подтверждения установки:\n' + log);
  if (!/Развёрнутая версия совпадает/.test(log)) throw new Error('нет сверки версий');
  propsStore.set('WEBHOOK_SECRET', 'sekret');
});

check('проверка() — тот же отчёт, что checkHealth()', () => {
  post(startMsg());
  eq(проверка(), checkHealth(), 'отчёты совпадают');
});

/* ===== 14. УВЕДОМЛЕНИЯ ОБ ОШИБКАХ ===== */

const alerts = () => state.sent.filter((s) => /⚠️/.test(s.text || ''));

check('сбой присылает уведомление в Telegram', () => {
  propsStore.set('ADMIN_CHAT_ID', String(CHAT));
  const original = global.runPlan_;
  global.runPlan_ = () => { throw new Error('тестовый сбой'); };
  post(startMsg());
  global.runPlan_ = original;

  eq(alerts().length, 1, 'уведомлений отправлено');
  const text = alerts()[0].text;
  if (!/ИСКЛЮЧЕНИЕ/.test(text)) throw new Error('нет вида ошибки: ' + text);
  if (!/тестовый сбой/.test(text)) throw new Error('нет текста ошибки');
  if (!/Журнал/.test(text)) throw new Error('нет указания, где смотреть подробности');
});

check('однотипные сбои не превращаются в поток сообщений', () => {
  propsStore.set('ADMIN_CHAT_ID', String(CHAT));
  const original = global.runPlan_;
  global.runPlan_ = () => { throw new Error('один и тот же сбой'); };
  // Десять одинаковых обращений: и ситуация, и ошибка совпадают.
  for (let i = 0; i < 10; i++) {
    post({ update_id: ++uid, message: { chat: { id: CHAT }, from: { id: CHAT }, text: 'привет' } });
  }
  global.runPlan_ = original;
  eq(alerts().length, 1, 'уведомлений за десять одинаковых сбоев');
  eq(logSheet.rows.length, 10, 'в журнале при этом все десять');
});

check('разные виды сбоев уведомляют по отдельности', () => {
  propsStore.set('ADMIN_CHAT_ID', String(CHAT));
  const original = global.runPlan_;
  global.runPlan_ = () => { throw new Error('сбой в обработке сообщения'); };
  post({ update_id: ++uid, message: { chat: { id: CHAT }, from: { id: CHAT }, text: 'привет' } });
  global.runPlan_ = () => { throw new Error('совсем другой сбой'); };
  post({ update_id: ++uid, message: { chat: { id: CHAT }, from: { id: CHAT }, text: 'привет' } });
  global.runPlan_ = original;
  eq(alerts().length, 2, 'уведомлений по двум разным ошибкам');
});

check('ALERTS = off выключает уведомления, журнал продолжает писать', () => {
  propsStore.set('ADMIN_CHAT_ID', String(CHAT));
  propsStore.set('ALERTS', 'off');
  const original = global.runPlan_;
  global.runPlan_ = () => { throw new Error('сбой при выключенных уведомлениях'); };
  post(startMsg());
  global.runPlan_ = original;
  propsStore.delete('ALERTS');
  eq(alerts().length, 0, 'уведомлений отправлено');
  eq(logSheet.rows[0][1], 'ИСКЛЮЧЕНИЕ', 'в журнале запись есть');
});

check('успешная работа уведомлений не вызывает', () => {
  propsStore.set('ADMIN_CHAT_ID', String(CHAT));
  post(startMsg());
  post(click(0, 1));
  eq(alerts().length, 0, 'уведомлений отправлено');
});

check('сбой журнала не срывает обработку и не уходит наружу', () => {
  propsStore.set('ADMIN_CHAT_ID', String(CHAT));
  const originalLog = global.logSheet_;
  const originalAlert = global.alertAdmin_;
  global.logSheet_ = () => { throw new Error('лист недоступен'); };
  global.alertAdmin_ = () => { throw new Error('и уведомление тоже не ушло'); };
  const out = post(startMsg());          // не должно бросить исключение
  global.logSheet_ = originalLog;
  global.alertAdmin_ = originalAlert;
  eq(out.getContent(), 'ok', 'ответ вебхука');
  eq(questions(), ['1'], 'вопрос всё равно отправлен');
});

check('включитьУведомления настраивает адресата', () => {
  post(startMsg());                       // в журнале появился chat_id
  включитьУведомления();
  eq(propsStore.get('ADMIN_CHAT_ID'), String(CHAT), 'адресат из журнала');
  if (!state.sent.some((s) => /Проверка связи/.test(s.text || ''))) {
    throw new Error('проверочное сообщение не отправлено');
  }
});

check('/diag показывает состояние уведомлений', () => {
  propsStore.set('ADMIN_CHAT_ID', String(CHAT));
  post({ update_id: ++uid, message: { chat: { id: CHAT }, from: { id: CHAT }, text: '/diag' } });
  const reply = state.sent.filter((s) => /Диагностика/.test(s.text || ''))[0];
  if (!/уведомления об ошибках: приходят в чат/.test(reply.text)) {
    throw new Error('состояние уведомлений не показано: ' + reply.text);
  }
});

check('checkHealth напоминает настроить уведомления', () => {
  post(startMsg());
  const text = checkHealth();
  if (!/Уведомления об ошибках выключены/.test(text)) throw new Error('нет напоминания:\n' + text);
  propsStore.set('ADMIN_CHAT_ID', String(CHAT));
  const text2 = checkHealth();
  if (/Уведомления об ошибках выключены/.test(text2)) throw new Error('напоминание осталось после настройки');
});

/* ===== 15. ОСТАНОВКА И ПАУЗА ===== */

check('пауза: тест не идёт, человек получает ответ, строк не появляется', () => {
  пауза();
  post(startMsg());
  eq(sheet.rows.length, 0, 'строк в таблице');
  eq(questions(), [], 'вопросов отправлено');
  const reply = state.sent.filter((s) => /на паузе/.test(s.text || ''));
  eq(reply.length, 1, 'сообщений о паузе');
  eq(logSheet.rows[0][1], 'пауза', 'итог в журнале');
  снятьПаузу();
});

check('пауза: нажатие кнопки не оставляет часики висеть', () => {
  post(startMsg());                         // тест начат до паузы
  пауза();
  const before = state.sent.length;
  post(click(0, 1));
  const after = state.sent.slice(before);
  eq(after.map((s) => s.method), ['answerCallbackQuery'], 'ответ на нажатие');
  eq(sheet.rows[0][5], '', 'ответ в таблицу не записан');
  снятьПаузу();
});

check('пауза: одинаковые сообщения не превращаются в поток', () => {
  пауза();
  for (let i = 0; i < 5; i++) post(startMsg());
  eq(state.sent.filter((s) => /на паузе/.test(s.text || '')).length, 1, 'сообщений о паузе');
  eq(logSheet.rows.length, 5, 'в журнале все пять обращений');
  снятьПаузу();
});

check('снятьПаузу возвращает бота к работе', () => {
  пауза();
  post(startMsg());
  снятьПаузу();
  post(startMsg());
  eq(questions(), ['1'], 'вопрос отправлен после снятия паузы');
  eq(sheet.rows.length, 1, 'строка создана');
});

check('текст паузы настраивается', () => {
  propsStore.set('PAUSE_TEXT', 'Вернёмся в понедельник');
  пауза();
  post(startMsg());
  if (!state.sent.some((s) => /Вернёмся в понедельник/.test(s.text || ''))) {
    throw new Error('свой текст не использован');
  }
  снятьПаузу();
  propsStore.delete('PAUSE_TEXT');
});

check('остановитьБота снимает вебхук и сбрасывает очередь', () => {
  const calls = [];
  const originalTg = global.tg;
  global.tg = (method, payload) => { calls.push([method, payload]); return originalTg(method, payload); };
  остановитьБота();
  global.tg = originalTg;
  eq(calls.map((c) => c[0]), ['deleteWebhook'], 'вызванные методы');
  eq(calls[0][1].drop_pending_updates, true, 'очередь сбрасывается');
  const log = state.logs.join('\n');
  if (!/Бот остановлен/.test(log)) throw new Error('нет подтверждения:\n' + log);
  if (!/запуститьБота/.test(log)) throw new Error('не сказано, как включить обратно');
});

check('остановитьБота сообщает о неудаче, а не молчит', () => {
  const originalTg = global.tg;
  global.tg = (method) => {
    if (method === 'deleteWebhook') return JSON.stringify({ ok: false, description: 'Unauthorized' });
    return originalTg(method);
  };
  остановитьБота();
  global.tg = originalTg;
  const log = state.logs.join('\n');
  if (!/НЕ УДАЛОСЬ снять вебхук/.test(log)) throw new Error('сбой не показан:\n' + log);
  if (!/Unauthorized/.test(log)) throw new Error('нет причины отказа');
});

check('/diag и проверка() показывают паузу', () => {
  пауза();
  propsStore.set('ADMIN_CHAT_ID', String(CHAT));
  post({ update_id: ++uid, message: { chat: { id: CHAT }, from: { id: CHAT }, text: '/diag' } });
  // На паузе /diag тоже не выполняется — это ожидаемо, состояние смотрим в редакторе.
  const text = checkHealth();
  if (!/БОТ НА ПАУЗЕ/.test(text)) throw new Error('пауза не показана:\n' + text);
  if (!/снятьПаузу/.test(text)) throw new Error('не сказано, как снять');
  снятьПаузу();
  const text2 = checkHealth();
  if (/БОТ НА ПАУЗЕ/.test(text2)) throw new Error('пауза показана после снятия');
});

const failed = results.filter((r) => r[0] === 'FAIL');
realLog('');
results.forEach(([st, name, msg]) =>
  realLog(`  ${st === 'PASS' ? '✓' : '✗'} ${name}${msg ? '\n      ' + msg : ''}`));
realLog(`\n${results.length - failed.length}/${results.length} тестов прошли\n`);
process.exit(failed.length ? 1 : 0);
