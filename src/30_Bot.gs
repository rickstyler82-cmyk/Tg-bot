/**
 * Точка входа вебхука.
 *
 * Правило №1: doPost ВСЕГДА отвечает 200 OK.
 * Любой ответ, кроме 2xx (в Apps Script это необработанное исключение → 500),
 * Telegram считает недоставкой и присылает тот же update снова: через 3, 5, 7,
 * 10, 18, 34, 67 секунд и далее раз в 1–2 минуты, пока не получит 200. Каждая
 * повторная доставка заново пишет строку в таблицу и заново присылает вопрос —
 * это и есть «дублирует вопросы» и «долго думает».
 */
function doPost(e) {
  try {
    handleRequest_(e);
  } catch (err) {
    log_('ERROR', (err && err.stack) ? err.stack : String(err));
  }
  return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
}

function doGet() {
  return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
}

function handleRequest_(e) {
  if (!e || !e.postData || !e.postData.contents) return;

  // Секрет передаётся в query-строке вебхука: заголовки в Apps Script не видны.
  var secret = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
  if (secret && (!e.parameter || e.parameter.s !== secret)) {
    log_('WARN', 'запрос с неверным секретом отброшен');
    return;
  }

  var update;
  try {
    update = JSON.parse(e.postData.contents);
  } catch (err) {
    log_('WARN', 'битый JSON в апдейте');
    return;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CFG.LOCK_WAIT_MS)) {
    log_('WARN', 'не дождались блокировки, апдейт ' + update.update_id + ' пропущен');
    return;
  }
  try {
    if (seenUpdate_(update.update_id)) return;   // повторная доставка того же апдейта
    if (update.callback_query) handleCallback_(update.callback_query);
    else if (update.message) handleMessage_(update.message);
  } finally {
    lock.releaseLock();
  }
}

/** Идемпотентность по update_id: проверка и отметка под общей блокировкой. */
function seenUpdate_(updateId) {
  if (updateId === undefined || updateId === null) return false;
  var cache = CacheService.getScriptCache();
  var key = 'upd_' + updateId;
  if (cache.get(key)) {
    log_('INFO', 'дубль апдейта ' + updateId + ' отброшен');
    return true;
  }
  cache.put(key, '1', CFG.DEDUPE_TTL_SEC);
  return false;
}

/* ---------- сообщения ---------- */

function handleMessage_(msg) {
  var chatId = msg.chat.id;
  var text = (msg.text || '').trim();

  if (/^\/start\b/.test(text)) return cmdStart_(msg, text);
  if (/^\/restart\b/.test(text)) return cmdStart_(msg, '/start');
  if (/^\/help\b/.test(text)) {
    return tgSend_(chatId, 'Это тест «Делает ли ИИ домашку за вашего ребёнка?» — 5 вопросов, минута.\n\n/start — пройти заново.');
  }

  // Любой другой текст не создаёт строк и не сдвигает шаг.
  var state = stateGet_(chatId);
  if (state && state.step < QUESTIONS.length) {
    tgSend_(chatId, 'Нажмите кнопку под вопросом выше — так ответ попадёт в тест. Если кнопки не видно, отправьте /start.');
  } else {
    tgSend_(chatId, 'Чтобы пройти тест, отправьте /start.');
  }
}

