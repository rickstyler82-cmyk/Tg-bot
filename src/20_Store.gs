/**
 * Хранилище.
 *
 * Состояние диалога живёт в свойствах скрипта (st_<chatId>), а НЕ вычисляется
 * из таблицы. Пересчёт шага из таблицы — источник и дублей, и тормозов:
 * поиск по всему листу на каждое нажатие + потеря шага при лишней строке.
 *
 * Строка в таблице ровно одна на chat_id. Её номер кэшируется в r_<chatId>,
 * поэтому обычное нажатие не читает лист целиком.
 */

function props_() { return PropertiesService.getScriptProperties(); }

function sheet_() {
  var id = props_().getProperty('SHEET_ID') || CFG.SHEET_ID;
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CFG.SHEET_NAME) || ss.getSheets()[0];
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, CFG.HEADERS.length).setValues([CFG.HEADERS]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function now_() { return Utilities.formatDate(new Date(), CFG.TZ, 'dd.MM.yyyy HH:mm:ss'); }

/* ---------- состояние диалога ---------- */

function stateGet_(chatId) {
  var raw = props_().getProperty('st_' + chatId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function stateSet_(chatId, state) {
  props_().setProperty('st_' + chatId, JSON.stringify(state));
}

function stateDrop_(chatId) {
  props_().deleteProperty('st_' + chatId);
}

/* ---------- строка пользователя ---------- */

function rowFind_(sheet, chatId) {
  var cached = props_().getProperty('r_' + chatId);
  if (cached) {
    var n = parseInt(cached, 10);
    if (n >= 2 && n <= sheet.getLastRow()) {
      if (String(sheet.getRange(n, CFG.COL.chatId).getValue()) === String(chatId)) return n;
    }
    props_().deleteProperty('r_' + chatId);
  }
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var ids = sheet.getRange(2, CFG.COL.chatId, last - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) {         // свежие строки ближе к концу
    if (String(ids[i][0]) === String(chatId)) {
      var row = i + 2;
      props_().setProperty('r_' + chatId, String(row));
      return row;
    }
  }
  return 0;
}

/**
 * Одна строка на пользователя: есть — обновляем, нет — добавляем.
 * Именно здесь раньше рождались дубли: appendRow на каждый апдейт.
 */
function rowUpsert_(chatId, username, name, source) {
  var sheet = sheet_();
  var row = rowFind_(sheet, chatId);
  if (!row) {
    row = Math.max(sheet.getLastRow() + 1, 2);
    sheet.getRange(row, 1, 1, CFG.HEADERS.length).setValues([[
      now_(), String(chatId), username, name, source,
      '', '', '', '', '', '', '', CFG.STATUS.started, '', ''
    ]]);
    props_().setProperty('r_' + chatId, String(row));
    return row;
  }
  // Повторный /start: обновляем шапку строки и чистим прошлые ответы.
  sheet.getRange(row, 1, 1, 5).setValues([[now_(), String(chatId), username, name, source]]);
  sheet.getRange(row, CFG.COL.firstAnswer, 1, CFG.COL.finished - CFG.COL.firstAnswer + 1)
       .setValues([['', '', '', '', '', '', '', CFG.STATUS.started, '']]);
  return row;
}

/**
 * Если номер строки потерялся (лист правили руками, upsert не прошёл),
 * ответ не должен пропадать: строка восстанавливается по chat_id.
 */
function rowEnsure_(chatId, row) {
  if (row && row >= 2) return row;
  var sheet = sheet_();
  var found = rowFind_(sheet, chatId);
  if (found) return found;
  log_('WARN', 'строка для chat ' + chatId + ' не найдена, создаётся заново');
  return rowUpsert_(chatId, '', '', 'восстановлено');
}

function rowWriteAnswer_(chatId, row, col, value) {
  sheet_().getRange(rowEnsure_(chatId, row), col).setValue(value);
}

/** Финиш — одна запись на диапазон F..N вместо девяти отдельных. */
function rowWriteResult_(chatId, row, answers, segment, zone) {
  row = rowEnsure_(chatId, row);
  var values = [[
    answers.klass || '', answers.kto || '', answers.proverka || '',
    answers.trevoga || '', answers.oshibki || '',
    segment, zone, CFG.STATUS.finished, now_()
  ]];
  sheet_().getRange(row, CFG.COL.firstAnswer, 1, values[0].length).setValues(values);
}

/* ---------- лог ---------- */

function log_(level, message) {
  console.log(level + ': ' + message);
}
