/**
 * Минимальные заглушки Google Apps Script, чтобы прогнать логику бота в Node.
 * Заглушки специально «медленные» по семантике: считают обращения к листу и
 * сетевые вызовы, чтобы тест видел не только результат, но и цену запроса.
 */
'use strict';

const stats = { fetch: 0, fetchAll: 0, sheetOpens: 0, ranges: 0, sent: [], logs: [] };

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
    stats.ranges++;
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) line.push(this.sheet.cell(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  getValue() { return this.sheet.cell(this.row, this.col); }
  setValues(values) {
    if (values.length !== this.numRows) throw new Error('setValues: неверное число строк');
    values.forEach((line, r) => {
      if (line.length !== this.numCols) {
        throw new Error(`setValues: ожидалось ${this.numCols} столбцов, пришло ${line.length}`);
      }
      line.forEach((v, c) => this.sheet.setCell(this.row + r, this.col + c, v));
    });
    return this;
  }
  setValue(v) { this.sheet.setCell(this.row, this.col, v); return this; }
}

class FakeSheet {
  constructor(name) { this.name = name; this.rows = new Map(); this.frozen = 0; }
  getName() { return this.name; }
  cell(row, col) {
    const line = this.rows.get(row);
    const v = line ? line[col - 1] : undefined;
    return v === undefined ? '' : v;
  }
  setCell(row, col, value) {
    if (!this.rows.has(row)) this.rows.set(row, []);
    const line = this.rows.get(row);
    while (line.length < col) line.push('');
    line[col - 1] = value;
  }
  getLastRow() { return this.rows.size ? Math.max(...this.rows.keys()) : 0; }
  getRange(row, col, numRows = 1, numCols = 1) { return new FakeRange(this, row, col, numRows, numCols); }
  setFrozenRows(n) { this.frozen = n; }
  deleteRow(row) {
    const last = this.getLastRow();
    for (let r = row; r < last; r++) {
      if (this.rows.has(r + 1)) this.rows.set(r, this.rows.get(r + 1));
      else this.rows.delete(r);
    }
    this.rows.delete(last);
  }
  dataRows() {
    const out = [];
    for (let r = 2; r <= this.getLastRow(); r++) out.push(this.getRange(r, 1, 1, 15).getValues()[0]);
    return out;
  }
}

const sheet = new FakeSheet('Ответы');

global.SpreadsheetApp = {
  openById: () => { stats.sheetOpens++; return spreadsheet; },
  getActiveSpreadsheet: () => { stats.sheetOpens++; return spreadsheet; }
};
const spreadsheet = {
  getSheetByName: (n) => (n === sheet.getName() ? sheet : null),
  getSheets: () => [sheet]
};

const scriptProps = new Map([['BOT_TOKEN', 'TEST:TOKEN'], ['WEBHOOK_SECRET', 'sekret']]);
global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (k) => (scriptProps.has(k) ? scriptProps.get(k) : null),
    setProperty: (k, v) => scriptProps.set(k, String(v)),
    deleteProperty: (k) => scriptProps.delete(k),
    getProperties: () => Object.fromEntries(scriptProps),
    setProperties: (obj) => Object.entries(obj).forEach(([k, v]) => scriptProps.set(k, String(v)))
  })
};

const cache = new Map();
global.CacheService = {
  getScriptCache: () => ({
    get: (k) => (cache.has(k) ? cache.get(k) : null),
    put: (k, v) => cache.set(k, v)
  })
};

let lockHeld = false;
global.LockService = {
  getScriptLock: () => ({
    tryLock: () => { if (lockHeld) return false; lockHeld = true; return true; },
    releaseLock: () => { lockHeld = false; }
  })
};

let messageId = 1000;
function record(method, payload) {
  if (method === 'sendMessage') {
    payload.message_id = ++messageId;
    stats.sent.push({ method, chat: payload.chat_id, text: payload.text, kb: payload.reply_markup });
    return { ok: true, result: { message_id: messageId } };
  }
  stats.sent.push({ method, chat: payload.chat_id, text: payload.text, kb: payload.reply_markup });
  return { ok: true, result: true };
}

global.UrlFetchApp = {
  fetch: (url, params) => {
    stats.fetch++;
    const method = url.split('/').pop();
    const body = record(method, JSON.parse(params.payload));
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) };
  },
  fetchAll: (requests) => {
    stats.fetchAll++;
    return requests.map((r) => {
      const method = r.url.split('/').pop();
      const body = record(method, JSON.parse(r.payload));
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify(body) };
    });
  }
};

global.ContentService = {
  MimeType: { TEXT: 'text/plain' },
  createTextOutput: (t) => ({ text: t, setMimeType() { return this; }, getContent: () => t })
};

global.Utilities = {
  formatDate: (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 19),
  getUuid: () => 'uuid-uuid-uuid',
  sleep: () => {}
};
global.Logger = { log: (m) => stats.logs.push(String(m)) };
global.ScriptApp = { getProjectTriggers: () => [], deleteTrigger: () => {} };

const realLog = console.log;
global.console = { log: (m) => stats.logs.push(String(m)) };

module.exports = { stats, sheet, scriptProps, cache, realLog, nextMessageId: () => messageId };