function cmdStart_(msg, text) {
  var chatId = msg.chat.id;
  var from = msg.from || {};
  var username = from.username ? '@' + from.username : '';
  var name = [from.first_name || '', from.last_name || ''].join(' ').trim();
  var payload = text.replace(/^\/start(@\S+)?\s*/, '').trim();
  var source = payload ? payload.slice(0, 64) : 'прямой';

  var intro =
    'Нейросети — это новые ГДЗ: спорить с ними бессмысленно, а вот проверять их никто не учил.\n\n' +
    '<b>5 вопросов, минута времени.</b> В конце — где именно у вас сейчас слабое место и что с ним делать сегодня вечером.';

  // Приветствие и первый вопрос уходят одним раундтрипом, а не двумя подряд:
  // пользователь видит тест сразу, а не после двух обращений к Bot API.
  var responses = tgCallAll_([
    { method: 'sendMessage', payload: { chat_id: chatId, text: intro, parse_mode: 'HTML', disable_web_page_preview: true } },
    { method: 'sendMessage', payload: {
        chat_id: chatId, text: QUESTIONS[0].text, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: questionKeyboard_(0) } } }
  ]);
  var mid = messageIdOf_(responses[1]);

  // Запись в таблицу — после отправки: лист не должен стоять на пути к ответу.
  var row = rowUpsert_(chatId, username, name, source);
  stateSet_(chatId, { step: 0, row: row, mid: mid, a: {} });
}

function messageIdOf_(response) {
  try {
    if (!response || response.getResponseCode() !== 200) return null;
    var body = JSON.parse(response.getContentText());
    return body && body.ok ? body.result.message_id : null;
  } catch (err) {
    return null;
  }
}

/* ---------- нажатия кнопок ---------- */

function handleCallback_(cq) {
  var chatId = cq.message && cq.message.chat ? cq.message.chat.id : (cq.from || {}).id;
  var data = cq.data || '';

  // Спиннер на кнопке гасим первым же делом — именно он читается как «бот думает».
  if (data === 'restart') {
    tgCall_('answerCallbackQuery', { callback_query_id: cq.id });
    return cmdStart_({ chat: { id: chatId }, from: cq.from }, '/start');
  }

  var parts = data.split('|');
  if (parts[0] !== 'a' || parts.length !== 3) {
    tgCall_('answerCallbackQuery', { callback_query_id: cq.id });
    return;
  }
  var step = parseInt(parts[1], 10);
  var idx = parseInt(parts[2], 10);

  var state = stateGet_(chatId);
  if (!state) {
    tgCallAll_([tgAckRequest_(cq.id, 'Тест сброшен, начнём заново')]);
    return cmdStart_({ chat: { id: chatId }, from: cq.from }, '/start');
  }

  // Кнопка из уже отвеченного (или будущего) вопроса: подтверждаем и выходим.
  // Без этой проверки повторное нажатие сдвигает шаг и присылает вопрос второй раз.
  if (step !== state.step) {
    tgCallAll_([tgAckRequest_(cq.id, 'На этот вопрос вы уже ответили')]);
    return;
  }

  var q = QUESTIONS[step];
  if (!(idx >= 0 && idx < q.options.length)) {
    tgCallAll_([tgAckRequest_(cq.id)]);
    return;
  }
  var answer = q.options[idx];
  state.a[q.key] = answer;
  state.step = step + 1;
  stateSet_(chatId, state);

  var isLast = state.step >= QUESTIONS.length;
  var messageId = cq.message ? cq.message.message_id : state.mid;

  // Отвеченный вопрос превращаем в строку истории: новых сообщений не плодим.
  var doneText = '<b>' + q.text + '</b>\n✓ ' + answer;
  tgCallAll_([tgAckRequest_(cq.id), tgEditRequest_(chatId, messageId, doneText, [])]);

  if (!isLast) {
    var nextMid = tgSend_(chatId, QUESTIONS[state.step].text, questionKeyboard_(state.step));
    state.mid = nextMid;
    stateSet_(chatId, state);
    rowWriteAnswer_(chatId, state.row, q.col, answer);   // запись после отправки вопроса
    return;
  }

  finish_(chatId, state);
}

/* ---------- результат ---------- */

function finish_(chatId, state) {
  var a = state.a;
  var row = state.row;
  var segment = segmentOf_(a);
  var zone = zoneOf_(a);

  tgSend_(chatId, resultText_(a, zone), resultKeyboard_());

  // Состояние снимаем до записи в лист: если запись сорвётся, диалог не залипнет
  // на шаге «тест пройден», а спокойно начнётся заново по /start.
  stateDrop_(chatId);
  rowWriteResult_(chatId, row, a, segment, zone);
}

