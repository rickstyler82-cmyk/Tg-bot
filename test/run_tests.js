/**
 * Прогон логики бота на заглушках Apps Script.
 * Запуск: node test/run_tests.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { stats, sheet, scriptProps, cache, realLog } = require('./gas_stubs');

// Загружаем .gs как обычный JS — порядок конкатенации как в проекте Apps Script.
// Косвенный eval, чтобы объявления попали в глобальную область, как в Apps Script.
const srcDir = path.join(__dirname, '..', 'src');
const sources = fs.readdirSync(srcDir).filter((f) => f.endsWith('.gs')).sort()
  .map((f) => fs.readFileSync(path.join(srcDir, f), 'utf8')).join('\n;\n');
const globalEval = eval;
globalEval(sources);

let updateId = 5000;
const CHAT = 401084071;

function post(update, secret = 'sekret') {
  return doPost({ parameter: { s: secret }, postData: { contents: JSON.stringify(update) } });
}
function startUpdate(payload) {
  return {
    update_id: ++updateId,
    message: {
      message_id: 1, chat: { id: CHAT },
      from: { id: CHAT, username: 'Rick_Styler', first_name: 'Sergei' },
      text: payload ? `/start ${payload}` : '/start'
    }
  };
}
function clickUpdate(step, idx, messageId) {
  return {
    update_id: ++updateId,
    callback_query: {
      id: 'cb' + updateId, from: { id: CHAT, username: 'Rick_Styler', first_name: 'Sergei' },
      message: { message_id: messageId, chat: { id: CHAT } },
      data: `a|${step}|${idx}`
    }
  };
}
function lastQuestionMessageId() {
  const sent = stats.sent.filter((s) => s.method === 'sendMessage');
  return sent.length ? 1000 + sent.length : null;
}
function reset() {
  sheet.rows.clear();
  cache.clear();
  [...scriptProps.keys()].forEach((k) => { if (k !== 'BOT_TOKEN' && k !== 'WEBHOOK_SECRET') scriptProps.delete(k); });
  stats.sent.length = 0; stats.logs.length = 0;
  stats.fetch = 0; stats.fetchAll = 0; stats.sheetOpens = 0; stats.ranges = 0;
}

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
function questionsSent() {
  return stats.sent.filter((s) => s.method === 'sendMessage' && /^\d\/5\./.test(s.text)).map((s) => s.text.slice(0, 4));
}

/* 1. Исходный баг: одна и та же доставка апдейта 54 раза. */
check('повторная доставка одного update_id не плодит строки и вопросы', () => {
  const upd = startUpdate();
  for (let i = 0; i < 54; i++) post(upd);
  eq(sheet.dataRows().length, 1, 'строк в таблице');
  eq(questionsSent(), ['1/5.'], 'отправленных вопросов');
});

/* 2. Обработчик упал — вебхук всё равно должен ответить 200. */
check('doPost отвечает ok даже когда обработчик падает', () => {
  const original = global.handleMessage_;
  global.handleMessage_ = () => { throw new Error('внутренний сбой'); };
  const out = post(startUpdate());
  global.handleMessage_ = original;
  eq(out.getContent(), 'ok', 'тело ответа');
});

