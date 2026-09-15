/** Тонкая обёртка над Bot API. Ничего не бросает наружу: вебхук важнее ответа API. */

function tgToken_() {
  var t = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
  if (!t) throw new Error('BOT_TOKEN не задан в свойствах скрипта');
  return t;
}

function tgUrl_(method) {
  return 'https://api.telegram.org/bot' + tgToken_() + '/' + method;
}

function tgRequest_(method, payload) {
  return {
    url: tgUrl_(method),
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
}

/**
 * Один сетевой вызов. Внутри вебхука не ретраим и не спим: каждая лишняя
 * секунда здесь — это шаг к таймауту и повторной доставке апдейта.
 */
function tgCall_(method, payload) {
  try {
    var res = UrlFetchApp.fetch(tgUrl_(method), tgRequest_(method, payload));
    var code = res.getResponseCode();
    if (code !== 200) {
      log_('WARN', 'tg ' + method + ' -> ' + code + ' ' + res.getContentText().slice(0, 300));
      return null;
    }
    return JSON.parse(res.getContentText());
  } catch (err) {
    log_('WARN', 'tg ' + method + ' failed: ' + err);
    return null;
  }
}

/** Несколько вызовов одним раундтрипом — там, где порядок не важен. */
function tgCallAll_(calls) {
  if (!calls.length) return [];
  try {
    return UrlFetchApp.fetchAll(calls.map(function (c) { return tgRequest_(c.method, c.payload); }));
  } catch (err) {
    log_('WARN', 'tg fetchAll failed: ' + err);
    return [];
  }
}

function tgSend_(chatId, text, keyboard) {
  var payload = { chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  var res = tgCall_('sendMessage', payload);
  return res && res.ok ? res.result.message_id : null;
}

function tgEditRequest_(chatId, messageId, text, keyboard) {
  var payload = {
    chat_id: chatId, message_id: messageId, text: text,
    parse_mode: 'HTML', disable_web_page_preview: true
  };
  payload.reply_markup = { inline_keyboard: keyboard || [] };
  return { method: 'editMessageText', payload: payload };
}

function tgAckRequest_(callbackId, text) {
  return {
    method: 'answerCallbackQuery',
    payload: { callback_query_id: callbackId, text: text || '' }
  };
}

/** Клавиатура вопроса: callback_data = a|<шаг>|<индекс>. Шаг — защита от старых кнопок. */
function questionKeyboard_(step) {
  return QUESTIONS[step].options.map(function (opt, i) {
    return [{ text: opt, callback_data: 'a|' + step + '|' + i }];
  });
}
