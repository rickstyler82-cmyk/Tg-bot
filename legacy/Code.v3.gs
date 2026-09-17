/**
 * АРХИВ. Версия 3 — та, что «замирает после второго вопроса».
 * Хранится для воспроизведения бага, в продакшн не ставить.
 * Рабочая версия: src/Code.gs
 */

var TOKEN = PropertiesService.getScriptProperties().getProperty('TOKEN');
var SHEET_NAME = 'Ответы';
var WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbxI3rdvrCC9mFwi4PbFESqW9iGQY91fogZdr4afhuWsGsYX42cnLMMGJaHaXdaNqTV3/exec';
var API = 'https://api.telegram.org/bot';

var WELCOME =
  '<b>Делает ли ИИ домашку за вашего ребёнка?</b>\n\n' +
  'Пять вопросов, меньше минуты. В конце — ваш результат и один приём, ' +
  'который работает уже сегодня вечером.\n\n' +
  'Ответы нужны только для того, чтобы подобрать рекомендации под ваш случай.\n\n';

var QUESTIONS = [
  { key: 'class', text: '<b>1 из 5.</b> В каком классе ребёнок?',
    options: ['1–4 класс', '5–6 класс', '7–9 класс', '10–11 класс'] },
  { key: 'who', text: '<b>2 из 5.</b> Кто у вас чаще открывает нейросеть по школьным делам?',
    options: ['Я сам(а)', 'Ребёнок сам', 'Оба', 'Пока никто'] },
  { key: 'check', text: '<b>3 из 5.</b> Что вы делаете с готовым ответом нейросети?',
    options: ['Сверяю с учебником или другой сетью', 'Прошу ребёнка объяснить своими словами',
              'Просматриваю: если складно — ок', 'Не проверяю, времени нет'] },
  { key: 'pain', text: '<b>4 из 5.</b> Что беспокоит больше всего?',
    options: ['Перестанет думать сам', 'Сдаст чужую ошибку под своим именем',
              'Пользуется и молчит об этом', 'Я сам(а) не разбираюсь и отстаю'] },
  { key: 'errors', text: '<b>5 из 5.</b> Ловили нейросеть на ошибке в школьном задании?',
    options: ['Да, и не раз', 'Кажется да, но не уверен(а)', 'Нет', 'Не проверял(а), поэтому не знаю'] }
];

function doPost(e) {
  var ok = ContentService.createTextOutput('ok');
  var update;
  try { update = JSON.parse(e.postData.contents); } catch (err) { return ok; }

  var cache = CacheService.getScriptCache();
  var key = 'u' + update.update_id;
  if (cache.get(key)) return ok;
  cache.put(key, '1', 21600);

  try {
    if (update.message && update.message.text) handleMessage(update.message);
    else if (update.callback_query) handleCallback(update.callback_query);
  } catch (err) { console.error(err); }
  return ok;
}

function handleMessage(msg) {
  var chatId = msg.chat.id;
  var text = (msg.text || '').trim();
  if (text.indexOf('/start') === 0) {
    var parts = text.split(' ');
    startQuiz(chatId, msg.from, parts.length > 1 ? parts[1] : 'прямой');
  } else {
    send(chatId, 'Чтобы пройти тест, нажмите /start');
  }
}

function startQuiz(chatId, from, source) {
  var state = getState(chatId);
  if (state && state.step > 0 && state.step < QUESTIONS.length) {
    askQuestion(chatId, state.step, 'Продолжаем с того места, где вы остановились.\n\n');
    return;
  }
  setState(chatId, { step: 0, row: 0, answers: [], src: source });
  askQuestion(chatId, 0, WELCOME);
  var sheet = getSheet();
  sheet.appendRow([
    new Date(), String(chatId), from.username ? '@' + from.username : '',
    [from.first_name, from.last_name].filter(String).join(' '),
    source, '', '', '', '', '', '', '', 'начал', '', ''
  ]);
  setState(chatId, { step: 0, row: sheet.getLastRow(), answers: [], src: source });
}

