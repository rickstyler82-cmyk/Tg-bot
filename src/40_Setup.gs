/**
 * Установка и диагностика. Запускать вручную из редактора Apps Script.
 * Порядок первого запуска:
 *   1) initProperties()  — один раз вписать токен и секрет прямо в код функции
 *      либо задать свойства в Project Settings → Script properties;
 *   2) Deploy → New deployment → Web app → Execute as: Me,
 *      Who has access: Anyone → скопировать URL;
 *   3) вписать URL в свойство WEBAPP_URL и вызвать installWebhook();
 *   4) webhookInfo() — убедиться, что pending_update_count = 0 и last_error пуст.
 */

function initProperties() {
  var sp = PropertiesService.getScriptProperties();
  // Заполните значения, запустите функцию один раз и очистите строки обратно.
  var values = {
    // BOT_TOKEN: '123456:AA...',
    // WEBAPP_URL: 'https://script.google.com/macros/s/.../exec',
    // TRIPWIRE_URL: 'https://...'
  };
  Object.keys(values).forEach(function (k) { if (values[k]) sp.setProperty(k, values[k]); });

  if (!sp.getProperty('WEBHOOK_SECRET')) {
    sp.setProperty('WEBHOOK_SECRET', Utilities.getUuid().replace(/-/g, ''));
  }
  Logger.log('Заданы свойства: ' + Object.keys(sp.getProperties()).join(', '));
}

/**
 * drop_pending_updates=true обязателен: он выбрасывает очередь недоставленных
 * апдейтов. Без него после починки бот сразу отработает всё накопившееся —
 * то есть снова насыплет дублей.
 */
function installWebhook() {
  var sp = PropertiesService.getScriptProperties();
  var base = sp.getProperty('WEBAPP_URL');
  var secret = sp.getProperty('WEBHOOK_SECRET');
  if (!base) throw new Error('WEBAPP_URL не задан');
  if (!secret) throw new Error('WEBHOOK_SECRET не задан, запустите initProperties()');

  var res = tgCall_('setWebhook', {
    url: base + '?s=' + encodeURIComponent(secret),
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
    max_connections: 40
  });
  Logger.log(JSON.stringify(res));
  return res;
}

function deleteWebhook() {
  var res = tgCall_('deleteWebhook', { drop_pending_updates: true });
  Logger.log(JSON.stringify(res));
  return res;
}

/** Главная диагностика. pending_update_count > 0 и last_error_message = очередь повторов. */
function webhookInfo() {
  var res = tgCall_('getWebhookInfo', {});
  Logger.log(JSON.stringify(res, null, 2));
  return res;
}

/**
 * getUpdates и вебхук вместе не работают: если рядом висит триггер по времени,
 * который сам опрашивает getUpdates, апдейты обрабатываются дважды.
 */
function listTriggers() {
  var t = ScriptApp.getProjectTriggers().map(function (x) {
    return x.getHandlerFunction() + ' / ' + x.getEventType();
  });
  Logger.log(t.length ? t.join('\n') : 'триггеров нет — это правильное состояние');
  return t;
}

function removeAllTriggers() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); n++; });
  Logger.log('удалено триггеров: ' + n);
  return n;
}