function segmentOf_(a) {
  switch (a.kto) {
    case 'Я сам(а) делаю с нейросетью': return 'А (пользователь)';
    case 'Ребёнок сам':                 return 'Б (контролёр)';
    case 'Вместе':                      return 'А+Б';
    default:                            return 'В (на входе)';
  }
}

/**
 * Зона считается по одной боли — «никто не умеет проверять».
 * Она, в отличие от «ребёнок списывает домашку», не имеет срока годности.
 */
function zoneOf_(a) {
  var score = 0;
  if (a.klass === '1–4 класс' || a.klass === '5–6 класс') score += 1;

  if (a.kto === 'Ребёнок сам') score += 2;
  else if (a.kto === 'Вместе' || a.kto === 'Я сам(а) делаю с нейросетью') score += 1;

  if (a.proverka === 'Никак не проверяю') score += 3;
  else if (a.proverka === 'Читаю и проверяю сам(а)') score += 1;

  if (a.trevoga && a.trevoga !== 'Ничего не беспокоит') score += 1;

  if (a.oshibki === 'Подозреваю, но не проверял(а)' || a.oshibki === 'Не знаю') score += 2;
  else if (a.oshibki === 'Нет, ошибок не было') score += 1;

  if (score >= 6) return 'красная';
  if (score >= 3) return 'жёлтая';
  return 'зелёная';
}

function resultText_(a, zone) {
  var head = {
    'красная': '<b>Красная зона.</b> Нейросеть уже участвует в домашке, а механизма проверки в семье нет. Это не про лень ребёнка — проверять ответы ИИ не учили ни его, ни вас.',
    'жёлтая':  '<b>Жёлтая зона.</b> Вы уже что-то проверяете, но выборочно. Ошибка проходит там, где ответ выглядит уверенно.',
    'зелёная': '<b>Зелёная зона.</b> Привычка проверять есть. Дальше — предметные ловушки: где именно нейросети врут по русскому, математике и химии.'
  }[zone];

  var byClass = a.klass === '1–4 класс'
    ? 'По рекомендациям Минпросвещения от 12.09.2026 в 1–4 классах нейросеть использовать нельзя. Значит проверка целиком на взрослом.'
    : 'С 5 класса нейросеть разрешена для поиска, объяснения тем и проверки гипотез. Правил проверки при этом не дали никому.';

  var step = {
    'Никак не проверяю': 'Сегодня вечером: попросите ребёнка объяснить готовый ответ своими словами. Тридцать секунд — и видно, понял он или скопировал.',
    'Читаю и проверяю сам(а)': 'Сегодня вечером: то же задание задайте второй нейросети. Разные ответы на один вопрос — самый быстрый детектор вранья.',
    'Прошу ребёнка объяснить своими словами': 'Вы делаете главное. Добавьте второй шаг: перезапрос тем же вопросом в другой сети.',
    'Перепроверяю в другой нейросети': 'Вы делаете главное. Добавьте вопрос ребёнку «объясни своими словами» — он проверяет понимание, а не текст.'
  }[a.proverka] || 'Сегодня вечером: попросите ребёнка объяснить готовый ответ своими словами.';

  return head + '\n\n' + byClass + '\n\n' + step +
    '\n\nЯ дал нейросети задачу по химии из учебника — ответ вышел ровно вдвое меньше правильного. ' +
    'Таких мест по школьным предметам набирается целый каталог, и в мини-курсе они разобраны на реальных заданиях.';
}

function resultKeyboard_() {
  var rows = [];
  var url = PropertiesService.getScriptProperties().getProperty('TRIPWIRE_URL');
  if (url) rows.push([{ text: 'Мини-курс «Доверяй, но проверяй» — 990 ₽', url: url }]);
  rows.push([{ text: 'Пройти тест заново', callback_data: 'restart' }]);
  return rows;
}