/* 3. Полный проход теста. */
check('полный проход: 5 вопросов, одна строка, статус «прошёл»', () => {
  post(startUpdate('yt_shorts'));
  const answers = [1, 0, 0, 1, 1];
  answers.forEach((idx, step) => post(clickUpdate(step, idx, lastQuestionMessageId())));
  const rows = sheet.dataRows();
  eq(rows.length, 1, 'строк в таблице');
  const r = rows[0];
  eq(questionsSent(), ['1/5.', '2/5.', '3/5.', '4/5.', '5/5.'], 'вопросы по одному разу');
  eq(r[1], String(CHAT), 'chat_id');
  eq(r[2], '@Rick_Styler', 'username');
  eq(r[4], 'yt_shorts', 'Источник из deep link');
  eq(r[5], '5–6 класс', 'Класс');
  eq(r[6], 'Ребёнок сам', 'Кто пользуется');
  eq(r[7], 'Никак не проверяю', 'Проверка');
  eq(r[8], 'Не понимаю, сам сделал или нет', 'Тревога');
  eq(r[9], 'Подозреваю, но не проверял(а)', 'Ошибки');
  eq(r[10], 'Б (контролёр)', 'Сегмент');
  eq(r[11], 'красная', 'Зона');
  eq(r[12], 'прошёл', 'Статус');
  if (!r[13]) throw new Error('Дата финиша пустая');
});

/* 4. Старая кнопка из уже отвеченного вопроса. */
check('повторное нажатие старой кнопки не повторяет вопрос', () => {
  post(startUpdate());
  const mid = lastQuestionMessageId();
  post(clickUpdate(0, 1, mid));
  for (let i = 0; i < 5; i++) post(clickUpdate(0, 2, mid));   // жмём первый вопрос ещё раз
  eq(questionsSent(), ['1/5.', '2/5.'], 'вопросы');
  eq(sheet.dataRows()[0][5], '5–6 класс', 'ответ не перезаписан поздним нажатием');
});

/* 5. Повторный /start. */
check('повторный /start не создаёт вторую строку и сбрасывает ответы', () => {
  post(startUpdate());
  post(clickUpdate(0, 2, lastQuestionMessageId()));
  eq(sheet.dataRows()[0][5], '7–9 класс', 'ответ записан');
  post(startUpdate());
  const rows = sheet.dataRows();
  eq(rows.length, 1, 'строк в таблице');
  eq(rows[0][5], '', 'Класс очищен');
  eq(rows[0][12], 'начал', 'Статус сброшен');
});

/* 6. Свободный текст. */
check('произвольный текст не создаёт строк и не сдвигает шаг', () => {
  post(startUpdate());
  const before = JSON.stringify(sheet.dataRows());
  for (let i = 0; i < 3; i++) {
    post({ update_id: ++updateId, message: { message_id: 9, chat: { id: CHAT }, from: { id: CHAT }, text: 'привет' } });
  }
  eq(JSON.stringify(sheet.dataRows()), before, 'таблица не изменилась');
  eq(questionsSent(), ['1/5.'], 'вопрос не повторён');
  eq(JSON.parse(scriptProps.get('st_' + CHAT)).step, 0, 'шаг не сдвинулся');
});

/* 7. Секрет вебхука. */
check('запрос без правильного секрета отбрасывается', () => {
  post(startUpdate(), 'wrong');
  eq(sheet.dataRows().length, 0, 'строк в таблице');
  eq(stats.sent.length, 0, 'сообщений отправлено');
});

/* 8. Цена одного нажатия. */
check('одно нажатие кнопки = не больше 2 сетевых раундтрипов', () => {
  post(startUpdate());
  const f0 = stats.fetch, fa0 = stats.fetchAll;
  post(clickUpdate(0, 1, lastQuestionMessageId()));
  const roundtrips = (stats.fetch - f0) + (stats.fetchAll - fa0);
  if (roundtrips > 2) throw new Error('раундтрипов: ' + roundtrips);
});

/* 9. Индекс строки не требует чтения всего листа. */
check('второй пользователь не заставляет перечитывать лист целиком', () => {
  post(startUpdate());
  const other = { update_id: ++updateId, message: { message_id: 2, chat: { id: 777 }, from: { id: 777, username: 'x', first_name: 'X' }, text: '/start' } };
  post(other);
  eq(sheet.dataRows().length, 2, 'строк в таблице');
  const ranges0 = stats.ranges;
  post(clickUpdate(0, 1, lastQuestionMessageId()));
  if (stats.ranges - ranges0 > 4) throw new Error('обращений к диапазонам: ' + (stats.ranges - ranges0));
});

