/**
 * Воспроизведение зависания версии 3 после второго вопроса.
 *
 * Моделируется ровно то, что происходит в Apps Script: запись строки в лист
 * идёт после отправки первого вопроса, и пока appendRow выполняется (обычно
 * 1–3 секунды), пользователь успевает нажать кнопку. Нажатие обрабатывается
 * ОТДЕЛЬНЫМ, параллельным выполнением doPost — Apps Script их не сериализует.
 *
 * Запуск: node test/repro_freeze.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const realLog = console.log;

/* ---------- заглушки Apps Script ---------- */
const sent = [];
const cacheStore = new Map();
let onAppendRow = null;

class Sheet {
  constructor(name) { this.name = name; this.rows = []; }
  appendRow(values) {
    this.rows.push(values.slice());
    if (onAppendRow) { const hook = onAppendRow; onAppendRow = null; hook(); }  // «медленная» запись
  }
  getLastRow() { return this.rows.length + 1; }          // +1 на шапку
  setFrozenRows() {}
  getRange(row, col, nRows = 1, nCols = 1) {
    const sheet = this;
    return {
      setValue(v) { sheet.cell(row, col, v); },
      setValues(vals) { vals[0].forEach((v, i) => sheet.cell(row, col + i, v)); },
      getValue() { return (sheet.rows[row - 2] || [])[col - 1]; }
    };
  }
  cell(row, col, v) {
    const r = this.rows[row - 2];
    if (!r) throw new Error(`записываем в несуществующую строку ${row}`);
    r[col - 1] = v;
  }
  getDataRange() { return { getValues: () => [[], ...this.rows] }; }
}
const sheet = new Sheet('Ответы');

global.SpreadsheetApp = { getActiveSpreadsheet: () => ({
  getSheetByName: (n) => (n === 'Ответы' ? sheet : null),
  insertSheet: () => sheet
}) };
global.PropertiesService = { getScriptProperties: () => ({
  getProperty: (k) => (k === 'TOKEN' ? 'TEST:TOKEN' : null),
  setProperty: () => {}, deleteProperty: () => {}, getProperties: () => ({}), setProperties: () => {}
}) };
global.CacheService = { getScriptCache: () => ({
  get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : null),
  put: (k, v) => cacheStore.set(k, v),
  remove: (k) => cacheStore.delete(k)
}) };
let mid = 100;
function record(url, payload) {
  const method = url.split('/').pop();
  sent.push({ method, text: payload.text, data: payload });
  return JSON.stringify({ ok: true, result: { message_id: ++mid } });
}
global.UrlFetchApp = {
  fetch: (url, p) => ({ getContentText: () => record(url, p.payload) }),
  fetchAll: (reqs) => reqs.map((r) => { const body = record(r.url, r.payload); return { getContentText: () => body }; })
};
global.ContentService = { createTextOutput: (t) => ({ text: t }) };
global.Utilities = { sleep: () => {} };
global.console = { log: () => {}, error: () => {} };
global.Logger = { log: () => {} };

/* ---------- загрузка версии 3 ---------- */
const globalEval = eval;
globalEval(fs.readFileSync(path.join(__dirname, '..', 'legacy', 'Code.v3.gs'), 'utf8'));

/* ---------- сценарий ---------- */
const CHAT = 401084071;
let uid = 1;
const post = (update) => doPost({ postData: { contents: JSON.stringify(update) } });
const startMsg = () => ({ update_id: ++uid, message: { chat: { id: CHAT }, from: { id: CHAT, username: 'Rick_Styler', first_name: 'Sergei' }, text: '/start' } });
const click = (step, choice) => ({ update_id: ++uid, callback_query: { id: 'cb' + uid, from: { id: CHAT }, message: { message_id: 50, chat: { id: CHAT } }, data: step + ':' + choice } });

realLog('\n=== ВОСПРОИЗВЕДЕНИЕ: версия 3, зависание после второго вопроса ===\n');

// Пока appendRow выполняется, пользователь нажимает кнопку первого вопроса.
onAppendRow = () => {
  realLog('   [во время appendRow] пользователь нажимает вариант первого вопроса');
  post(click(0, 1));
};

realLog('1. /start');
post(startMsg());

realLog('   состояние после /start и ответа на вопрос 1: ' + cacheStore.get('st' + CHAT));
realLog('   отправлено сообщений: ' + sent.filter((s) => s.method === 'sendMessage').length);

realLog('\n2. пользователь нажимает вариант ВТОРОГО вопроса');
const before = sent.length;
post(click(1, 1));
const after = sent.slice(before);

realLog('   вызовов к Telegram: ' + after.map((s) => s.method).join(', '));
const questionsSent = sent.filter((s) => s.method === 'sendMessage' && /из 5/.test(s.text || ''));
realLog('   всего вопросов отправлено: ' + questionsSent.length +
        ' (' + questionsSent.map((s) => s.text.match(/\d из 5/)[0]).join(', ') + ')');

const gotThird = after.some((s) => s.method === 'sendMessage' && /3 из 5/.test(s.text || ''));
realLog('\n   третий вопрос пришёл: ' + (gotThird ? 'да' : 'НЕТ — бот замер'));

realLog('\n3. что записано в таблицу:');
sheet.rows.forEach((r, i) => realLog('   строка ' + (i + 2) + ': ' +
  JSON.stringify([r[1], r[5], r[6], r[12]])));

realLog('\n4. дальнейшие нажатия по тем же кнопкам:');
[1, 2, 3].forEach((c) => {
  const b = sent.length;
  post(click(1, c));
  realLog('   нажатие "1:' + c + '" → ' + (sent.slice(b).map((s) => s.method).join(', ') || 'ничего'));
});

realLog('');
process.exit(gotThird ? 1 : 0);
