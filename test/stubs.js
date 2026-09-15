/**
 * Заглушки Google Apps Script для прогона логики бота в Node.
 *
 * Заглушки моделируют то, что в Apps Script ломает наивный код:
 *  - appendRow может «идти долго», и в этот момент приходит нажатие кнопки
 *    (onSlowSheetWrite) — это отдельное параллельное выполнение doPost;
 *  - LockService не умеет ждать в одном потоке, поэтому попытка взять уже
 *    занятую блокировку сразу возвращает false: так тест видит любое место,
 *    где блокировка держится во время сетевой или табличной операции.
 */
'use strict';

const realLog = console.log;
const state = {
  sent: [],
  logs: [],
  fetch: 0,
  fetchAll: 0,
  onSlowSheetWrite: null,
  failSendMessage: false,
  lockHeld: false
};

class Sheet {
  constructor(name) { this.name = name; this.rows = []; this.frozen = 0; }
  getName() { return this.name; }
  slow() {
    if (state.onSlowSheetWrite) {
      const hook = state.onSlowSheetWrite;
      state.onSlowSheetWrite = null;
      hook();
    }
  }
  appendRow(values) { this.rows.push(values.slice()); this.slow(); }
  getLastRow() { return this.rows.length ? this.rows.length + 1 : 1; }
  setFrozenRows(n) { this.frozen = n; }
  deleteRow(row) { this.rows.splice(row - 2, 1); }
  deleteRows(row, count) { this.rows.splice(row - 2, count); }
  getDataRange() { return this.getRange(1, 1, this.getLastRow(), 15); }
  getRange(row, col, nRows = 1, nCols = 1) {
    const sheet = this;
    return {
      getValue() { return sheet.cell(row, col); },
      setValue(v) { sheet.write(row, col, v); },
      getValues() {
        const out = [];
        for (let r = 0; r < nRows; r++) {
          const line = [];
          for (let c = 0; c < nCols; c++) line.push(sheet.cell(row + r, col + c));
          out.push(line);
        }
        return out;
      },
      setValues(vals) {
        if (vals.length !== nRows) throw new Error('setValues: неверное число строк');
        vals.forEach((line, r) => {
          if (line.length !== nCols) {
            throw new Error(`setValues: ожидалось ${nCols} столбцов, пришло ${line.length}`);
          }
          line.forEach((v, c) => sheet.write(row + r, col + c, v));
        });
        sheet.slow();
      }
    };
  }
  cell(row, col) {
    if (row === 1) return HEADERS[col - 1] || '';
    const r = this.rows[row - 2];
    const v = r ? r[col - 1] : undefined;
    return v === undefined ? '' : v;
  }
  write(row, col, v) {
    if (row === 1) return;
    const r = this.rows[row - 2];
    if (!r) throw new Error(`запись в несуществующую строку ${row}`);
    while (r.length < col) r.push('');
    r[col - 1] = v;
  }
}

const HEADERS = [
  'Дата старта', 'chat_id', 'username', 'Имя', 'Источник',
  'Класс', 'Кто пользуется', 'Проверка', 'Тревога', 'Ошибки',
  'Сегмент', 'Зона', 'Статус', 'Дата финиша', 'Купил'
];

const sheet = new Sheet('Ответы');
global.SpreadsheetApp = {
  getActiveSpreadsheet: () => ({
    getSheetByName: (n) => (n === 'Ответы' ? sheet : null),
    insertSheet: () => sheet
  })
};

const propsStore = new Map([['TOKEN', 'TEST:TOKEN'], ['WEBHOOK_SECRET', 'sekret']]);
global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (k) => (propsStore.has(k) ? propsStore.get(k) : null),
    setProperty: (k, v) => propsStore.set(k, String(v)),
    deleteProperty: (k) => propsStore.delete(k),
    getProperties: () => Object.fromEntries(propsStore),
    setProperties: (obj) => Object.entries(obj).forEach(([k, v]) => propsStore.set(k, String(v)))
  })
};

const cacheStore = new Map();
global.CacheService = {
  getScriptCache: () => ({
    get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : null),
    put: (k, v, ttl) => {
      if (ttl > 21600) throw new Error('CacheService: TTL больше 21600 секунд');
      cacheStore.set(k, v);
    },
    remove: (k) => cacheStore.delete(k)
  })
};

global.LockService = {
  getScriptLock: () => ({
    tryLock: () => {
      if (state.lockHeld) return false;
      state.lockHeld = true;
      return true;
    },
    releaseLock: () => { state.lockHeld = false; }
  })
};

let messageId = 500;
function record(url, payload) {
  const method = url.split('/').pop();
  if (method === 'sendMessage' && state.failSendMessage) {
    state.sent.push({ method, text: payload.text, ok: false });
    return JSON.stringify({ ok: false, error_code: 403, description: 'bot was blocked by the user' });
  }
  state.sent.push({ method, text: payload.text, payload, ok: true });
  return JSON.stringify({ ok: true, result: { message_id: ++messageId } });
}

global.UrlFetchApp = {
  fetch: (url, params) => {
    state.fetch++;
    const body = record(url, params.payload);
    return { getContentText: () => body, getResponseCode: () => 200 };
  },
  fetchAll: (requests) => {
    state.fetchAll++;
    return requests.map((r) => {
      const body = record(r.url, r.payload);
      return { getContentText: () => body, getResponseCode: () => 200 };
    });
  }
};

global.ContentService = { createTextOutput: (t) => ({ text: t, getContent: () => t }) };
global.Utilities = {
  sleep: () => {},
  getUuid: () => '11111111-2222-3333-4444-555555555555',
  formatDate: (d) => new Date(d).toISOString()
};
global.ScriptApp = { getProjectTriggers: () => [] };
global.Logger = { log: (m) => state.logs.push(String(m)) };
global.console = {
  log: (m) => state.logs.push('LOG ' + m),
  warn: (m) => state.logs.push('WARN ' + m),
  error: (m) => state.logs.push('ERROR ' + m)
};

function reset() {
  sheet.rows.length = 0;
  cacheStore.clear();
  [...propsStore.keys()].forEach((k) => {
    if (k !== 'TOKEN' && k !== 'WEBHOOK_SECRET') propsStore.delete(k);
  });
  state.sent.length = 0;
  state.logs.length = 0;
  state.fetch = 0;
  state.fetchAll = 0;
  state.onSlowSheetWrite = null;
  state.failSendMessage = false;
  state.lockHeld = false;
  if (typeof global._sheet !== 'undefined') global._sheet = null;
}

module.exports = { state, sheet, propsStore, cacheStore, reset, realLog, HEADERS };