/* 10. Склейка уже накопленных дублей. */
check('dedupeSheet склеивает дубли и сохраняет ответы', () => {
  const header = CFG.HEADERS;
  sheet.getRange(1, 1, 1, header.length).setValues([header]);
  const mk = (t, klass, kto) => ['15.09.2026 ' + t, String(CHAT), '@Rick_Styler', 'Sergei', 'прямой', klass, kto, '', '', '', '', '', 'начал', '', ''];
  const rows = [mk('14:41:54', '', ''), mk('14:42:09', '7–9 класс', ''), mk('14:44:18', '', 'Пока никто'), mk('14:47:23', '5–6 класс', 'Ребёнок сам')];
  rows.forEach((r, i) => sheet.getRange(i + 2, 1, 1, header.length).setValues([r]));
  sheet.getRange(6, 1, 1, header.length).setValues([mk('15:00:00', '10–11 класс', 'Вместе').map((v, i) => (i === 1 ? '777' : v))]);

  const dry = dedupeSheet();
  eq(dry.duplicates, 3, 'дублей найдено (пробный прогон)');
  eq(sheet.dataRows().length, 5, 'пробный прогон ничего не удалил');

  dedupeSheet(true);
  const after = sheet.dataRows();
  eq(after.length, 2, 'строк осталось');
  const mine = after.find((r) => String(r[1]) === String(CHAT));
  eq(mine[5], '5–6 класс', 'Класс поднят из дубля');
  eq(mine[6], 'Ребёнок сам', 'Кто пользуется поднят из дубля');
  eq(mine[0], '15.09.2026 14:41:54', 'дата старта осталась самой ранней');
  eq(scriptProps.get('r_' + CHAT), '2', 'индекс строки пересобран');
});

/* 11. Чистая логика зон и сегментов. */
check('selfTest без ошибок', () => { eq(selfTest(), [], 'ошибки selfTest'); });

/* 12. Все кнопки доходят до записи. */
check('любая комбинация ответов даёт заполненную строку', () => {
  let combos = 0;
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
    reset();
    post(startUpdate());
    [a, b, (a + b) % 4, a, b].forEach((idx, step) => post(clickUpdate(step, idx, lastQuestionMessageId())));
    const r = sheet.dataRows()[0];
    for (let c = 5; c <= 11; c++) if (r[c] === '') throw new Error(`пустой столбец ${c} при ${a}/${b}`);
    if (r[12] !== 'прошёл') throw new Error('статус не «прошёл»');
    combos++;
  }
  if (combos !== 16) throw new Error('комбинаций проверено: ' + combos);
});

/* 13. Блокировка освобождается даже после исключения в обработчике. */
check('после сбоя блокировка освобождается и следующий апдейт обрабатывается', () => {
  const original = global.handleMessage_;
  global.handleMessage_ = () => { throw new Error('внутренний сбой'); };
  post(startUpdate());
  global.handleMessage_ = original;
  post(startUpdate());
  eq(sheet.dataRows().length, 1, 'строк в таблице');
  eq(questionsSent(), ['1/5.'], 'вопрос отправлен один раз');
});

/* 14. /start укладывается в один раундтрип к Bot API. */
check('/start = один раундтрип к Bot API', () => {
  post(startUpdate());
  eq(stats.fetch + stats.fetchAll, 1, 'раундтрипов на /start');
  eq(questionsSent(), ['1/5.'], 'первый вопрос отправлен');
});

const failed = results.filter((r) => r[0] === 'FAIL');
realLog('');
results.forEach(([st, name, msg]) => realLog(`  ${st === 'PASS' ? '✓' : '✗'} ${name}${msg ? '\n      ' + msg : ''}`));
realLog(`\n${results.length - failed.length}/${results.length} тестов прошли\n`);
process.exit(failed.length ? 1 : 0);