function askQuestion(chatId, step, prefix) {
  var q = QUESTIONS[step];
  var keyboard = q.options.map(function (opt, i) { return [{ text: opt, callback_data: step + ':' + i }]; });
  send(chatId, (prefix || '') + q.text, { inline_keyboard: keyboard });
}

function handleCallback(cq) {
  var chatId = cq.message.chat.id;
  var parts = String(cq.data).split(':');
  var step = parseInt(parts[0], 10);
  var choice = parseInt(parts[1], 10);

  var state = getState(chatId);
  if (!state) {
    tgAsync([['answerCallbackQuery', { callback_query_id: cq.id }]]);
    send(chatId, 'Кажется, тест сбросился. Нажмите /start, чтобы начать заново.');
    return;
  }
  if (step !== state.step) {
    tgAsync([['answerCallbackQuery', { callback_query_id: cq.id }]]);
    return;
  }

  tgAsync([
    ['answerCallbackQuery', { callback_query_id: cq.id }],
    ['editMessageText', { chat_id: String(chatId), message_id: cq.message.message_id,
      text: QUESTIONS[step].text + '\n\n➡️ ' + QUESTIONS[step].options[choice], parse_mode: 'HTML' }]
  ]);

  state.answers[step] = choice;
  state.step = step + 1;
  setState(chatId, state);

  if (state.step < QUESTIONS.length) {
    askQuestion(chatId, state.step);
    writeAnswer(state.row, step, QUESTIONS[step].options[choice]);
  } else {
    finish(chatId, state, QUESTIONS[step].options[choice], step);
  }
}

function writeAnswer(row, step, value) {
  if (!row) return;
  try { getSheet().getRange(row, 6 + step).setValue(value); } catch (err) { console.error(err); }
}

function finish(chatId, state, lastValue, lastStep) {
  var res = buildResult(state.answers);
  send(chatId, res.text);
  clearState(chatId);
  if (!state.row) return;
  try {
    var sheet = getSheet();
    sheet.getRange(state.row, 6 + lastStep).setValue(lastValue);
    sheet.getRange(state.row, 11, 1, 4).setValues([[res.segment, res.zone, 'завершил', new Date()]]);
  } catch (err) { console.error(err); }
}

function buildResult(a) {
  var segment = ['Пользователь', 'Контролёр', 'Смешанный', 'Новичок'][a[1]];
  if (a[0] === 0) return { segment: segment, zone: 'Младшая школа', text: 'младшая школа' };
  var zone;
  if (a[2] === 1) zone = 'Зелёная';
  else if (a[2] === 0) zone = 'Жёлтая';
  else zone = 'Красная';
  return { segment: segment, zone: zone, text: 'результат' };
}

var _sheet = null;
function getSheet() {
  if (_sheet) return _sheet;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['Дата старта','chat_id','username','Имя','Источник','Класс','Кто пользуется',
      'Проверка','Тревога','Ошибки','Сегмент','Зона','Статус','Дата финиша','Купил']);
    sheet.setFrozenRows(1);
  }
  _sheet = sheet;
  return sheet;
}

function getState(chatId) {
  var raw = CacheService.getScriptCache().get('st' + chatId);
  return raw ? JSON.parse(raw) : null;
}
function setState(chatId, state) {
  CacheService.getScriptCache().put('st' + chatId, JSON.stringify(state), 21600);
}
function clearState(chatId) { CacheService.getScriptCache().remove('st' + chatId); }

function send(chatId, text, keyboard) {
  var payload = { chat_id: String(chatId), text: text, parse_mode: 'HTML' };
  if (keyboard) payload.reply_markup = JSON.stringify(keyboard);
  return tg('sendMessage', payload);
}
function tg(method, payload) {
  return UrlFetchApp.fetch(API + TOKEN + '/' + method,
    { method: 'post', payload: payload, muteHttpExceptions: true }).getContentText();
}
function tgAsync(calls) {
  var requests = calls.map(function (c) {
    return { url: API + TOKEN + '/' + c[0], method: 'post', payload: c[1], muteHttpExceptions: true };
  });
  try { UrlFetchApp.fetchAll(requests); } catch (err) { console.error(err); }
}
