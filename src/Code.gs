/**
 * Бот-опросник «Делает ли ИИ домашку за вашего ребёнка?» — версия 4
 *
 * Тексты вопросов и результатов — из версии 3 без изменений.
 * Исправлены три причины зависания и дублей:
 *
 * 1. ГОНКА ЗА СОСТОЯНИЕМ (из-за неё бот замирал после второго вопроса).
 *    В версии 3 startQuiz вызывал setState дважды: сначала {step:0,row:0},
 *    потом, уже ПОСЛЕ appendRow, ещё раз {step:0,row:N}. Пока appendRow писал
 *    строку (1–3 с), пользователь успевал нажать кнопку первого вопроса —
 *    это отдельное, параллельное выполнение doPost, Apps Script их не
 *    сериализует. Оно ставило step:1 и отправляло второй вопрос, а затем
 *    запоздавший второй setState откатывал step назад на 0 и стирал ответы.
 *    Нажатие на второй вопрос давало step(1) !== state.step(0) — тихий выход,
 *    и бот замирал навсегда. Теперь номер строки хранится отдельно от
 *    состояния диалога и не может его перезаписать.
 *
 * 2. ДЕДУПЛИКАЦИЯ БЕЗ БЛОКИРОВКИ. Проверка cache.get и отметка cache.put шли
 *    двумя отдельными действиями. Telegram присылает повтор через 3 секунды,
 *    и если первое выполнение ещё идёт, оба проходят проверку — строка и
 *    вопрос дублируются. Теперь переход состояния идёт под блокировкой, но
 *    блокировка держится только на операциях с кэшем (десятки миллисекунд),
 *    а не на сети и таблице — из-за чего её и убрали в версии 3.
 *
 * 3. ПОВТОРНЫЙ /start ПЛОДИЛ СТРОКИ. Условие возобновления было step > 0,
 *    поэтому /start на нулевом шаге добавлял вторую строку. Теперь строка
 *    одна на chat_id, /start её обновляет.
 *
 * Свойства проекта (Настройки проекта → Свойства скрипта):
 *   TOKEN           — токен бота, обязательно
 *   WEBHOOK_SECRET  — создаётся автоматически при первом resetBot()
 *   WEBAPP_URL      — URL развёртывания, если не совпадает с константой ниже
 */

// ============ НАСТРОЙКИ ============

var TOKEN = PropertiesService.getScriptProperties().getProperty('TOKEN');
var SHEET_NAME = 'Ответы';
var WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbxI3rdvrCC9mFwi4PbFESqW9iGQY91fogZdr4afhuWsGsYX42cnLMMGJaHaXdaNqTV3/exec';
var API = 'https://api.telegram.org/bot';

var STATE_TTL = 21600;   // 6 часов — предел CacheService
var LOCK_MS = 5000;      // блокировка только на переход состояния
var COL_FIRST_ANSWER = 6;

// Версия видна в отчёте по адресу развёртывания и в ответе на /diag.
// По ней сразу понятно, обновлено ли развёртывание.
var CODE_VERSION = '4.1';

// Отметку ставит scripts/deploy.sh перед отправкой кода: дата и хеш коммита.
// По ней развёрнутый код сверяется с локальным точно, а не с точностью до
// номера версии — одна и та же версия могла быть собрана из разного кода.
var BUILD_STAMP = 'развёрнуто вручную';

var LOG_SHEET_NAME = 'Журнал';
var LOG_HEADERS = ['Время', 'Итог', 'update_id', 'chat_id', 'Событие', 'Шаг', 'Мс', 'Подробности', 'Версия'];
var LOG_KEEP_ROWS = 2000;   // сверх этого самые старые строки удаляются

// Последняя ошибка Bot API за текущее выполнение — попадает в журнал.
var _lastApiError = '';

// ============ ТЕКСТЫ ВОПРОСОВ ============

var WELCOME =
  '<b>Делает ли ИИ домашку за вашего ребёнка?</b>\n\n' +
  'Пять вопросов, меньше минуты. В конце — ваш результат и один приём, ' +
  'который работает уже сегодня вечером.\n\n' +
  'Ответы нужны только для того, чтобы подобрать рекомендации под ваш случай.\n\n';

var QUESTIONS = [
  {
    key: 'class',
    text: '<b>1 из 5.</b> В каком классе ребёнок?',
    options: ['1–4 класс', '5–6 класс', '7–9 класс', '10–11 класс']
  },
  {
    key: 'who',
    text: '<b>2 из 5.</b> Кто у вас чаще открывает нейросеть по школьным делам?',
    options: ['Я сам(а)', 'Ребёнок сам', 'Оба', 'Пока никто']
  },
  {
    key: 'check',
    text: '<b>3 из 5.</b> Что вы делаете с готовым ответом нейросети?',
    options: [
      'Сверяю с учебником или другой сетью',
      'Прошу ребёнка объяснить своими словами',
      'Просматриваю: если складно — ок',
      'Не проверяю, времени нет'
    ]
  },
  {
    key: 'pain',
    text: '<b>4 из 5.</b> Что беспокоит больше всего?',
    options: [
      'Перестанет думать сам',
      'Сдаст чужую ошибку под своим именем',
      'Пользуется и молчит об этом',
      'Я сам(а) не разбираюсь и отстаю'
    ]
  },
  {
    key: 'errors',
    text: '<b>5 из 5.</b> Ловили нейросеть на ошибке в школьном задании?',
    options: [
      'Да, и не раз',
      'Кажется да, но не уверен(а)',
      'Нет',
      'Не проверял(а), поэтому не знаю'
    ]
  }
];

// ============ ТОЧКА ВХОДА (webhook) ============

/**
 * doPost всегда отвечает 200 OK: любой другой ответ Telegram считает
 * недоставкой и присылает тот же update снова, пока не получит 200.
 *
 * Работа разделена на два этапа. Первый — planUpdate_: под блокировкой
 * гасятся повторы и делается переход состояния, только операции с кэшем.
 * Второй — runPlan_: сеть и таблица, уже без блокировки.
 */
function doPost(e) {
  var ok = ContentService.createTextOutput('ok');
  var t0 = Date.now();
  var ctx = { updateId: '', chatId: '', event: '', step: '', plan: '' };
  _lastApiError = '';

  try {
    var raw = (e && e.postData) ? e.postData.contents : '';
    if (!raw) {
      logUpdate_(ctx, 'ПУСТОЙ ЗАПРОС', t0, 'в теле запроса нет данных — так выглядит открытие адреса в браузере, а не вызов Telegram');
      return ok;
    }

    var update;
    try {
      update = JSON.parse(raw);
    } catch (err) {
      logUpdate_(ctx, 'БИТЫЙ JSON', t0, String(raw).slice(0, 200));
      return ok;
    }

    ctx.updateId = update.update_id === undefined ? '' : update.update_id;
    describeUpdate_(ctx, update);

    var secret = checkSecret_(e);
    if (!secret.ok) {
      logUpdate_(ctx, 'ОТБРОШЕН: СЕКРЕТ', t0, secret.reason);
      return ok;
    }

    if (!TOKEN) {
      logUpdate_(ctx, 'ОШИБКА: НЕТ TOKEN', t0,
        'свойство скрипта TOKEN пусто. Настройки проекта → Свойства скрипта → ключ TOKEN');
      return ok;
    }

    var plan = planUpdate_(update);
    if (!plan) {
      logUpdate_(ctx, 'пропущен', t0,
        'повторная доставка того же update_id либо неподдерживаемый тип обновления');
      return ok;
    }

    ctx.plan = plan.kind;
    if (plan.step !== undefined) ctx.step = plan.step;
    runPlan_(plan);

    logUpdate_(ctx, _lastApiError ? 'ОШИБКА BOT API' : 'обработан', t0, _lastApiError);
  } catch (err) {
    logUpdate_(ctx, 'ИСКЛЮЧЕНИЕ', t0, errText_(err));
  }
  return ok;
}

/**
 * Открытие адреса развёртывания в браузере отдаёт отчёт о состоянии.
 * Это самая быстрая проверка «какая версия кода реально развёрнута»:
 * если в ответе версия старая или вместо отчёта что-то другое —
 * развёртывание не обновлено.
 *
 * Без ключа отчёт не содержит ничего личного: адрес открыт всем.
 * Полный отчёт: ?k=<WEBHOOK_SECRET>
 */
function doGet(e) {
  var report = { версия_кода: CODE_VERSION, отметка_сборки: BUILD_STAMP, время: nowText_() };
  try {
    var sp = PropertiesService.getScriptProperties();
    var secret = sp.getProperty('WEBHOOK_SECRET');
    report.токен_задан = !!TOKEN;
    report.секрет_задан = !!secret;
    report.уровень_журнала = logLevel_();

    try {
      report.строк_ответов = Math.max(getSheet().getLastRow() - 1, 0);
      report.строк_журнала = Math.max(logSheet_().getLastRow() - 1, 0);
    } catch (err) {
      report.таблица = 'ОШИБКА: ' + errText_(err);
    }

    if (secret && e && e.parameter && e.parameter.k === secret) {
      report.вебхук = webhookRaw_();
      report.последние_события = tailRows_(10);
    } else {
      report.подсказка = 'полный отчёт: добавьте к адресу ?k=<WEBHOOK_SECRET>';
    }
  } catch (err) {
    report.ошибка = errText_(err);
  }
  return ContentService.createTextOutput(JSON.stringify(report, null, 2))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Секрет передаётся в query-строке вебхука: заголовки в Apps Script не видны.
 * Возвращает причину отказа, а не просто false: молчаливый отказ по секрету —
 * это бот, который «не реагирует на /start» без единого следа.
 */
function checkSecret_(e) {
  var sp = PropertiesService.getScriptProperties();
  var expected = sp.getProperty('WEBHOOK_SECRET');
  if (!expected) return { ok: true, reason: '' };
  if (sp.getProperty('ENFORCE_SECRET') === 'off') return { ok: true, reason: '' };

  var got = (e && e.parameter) ? e.parameter.s : undefined;
  if (got === expected) return { ok: true, reason: '' };

  return {
    ok: false,
    reason: got === undefined
      ? 'в запросе нет параметра s — вебхук поставлен без секрета. Выполните resetBot(), ' +
        'либо отключите проверку: свойство ENFORCE_SECRET = off'
      : 'параметр s не совпадает с WEBHOOK_SECRET — вебхук поставлен со старым секретом, выполните resetBot()'
  };
}

// ============ ЭТАП 1: ПЛАН (под блокировкой) ============

function planUpdate_(update) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_MS)) {
    console.warn('не дождались блокировки, update ' + update.update_id);
    return null;
  }
  try {
    var cache = CacheService.getScriptCache();
    var key = 'u' + update.update_id;
    if (cache.get(key)) return null;          // повторная доставка
    cache.put(key, '1', STATE_TTL);

    if (update.message && update.message.text) return planMessage_(update.message);
    if (update.callback_query) return planCallback_(update.callback_query);
    return null;
  } finally {
    lock.releaseLock();
  }
}

function planMessage_(msg) {
  var chatId = msg.chat.id;
  var text = (msg.text || '').trim();

  if (text.indexOf('/diag') === 0) {
    return { kind: 'diag', chatId: chatId };
  }

  if (text.indexOf('/start') !== 0) {
    return { kind: 'text', chatId: chatId, text: 'Чтобы пройти тест, нажмите /start' };
  }

  var parts = text.split(' ');
  var source = parts.length > 1 ? parts[1] : 'прямой';
  var state = getState(chatId);

  // Возобновление теперь покрывает и нулевой шаг: /start больше не плодит строк.
  if (state && state.step >= 0 && state.step < QUESTIONS.length) {
    return {
      kind: 'ask', chatId: chatId, step: state.step,
      prefix: 'Продолжаем с того места, где вы остановились.\n\n'
    };
  }

  setState(chatId, { step: 0, answers: [], src: source });
  return {
    kind: 'start', chatId: chatId, step: 0, prefix: WELCOME,
    from: msg.from || {}, source: source
  };
}

function planCallback_(cq) {
  var chatId = cq.message.chat.id;
  var parts = String(cq.data).split(':');
  var step = parseInt(parts[0], 10);
  var choice = parseInt(parts[1], 10);

  var base = { chatId: chatId, cbId: cq.id, messageId: cq.message.message_id };
  var state = getState(chatId);

  if (!state) {
    return Object.assign(base, { kind: 'lost' });
  }
  if (isNaN(step) || isNaN(choice) || step !== state.step ||
      !QUESTIONS[step] || !QUESTIONS[step].options[choice]) {
    return Object.assign(base, { kind: 'stale' });
  }

  var answers = (state.answers || []).slice();
  answers[step] = choice;
  var next = step + 1;
  setState(chatId, { step: next, answers: answers, src: state.src });

  return Object.assign(base, {
    kind: next < QUESTIONS.length ? 'answer' : 'final',
    step: step, choice: choice, next: next, answers: answers, src: state.src
  });
}

// ============ ЭТАП 2: ИСПОЛНЕНИЕ (сеть и таблица) ============

function runPlan_(plan) {
  switch (plan.kind) {
    case 'text':
      send(plan.chatId, plan.text);
      return;

    case 'start':
      // Сначала человеку — вопрос, потом таблице — строка. Номер строки
      // хранится отдельно от состояния диалога, поэтому эта запись уже
      // не может откатить шаг, как в версии 3.
      askQuestion(plan.chatId, plan.step, plan.prefix);
      ensureRow_(plan.chatId, plan.from, plan.source, true);
      return;

    case 'ask':
      askQuestion(plan.chatId, plan.step, plan.prefix);
      return;

    case 'diag':
      send(plan.chatId, diagText_(plan.chatId));
      return;

    case 'lost':
      tgAsync([['answerCallbackQuery', { callback_query_id: plan.cbId }]]);
      send(plan.chatId, 'Кажется, тест сбросился. Нажмите /start, чтобы начать заново.');
      return;

    case 'stale':
      tgAsync([['answerCallbackQuery', { callback_query_id: plan.cbId }]]);
      return;

    case 'answer':
      acknowledge_(plan);
      // Если следующий вопрос не ушёл, шаг откатывается: иначе диалог
      // остаётся без вопроса и без живой клавиатуры, то есть замирает.
      if (!askQuestion(plan.chatId, plan.next)) {
        rollback_(plan);
        return;
      }
      writeAnswer_(plan.chatId, plan.step, QUESTIONS[plan.step].options[plan.choice]);
      return;

    case 'final':
      acknowledge_(plan);
      finish_(plan);
      return;
  }
}

/** Гасим «часики» на кнопке и снимаем клавиатуру — одним запросом к Bot API. */
function acknowledge_(plan) {
  var q = QUESTIONS[plan.step];
  tgAsync([
    ['answerCallbackQuery', { callback_query_id: plan.cbId }],
    ['editMessageText', {
      chat_id: String(plan.chatId),
      message_id: plan.messageId,
      text: q.text + '\n\n➡️ ' + q.options[plan.choice],
      parse_mode: 'HTML'
    }]
  ]);
}

function rollback_(plan) {
  console.error('вопрос ' + (plan.next + 1) + ' не отправлен, шаг откатан на ' + plan.step);
  var lock = LockService.getScriptLock();
  if (lock.tryLock(LOCK_MS)) {
    try {
      var answers = (plan.answers || []).slice();
      answers[plan.step] = undefined;
      setState(plan.chatId, { step: plan.step, answers: answers, src: plan.src });
    } finally {
      lock.releaseLock();
    }
  }
  send(plan.chatId, 'Связь подвела, вопрос не дошёл. Нажмите /start — продолжим с этого места.');
}

// ============ ОТПРАВКА ВОПРОСА ============

/** Возвращает true, если Telegram принял сообщение. */
function askQuestion(chatId, step, prefix) {
  var q = QUESTIONS[step];
  var keyboard = q.options.map(function (opt, i) {
    return [{ text: opt, callback_data: step + ':' + i }];
  });
  return send(chatId, (prefix || '') + q.text, { inline_keyboard: keyboard });
}

// ============ РАБОТА С ТАБЛИЦЕЙ ============

/**
 * Одна строка на chat_id. Номер строки живёт в свойствах скрипта: он должен
 * переживать вытеснение кэша, иначе у человека появится вторая строка.
 *
 * Блокировки здесь намеренно нет: она держалась бы всё время записи в лист,
 * а нажатие кнопки, пришедшее в этот момент, не дождалось бы своей очереди —
 * ровно та заморозка, от которой избавляемся. Два одновременных /start от
 * одного человека невозможны и без блокировки: второй увидит уже созданное
 * состояние диалога и пойдёт по ветке возобновления.
 */
function ensureRow_(chatId, from, source, resetAnswers) {
  try {
    var sp = PropertiesService.getScriptProperties();
    var sheet = getSheet();
    var row = parseInt(sp.getProperty('r' + chatId), 10) || 0;

    if (!(row >= 2 && row <= sheet.getLastRow() &&
          String(sheet.getRange(row, 2).getValue()) === String(chatId))) {
      row = findRow_(sheet, chatId);
    }

    var username = from && from.username ? '@' + from.username : '';
    var name = from ? [from.first_name, from.last_name].filter(String).join(' ') : '';

    if (!row) {
      sheet.appendRow([
        new Date(), String(chatId), username, name, source,
        '', '', '', '', '', '', '', 'начал', '', ''
      ]);
      // Не getLastRow(): если в этот момент добавилась строка другого
      // пользователя, getLastRow() вернёт чужой номер. Ищем по chat_id.
      row = findRow_(sheet, chatId) || sheet.getLastRow();
    } else {
      sheet.getRange(row, 1, 1, 5).setValues([[new Date(), String(chatId), username, name, source]]);
      if (resetAnswers) {
        // Столбцы F..N. «Купил» (O) не трогаем: история оплат важнее.
        sheet.getRange(row, COL_FIRST_ANSWER, 1, 9)
             .setValues([['', '', '', '', '', '', '', 'начал', '']]);
      }
    }
    sp.setProperty('r' + chatId, String(row));
    return row;
  } catch (err) {
    console.error(err);
    return 0;
  }
}

function rowOf_(chatId) {
  var sp = PropertiesService.getScriptProperties();
  var row = parseInt(sp.getProperty('r' + chatId), 10) || 0;
  if (row >= 2) return row;
  var found = findRow_(getSheet(), chatId);
  if (found) sp.setProperty('r' + chatId, String(found));
  return found;
}

function findRow_(sheet, chatId) {
  var last = sheet.getLastRow();
  if (last < 2) return 0;
  var ids = sheet.getRange(2, 2, last - 1, 1).getValues();
  for (var i = ids.length - 1; i >= 0; i--) {   // свежие строки ближе к концу
    if (String(ids[i][0]) === String(chatId)) return i + 2;
  }
  return 0;
}

function writeAnswer_(chatId, step, value) {
  try {
    var row = rowOf_(chatId);
    if (!row) return;
    getSheet().getRange(row, COL_FIRST_ANSWER + step).setValue(value);
  } catch (err) {
    console.error(err);
  }
}

// ============ РЕЗУЛЬТАТ ============

function finish_(plan) {
  var res = buildResult(plan.answers);
  send(plan.chatId, res.text);
  clearState(plan.chatId);

  try {
    var row = rowOf_(plan.chatId);
    if (!row) row = ensureRow_(plan.chatId, {}, plan.src || 'восстановлено', false);
    if (!row) return;

    // Пишем все пять ответов, а не только последний: если какая-то запись по
    // ходу теста не прошла, здесь она восстановится.
    var values = QUESTIONS.map(function (q, i) {
      var choice = plan.answers[i];
      return (choice === undefined || choice === null) ? '' : q.options[choice];
    });
    var sheet = getSheet();
    sheet.getRange(row, COL_FIRST_ANSWER, 1, 5).setValues([values]);
    sheet.getRange(row, 11, 1, 4).setValues([[res.segment, res.zone, 'завершил', new Date()]]);
  } catch (err) {
    console.error(err);
  }
}

function buildResult(a) {
  var segment = ['Пользователь', 'Контролёр', 'Смешанный', 'Новичок'][a[1]] || '';

  // младшая школа — отдельная ветка: Минпросвещения ИИ в 1–4 классах не рекомендует
  if (a[0] === 0) {
    return {
      segment: segment,
      zone: 'Младшая школа',
      text:
        '<b>Ваш случай: младшая школа</b>\n\n' +
        'Рекомендации Минпросвещения от 12 сентября 2026 года прямо говорят: ' +
        'в 1–4 классах нейросети в учебной работе не используются. Это не про запрет дома — ' +
        'это про то, что базовые навыки сейчас важнее скорости.\n\n' +
        '<b>Что делать сегодня:</b> если ИИ в доме уже есть, пусть он работает на вас, а не на ребёнка. ' +
        'Например, вы просите объяснить тему своими словами — и объясняете ребёнку сами.\n\n' +
        'В ближайшие дни пришлю разбор: где именно нейросети врут в школьных заданиях ' +
        'и как это проверить за 30 секунд. Пригодится через год-два, а с этим лучше не опаздывать.'
    };
  }

  var zone, head;
  if (a[2] === 1) {
    zone = 'Зелёная';
    head =
      '<b>Зелёная зона</b>\n\nВы уже делаете главное: просите ребёнка объяснить ответ своими словами. ' +
      'Это самая надёжная проверка из существующих — она ловит и ошибку нейросети, и то, что ребёнок ничего не понял.';
  } else if (a[2] === 0) {
    zone = 'Жёлтая';
    head =
      '<b>Жёлтая зона</b>\n\nВы проверяете ответы — это больше, чем делает большинство. ' +
      'Но проверяете вы, а не ребёнок. Значит, навык остаётся у вас, а у него не появляется.';
  } else {
    zone = 'Красная';
    head =
      '<b>Красная зона</b>\n\nОтвет нейросети уходит в тетрадь непроверенным. ' +
      'Дело не в лени — складный текст выглядит убедительно, и это ровно то, ' +
      'на чём ошибаются все, включая взрослых.';
  }

  var mid = {
    0: '\n\nВы пользуетесь нейросетью сами — значит, у вас уже есть опыт, которого нет у ребёнка. ' +
       'Его и стоит передать: не ответ, а способ проверки.',
    1: '\n\nРебёнок пользуется сам. Спорить с этим бесполезно — это новые ГДЗ. ' +
       'Вопрос не в том, пользуется или нет, а в том, умеет ли он отличать верный ответ от складного.',
    2: '\n\nПользуетесь оба — это лучший расклад. Есть общая тема для разговора, ' +
       'и проверять можно вместе, а не в режиме контроля.',
    3: '\n\nПока никто не пользуется. Это ненадолго: за год доля школьников, ' +
       'делающих домашку с ИИ, выросла с 26% до 60%. Лучше разобраться до того, как это начнётся.'
  }[a[1]] || '';

  var tail =
    '\n\n<b>Приём на сегодняшний вечер.</b> Возьмите любое готовое задание и задайте ребёнку один вопрос: ' +
    '«объясни, почему здесь так». Если объяснить не получается — задание сделано не им, ' +
    'и неважно, списал он у нейросети или у соседа.\n\n' +
    'В ближайшие дни пришлю каталог реальных ошибок нейросетей по школьным предметам — ' +
    'с разбором, как их ловить.';

  return { segment: segment, zone: zone, text: head + mid + tail };
}

// ============ ОБСЛУЖИВАНИЕ ============

/** ПОЛНЫЙ СБРОС. Запускать вручную, когда бот «залип». Токен не трогает. */
function resetBot() {
  var sp = PropertiesService.getScriptProperties();
  if (!sp.getProperty('WEBHOOK_SECRET')) {
    sp.setProperty('WEBHOOK_SECRET', Utilities.getUuid().replace(/-/g, ''));
  }
  var secret = sp.getProperty('WEBHOOK_SECRET');
  var base = sp.getProperty('WEBAPP_URL') || WEBAPP_URL;

  console.log('1) удаление старого вебхука: ' + tg('deleteWebhook', { drop_pending_updates: true }));
  Utilities.sleep(2000);

  var setBody = tg('setWebhook', {
    url: base + '?s=' + encodeURIComponent(secret),
    allowed_updates: JSON.stringify(['message', 'callback_query']),
    drop_pending_updates: true
  });
  var setRes = jsonOf_(setBody);
  if (setRes && setRes.ok) {
    console.log('2) вебхук установлен на ' + base);
  } else {
    console.log('2) ВЕБХУК НЕ УСТАНОВЛЕН: ' + descriptionOf_(setRes));
    console.log('   Частые причины:');
    console.log('   — развёртывание не типа «Веб-приложение» или доступ не «Все»;');
    console.log('   — адрес WEBAPP_URL не существует: возьмите актуальный в «Управление развёртываниями»');
    console.log('     и положите его в свойство WEBAPP_URL;');
    console.log('   — недействительный TOKEN.');
    console.log('   Пока вебхук не установлен, бот молчит на всё, включая /start.');
  }

  console.log('3) состояние вебхука: ' + tg('getWebhookInfo', {}));
  console.log('Триггеров в проекте: ' + ScriptApp.getProjectTriggers().length +
              ' (должно быть 0: триггер с getUpdates рядом с вебхуком даёт дубли)');

  console.log('Версия кода в редакторе: ' + CODE_VERSION);
  var live = liveVersion_(base);
  if (live.version === CODE_VERSION) {
    console.log('Развёрнутая версия совпадает — код обновлён.');
  } else {
    console.log('ВНИМАНИЕ: по адресу вебхука отвечает версия «' + (live.version || 'неизвестна') +
                '», а в редакторе ' + CODE_VERSION + '.');
    console.log('Сделайте: Развернуть → Управление развёртываниями → карандаш → Версия: Новая → Развернуть,');
    console.log('затем выполните resetBot() снова. Иначе Telegram продолжит вызывать старый код.');
  }
  console.log('Подробная проверка: функция checkHealth');
}

/** Диагностика. pending_update_count > 0 и last_error_message — очередь повторов. */
function webhookInfo() {
  var info = tg('getWebhookInfo', {});
  console.log(info);
  return info;
}

/** Сбрасывает зависшие диалоги. Таблицу не трогает. */
function resetStuckDialogs() {
  var sp = PropertiesService.getScriptProperties();
  var rows = sp.getProperties();
  var n = 0;
  Object.keys(rows).forEach(function (k) {
    if (k.indexOf('r') === 0 && /^r\d+$/.test(k)) {
      clearState(k.substring(1));
      n++;
    }
  });
  console.log('Сброшено диалогов: ' + n + '. Каждый продолжится с /start.');
  return n;
}

/** Удаляет все строки ответов, шапку оставляет. */
function очиститьТаблицу() {
  var sheet = getSheet();
  var last = sheet.getLastRow();
  if (last > 1) sheet.deleteRows(2, last - 1);

  // Обязательно: иначе сохранённые номера строк указывают в пустоту и
  // следующие ответы лягут не туда.
  var sp = PropertiesService.getScriptProperties();
  Object.keys(sp.getProperties()).forEach(function (k) {
    if (/^r\d+$/.test(k)) {
      clearState(k.substring(1));
      sp.deleteProperty(k);
    }
  });
  console.log('Удалено строк: ' + (last - 1) + ', номера строк и состояния сброшены');
}

/**
 * Склеивает дубли строк по chat_id, оставляя по одной на человека.
 * Сначала посмотрите отчёт: dedupeSheet(). Затем примените: dedupeSheet(true).
 */
function dedupeSheet(apply) {
  var sheet = getSheet();
  var last = sheet.getLastRow();
  if (last < 3) { console.log('дублей нет'); return { duplicates: 0 }; }

  var width = 15;
  var values = sheet.getRange(2, 1, last - 1, width).getValues();
  var keepAt = {}, order = [], toDelete = [];

  values.forEach(function (rowValues, i) {
    var chatId = String(rowValues[1]).trim();
    if (!chatId) return;
    if (!(chatId in keepAt)) { keepAt[chatId] = i; order.push(chatId); return; }
    var keep = values[keepAt[chatId]];
    for (var c = 0; c < width; c++) {
      if (c === 0) continue;                                    // дата старта — самая ранняя
      if (rowValues[c] !== '' && rowValues[c] !== null) keep[c] = rowValues[c];
    }
    toDelete.push(i + 2);
  });

  var report = { rowsBefore: last - 1, uniqueChats: order.length, duplicates: toDelete.length, applied: !!apply };
  if (!apply) {
    console.log('Пробный прогон: ' + JSON.stringify(report) + '. Применить: dedupeSheet(true)');
    return report;
  }

  order.forEach(function (chatId) {
    var i = keepAt[chatId];
    sheet.getRange(i + 2, 1, 1, width).setValues([values[i]]);
  });
  toDelete.sort(function (a, b) { return b - a; }).forEach(function (row) { sheet.deleteRow(row); });

  // Номера строк съехали — пересобираем.
  var sp = PropertiesService.getScriptProperties();
  Object.keys(sp.getProperties()).forEach(function (k) { if (/^r\d+$/.test(k)) sp.deleteProperty(k); });
  var ids = sheet.getLastRow() > 1 ? sheet.getRange(2, 2, sheet.getLastRow() - 1, 1).getValues() : [];
  var map = {};
  ids.forEach(function (r, i) { var id = String(r[0]).trim(); if (id) map['r' + id] = String(i + 2); });
  if (Object.keys(map).length) sp.setProperties(map, false);

  console.log('Готово: ' + JSON.stringify(report));
  return report;
}

/** Разослать сообщение по сегменту. Меняйте segment и message. */
function sendBroadcast() {
  var segment = 'Контролёр';
  var message = 'Текст рассылки';

  var sheet = getSheet();
  var last = sheet.getLastRow();
  if (last < 2) { console.log('получателей нет'); return 0; }

  var rows = sheet.getRange(2, 1, last - 1, 13).getValues();
  var started = Date.now();
  var sent = 0;
  for (var i = 0; i < rows.length; i++) {
    if (Date.now() - started > 300000) {   // 5 минут: предел выполнения — 6
      console.log('Остановлено по времени на строке ' + (i + 2) + ', отправлено: ' + sent);
      return sent;
    }
    if (rows[i][10] === segment && rows[i][12] === 'завершил' && rows[i][1]) {
      send(rows[i][1], message);
      sent++;
      Utilities.sleep(120);
    }
  }
  console.log('Отправлено: ' + sent);
  return sent;
}

/** Проверка логики результата без обращения к сети и таблице. */
function selfTest() {
  var problems = [];
  for (var q1 = 0; q1 < 4; q1++) {
    for (var q2 = 0; q2 < 4; q2++) {
      for (var q3 = 0; q3 < 4; q3++) {
        var res = buildResult([q1, q2, q3, 0, 0]);
        if (!res.zone) problems.push('пустая зона при ' + [q1, q2, q3]);
        if (!res.segment) problems.push('пустой сегмент при ' + [q1, q2, q3]);
        if (!res.text || res.text.length < 100) problems.push('короткий текст при ' + [q1, q2, q3]);
      }
    }
  }
  QUESTIONS.forEach(function (q, i) {
    if (q.options.length !== 4) problems.push('в вопросе ' + (i + 1) + ' не четыре варианта');
  });
  console.log(problems.length ? 'ОШИБКИ:\n' + problems.join('\n') : 'selfTest: всё в порядке');
  return problems;
}

// ============ ДИАГНОСТИКА ============

/**
 * ГЛАВНАЯ ПРОВЕРКА. Запускать в редакторе, когда бот не отвечает.
 * Отвечает на вопрос «где именно сломалось» по порядку, от токена до листа.
 */
function checkHealth() {
  var sp = PropertiesService.getScriptProperties();
  var lines = [];
  var problems = [];
  var out = function (t) { lines.push(t); };

  out('=== ПРОВЕРКА БОТА ===');
  out('в редакторе: версия ' + CODE_VERSION + ', сборка ' + BUILD_STAMP);
  out('');

  // 1. Токен
  if (!TOKEN) {
    out('1. ТОКЕН: не задан');
    problems.push('Задайте свойство TOKEN: Настройки проекта → Свойства скрипта');
  } else {
    var me = jsonOf_(tg('getMe', {}));
    if (me && me.ok) {
      out('1. ТОКЕН: в порядке, бот @' + me.result.username);
    } else {
      out('1. ТОКЕН: отклонён Telegram — ' + descriptionOf_(me));
      problems.push('Токен недействителен. Возьмите новый у @BotFather и впишите в свойство TOKEN');
    }
  }

  // 2. Какая версия реально развёрнута
  var base = sp.getProperty('WEBAPP_URL') || WEBAPP_URL;
  out('');
  out('2. РАЗВЁРНУТАЯ ВЕРСИЯ');
  out('   адрес: ' + base);
  var live = liveVersion_(base);
  if (live.error) {
    out('   ОШИБКА обращения к адресу: ' + live.error);
    problems.push('Адрес развёртывания недоступен. Проверьте WEBAPP_URL и что развёртывание — тип «Веб-приложение», доступ «Все»');
  } else if (!live.version) {
    out('   по адресу отвечает код, который не умеет отдавать отчёт');
    out('   ответ: ' + String(live.body).slice(0, 120));
    problems.push('РАЗВЁРНУТА СТАРАЯ ВЕРСИЯ. Развернуть → Управление развёртываниями → карандаш → Версия: Новая');
  } else if (live.version !== CODE_VERSION) {
    out('   развёрнута ' + live.version + ', в редакторе ' + CODE_VERSION);
    problems.push('РАЗВЁРНУТА СТАРАЯ ВЕРСИЯ. Развернуть → Управление развёртываниями → карандаш → Версия: Новая');
  } else if (live.stamp && live.stamp !== BUILD_STAMP) {
    out('   версия совпадает, но сборка другая');
    out('   развёрнута сборка: ' + live.stamp);
    out('   в редакторе:       ' + BUILD_STAMP);
    problems.push('РАЗВЁРНУТ ДРУГОЙ КОД той же версии. Сделайте новое развёртывание ' +
                  '(или npm run deploy, если настроено автоматическое развёртывание)');
  } else {
    out('   развёрнута версия ' + live.version + ', сборка ' + (live.stamp || BUILD_STAMP) +
        ' — совпадает с редактором');
  }

  // 3. Вебхук
  out('');
  out('3. ВЕБХУК');
  var info = jsonOf_(tg('getWebhookInfo', {}));
  if (!info || !info.ok) {
    out('   не удалось получить: ' + descriptionOf_(info));
    problems.push('Выполните resetBot()');
  } else {
    var w = info.result;
    out('   url: ' + (w.url || '(пусто)'));
    out('   в очереди недоставленных: ' + (w.pending_update_count || 0));
    if (w.last_error_message) {
      out('   ПОСЛЕДНЯЯ ОШИБКА ДОСТАВКИ: ' + w.last_error_message +
          ' (' + tsText_(w.last_error_date) + ')');
      problems.push('Telegram не может доставить обновления: ' + w.last_error_message);
    } else {
      out('   ошибок доставки нет');
    }

    if (!w.url) {
      problems.push('Вебхук не установлен. Выполните resetBot()');
    } else {
      if (w.url.indexOf(base) !== 0) {
        out('   ВНИМАНИЕ: вебхук указывает не на текущий адрес развёртывания');
        problems.push('Вебхук указывает на другое развёртывание — это значит старый код. Выполните resetBot()');
      }
      var secret = sp.getProperty('WEBHOOK_SECRET');
      var enforced = sp.getProperty('ENFORCE_SECRET') !== 'off';
      if (secret && enforced) {
        if (w.url.indexOf('s=' + secret) === -1) {
          out('   ВНИМАНИЕ: в адресе вебхука нет текущего секрета');
          problems.push('ВСЕ ОБНОВЛЕНИЯ ОТБРАСЫВАЮТСЯ ПО СЕКРЕТУ. Выполните resetBot(), ' +
                        'либо задайте свойство ENFORCE_SECRET = off');
        } else {
          out('   секрет в адресе совпадает');
        }
      } else {
        out('   проверка секрета выключена' + (secret ? ' (ENFORCE_SECRET = off)' : ' (секрет не задан)'));
      }
    }
    if ((w.pending_update_count || 0) > 0) {
      problems.push('В очереди ' + w.pending_update_count + ' недоставленных обновлений — ' +
                    'обработчик их не подтверждает. Выполните resetBot() (очередь сбрасывается)');
    }
  }

  // 4. Триггеры
  out('');
  var triggers = ScriptApp.getProjectTriggers();
  out('4. ТРИГГЕРЫ: ' + triggers.length);
  if (triggers.length) {
    triggers.forEach(function (t) { out('   ' + t.getHandlerFunction() + ' / ' + t.getEventType()); });
    problems.push('Триггеры при работе по вебхуку не нужны: триггер с getUpdates обрабатывает обновления вторично');
  }

  // 5. Таблица
  out('');
  out('5. ТАБЛИЦА');
  try {
    var sheet = getSheet();
    out('   лист «' + SHEET_NAME + '»: строк с ответами ' + Math.max(sheet.getLastRow() - 1, 0));
    var head = sheet.getRange(1, 1, 1, 15).getValues()[0];
    if (String(head[1]).trim() !== 'chat_id') {
      problems.push('Шапка листа «' + SHEET_NAME + '» не на месте: во втором столбце ожидается chat_id');
    }
    out('   лист «' + LOG_SHEET_NAME + '»: записей ' + Math.max(logSheet_().getLastRow() - 1, 0));
  } catch (err) {
    out('   ОШИБКА: ' + errText_(err));
    problems.push('Не удалось открыть таблицу: ' + errText_(err));
  }
  out('   уровень журнала: ' + logLevel_() + ' (setLogLevel: all | errors | off)');
  out('   уведомления об ошибках в Telegram: ' + alertsState_());
  if (!sp.getProperty('ADMIN_CHAT_ID')) {
    problems.push('Уведомления об ошибках выключены. Задайте свойство ADMIN_CHAT_ID — ' +
                  'свой chat_id покажет команда /diag в боте, и сбои будут приходить вам в Telegram');
  }

  // 6. Последние события
  out('');
  out('6. ПОСЛЕДНИЕ СОБЫТИЯ В ЖУРНАЛЕ');
  var tail = tailRows_(8);
  if (!tail.length) {
    out('   журнал пуст: ни одно обновление до кода не дошло');
    problems.push('Журнал пуст. Значит Telegram вообще не вызывает скрипт: причина в развёртывании или вебхуке, ' +
                  'а не в логике бота');
  } else {
    tail.forEach(function (r) { out('   ' + r); });
  }

  // Итог
  out('');
  out('=== ИТОГ ===');
  if (!problems.length) {
    out('Проблем не найдено. Если бот всё равно молчит — нажмите /start и снова посмотрите журнал.');
  } else {
    problems.forEach(function (p, i) { out((i + 1) + ') ' + p); });
  }

  var text = lines.join('\n');
  console.log(text);
  return text;
}

function alertsState_() {
  var sp = PropertiesService.getScriptProperties();
  if (sp.getProperty('ALERTS') === 'off') return 'выключены (ALERTS = off)';
  var admin = sp.getProperty('ADMIN_CHAT_ID');
  return admin ? 'приходят в чат ' + admin : 'не настроены (нет ADMIN_CHAT_ID)';
}

/** Включает уведомления об ошибках в указанный чат. */
function включитьУведомления(chatId) {
  var sp = PropertiesService.getScriptProperties();
  var target = chatId || sp.getProperty('ADMIN_CHAT_ID') || lastChatId_();
  if (!target) {
    console.log('Не знаю, куда отправлять. Напишите боту /diag — он покажет ваш chat_id, ' +
                'затем вызовите включитьУведомления(<chat_id>)');
    return false;
  }
  sp.setProperty('ADMIN_CHAT_ID', String(target));
  sp.deleteProperty('ALERTS');
  console.log('Уведомления об ошибках будут приходить в чат ' + target);
  return ping();
}

/** Русский псевдоним checkHealth — чтобы функция находилась в списке редактора. */
function проверка() {
  return checkHealth();
}

/** Запрашивает у развёрнутого адреса его версию: так видно, обновлено ли развёртывание. */
function liveVersion_(base) {
  try {
    var res = UrlFetchApp.fetch(base, { muteHttpExceptions: true, followRedirects: true });
    var body = res.getContentText();
    var parsed = null;
    try { parsed = JSON.parse(body); } catch (err) { parsed = null; }
    return {
      version: parsed ? parsed['версия_кода'] : '',
      stamp: parsed ? parsed['отметка_сборки'] : '',
      body: body,
      error: ''
    };
  } catch (err) {
    return { version: '', stamp: '', body: '', error: errText_(err) };
  }
}

/** Отправляет проверочное сообщение: проверяет путь «скрипт → Telegram». */
function ping() {
  var chatId = PropertiesService.getScriptProperties().getProperty('ADMIN_CHAT_ID') || lastChatId_();
  if (!chatId) {
    console.log('Некому отправлять: задайте свойство ADMIN_CHAT_ID (ваш chat_id покажет команда /diag в боте)');
    return false;
  }
  var okSent = send(chatId, 'Проверка связи. Версия кода ' + CODE_VERSION + ', ' + nowText_());
  console.log(okSent ? 'Отправлено в чат ' + chatId : 'НЕ отправлено: ' + _lastApiError);
  return okSent;
}

/** Последние записи журнала в консоль. */
function tailLog(n) {
  var rows = tailRows_(n || 20);
  console.log(rows.length ? rows.join('\n') : 'журнал пуст');
  return rows;
}

/** all — писать всё, errors — только сбои, off — не писать. */
function setLogLevel(level) {
  var allowed = ['all', 'errors', 'off'];
  if (allowed.indexOf(level) === -1) {
    console.log('Допустимо: ' + allowed.join(', '));
    return;
  }
  PropertiesService.getScriptProperties().setProperty('LOG_LEVEL', level);
  console.log('Уровень журнала: ' + level);
}

/** Очищает журнал, оставляя шапку. */
function очиститьЖурнал() {
  var sheet = logSheet_();
  var last = sheet.getLastRow();
  if (last > 1) sheet.deleteRows(2, last - 1);
  console.log('Журнал очищен, удалено записей: ' + Math.max(last - 1, 0));
}

// ============ ЖУРНАЛ ============

function logLevel_() {
  return PropertiesService.getScriptProperties().getProperty('LOG_LEVEL') || 'all';
}

function isFailure_(outcome) {
  return /^(ОШИБКА|ИСКЛЮЧЕНИЕ|ОТБРОШЕН|БИТЫЙ|ПУСТОЙ)/.test(outcome);
}

/**
 * Пишет одну строку в журнал и при сбое присылает уведомление в Telegram.
 * Сам никогда не бросает исключений: он вызывается в том числе из catch
 * в doPost, и исключение отсюда ушло бы наружу как ответ 500 — то есть
 * запустило бы поток повторных доставок.
 */
function logUpdate_(ctx, outcome, t0, details) {
  try {
    var ms = Date.now() - t0;
    details = [ctx.plan ? 'план: ' + ctx.plan : '', details || '']
      .filter(function (x) { return x; }).join(' | ');

    var line = outcome + ' | update ' + (ctx.updateId || '-') +
               ' | chat ' + (ctx.chatId || '-') +
               ' | ' + (ctx.event || '-') +
               (ctx.step === '' || ctx.step === undefined ? '' : ' | шаг ' + ctx.step) +
               ' | ' + ms + ' мс' + (details ? ' | ' + details : '');
    var failed = isFailure_(outcome);
    if (failed) console.error(line); else console.log(line);

    var level = logLevel_();
    if (level !== 'off' && !(level === 'errors' && !failed)) {
      try {
        var sheet = logSheet_();
        sheet.appendRow([
          nowText_(), outcome, ctx.updateId, String(ctx.chatId || ''),
          ctx.event, ctx.step, ms, String(details || '').slice(0, 900), CODE_VERSION
        ]);
        var last = sheet.getLastRow();
        if (last > LOG_KEEP_ROWS + 500) sheet.deleteRows(2, last - LOG_KEEP_ROWS);
      } catch (err) {
        console.error('журнал недоступен: ' + errText_(err));
      }
    }

    if (failed) alertAdmin_(outcome, ctx, details);
  } catch (err) {
    console.error('сбой журналирования: ' + errText_(err));
  }
}

/**
 * Присылает сбой в Telegram администратору.
 * Не чаще одного сообщения в 10 минут на один вид ошибки, иначе поток
 * однотипных сбоев превратится в поток сообщений.
 *
 * Включается заданием свойства ADMIN_CHAT_ID (свой chat_id покажет /diag).
 * Выключается свойством ALERTS = off.
 */
function alertAdmin_(outcome, ctx, details) {
  try {
    var sp = PropertiesService.getScriptProperties();
    var admin = sp.getProperty('ADMIN_CHAT_ID');
    if (!admin || sp.getProperty('ALERTS') === 'off') return;

    var cache = CacheService.getScriptCache();
    var signature = 'al_' + String(outcome + '|' + details)
      .replace(/[^a-zA-Zа-яА-Я0-9]+/g, '').slice(0, 60);
    if (cache.get(signature)) return;
    cache.put(signature, '1', 600);

    var text = '⚠️ <b>' + outcome + '</b>\n' +
      'версия ' + CODE_VERSION + ', ' + nowText_() + '\n' +
      'chat: ' + (ctx.chatId || '-') + ', update: ' + (ctx.updateId || '-') + '\n' +
      'что пришло: ' + (ctx.event || '-') + '\n\n' +
      String(details || '').slice(0, 700) + '\n\n' +
      'Подробности — лист «' + LOG_SHEET_NAME + '», функция проверка()';

    // Напрямую, без send(): у send() свой разбор ответа и своя запись ошибок,
    // а здесь важно не уйти в круг «ошибка → уведомление → ошибка».
    tg('sendMessage', { chat_id: String(admin), text: text, parse_mode: 'HTML' });
  } catch (err) {
    console.error('не удалось отправить уведомление: ' + errText_(err));
  }
}

/** Что именно пришло — видно в журнале без раскопок в исходном JSON. */
function describeUpdate_(ctx, update) {
  if (update.message) {
    ctx.chatId = update.message.chat ? update.message.chat.id : '';
    ctx.event = 'сообщение: ' + String(update.message.text || '(без текста)').slice(0, 40);
  } else if (update.callback_query) {
    var cq = update.callback_query;
    ctx.chatId = (cq.message && cq.message.chat) ? cq.message.chat.id : (cq.from || {}).id;
    ctx.event = 'кнопка: ' + String(cq.data || '');
  } else {
    ctx.event = 'тип не поддерживается: ' + Object.keys(update).join(',');
  }
}

var _logSheet = null;
function logSheet_() {
  if (_logSheet) return _logSheet;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(LOG_HEADERS);
    sheet.setFrozenRows(1);
  }
  _logSheet = sheet;
  return sheet;
}

function tailRows_(n) {
  try {
    var sheet = logSheet_();
    var last = sheet.getLastRow();
    if (last < 2) return [];
    var from = Math.max(2, last - n + 1);
    return sheet.getRange(from, 1, last - from + 1, LOG_HEADERS.length).getValues()
      .map(function (r) {
        return [r[0], r[1], 'update ' + r[2], 'chat ' + r[3], r[4],
                r[5] === '' ? '' : 'шаг ' + r[5], r[6] + ' мс', r[7]]
          .filter(function (x) { return x !== '' && x !== null; }).join(' | ');
      });
  } catch (err) {
    return ['журнал недоступен: ' + errText_(err)];
  }
}

function lastChatId_() {
  try {
    var sheet = logSheet_();
    var last = sheet.getLastRow();
    for (var r = last; r >= 2; r--) {
      var id = String(sheet.getRange(r, 4).getValue()).trim();
      if (id) return id;
    }
  } catch (err) { /* журнал может быть недоступен */ }
  return '';
}

/** Ответ бота на /diag: доказывает, что обновление доходит до кода. */
function diagText_(chatId) {
  var state = getState(chatId);
  var row = 0;
  try { row = rowOf_(chatId); } catch (err) { row = 0; }
  return 'Диагностика\n' +
    'версия кода: ' + CODE_VERSION + '\n' +
    'сборка: ' + BUILD_STAMP + '\n' +
    'ваш chat_id: ' + chatId + '\n' +
    'шаг теста: ' + (state ? state.step : 'состояния нет') + '\n' +
    'строка в таблице: ' + (row || 'нет') + '\n' +
    'уровень журнала: ' + logLevel_() + '\n' +
    'уведомления об ошибках: ' + alertsState_() + '\n' +
    'время: ' + nowText_();
}

// ============ МЕЛКИЕ ХЕЛПЕРЫ ============

function errText_(err) {
  if (!err) return 'неизвестная ошибка';
  var text = err.stack ? String(err.stack) : String(err);
  return text.replace(/\s+/g, ' ').slice(0, 500);
}

function nowText_() {
  return Utilities.formatDate(new Date(), 'Europe/Moscow', 'dd.MM.yyyy HH:mm:ss');
}

function tsText_(unixSeconds) {
  if (!unixSeconds) return '';
  return Utilities.formatDate(new Date(unixSeconds * 1000), 'Europe/Moscow', 'dd.MM.yyyy HH:mm:ss');
}

function jsonOf_(body) {
  try { return JSON.parse(body); } catch (err) { return null; }
}

function descriptionOf_(parsed) {
  if (!parsed) return 'ответ не разобран';
  return parsed.description || JSON.stringify(parsed).slice(0, 200);
}

function webhookRaw_() {
  var parsed = jsonOf_(tg('getWebhookInfo', {}));
  if (!parsed || !parsed.ok) return { ошибка: descriptionOf_(parsed) };
  var w = parsed.result;
  return {
    установлен: !!w.url,
    в_очереди: w.pending_update_count || 0,
    последняя_ошибка: w.last_error_message || '',
    когда: tsText_(w.last_error_date)
  };
}

// ============ СЛУЖЕБНОЕ ============

var _sheet = null;
function getSheet() {
  if (_sheet) return _sheet;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow([
      'Дата старта', 'chat_id', 'username', 'Имя', 'Источник',
      'Класс', 'Кто пользуется', 'Проверка', 'Тревога', 'Ошибки',
      'Сегмент', 'Зона', 'Статус', 'Дата финиша', 'Купил'
    ]);
    sheet.setFrozenRows(1);
  }
  _sheet = sheet;
  return sheet;
}

// Состояние диалога живёт в кэше 6 часов. Номер строки хранится отдельно,
// в свойствах скрипта, и состоянием не перезаписывается.
function getState(chatId) {
  var raw = CacheService.getScriptCache().get('st' + chatId);
  return raw ? JSON.parse(raw) : null;
}

function setState(chatId, state) {
  CacheService.getScriptCache().put('st' + chatId, JSON.stringify(state), STATE_TTL);
}

function clearState(chatId) {
  CacheService.getScriptCache().remove('st' + chatId);
}

function send(chatId, text, keyboard) {
  var payload = { chat_id: String(chatId), text: text, parse_mode: 'HTML' };
  if (keyboard) payload.reply_markup = JSON.stringify(keyboard);
  try {
    var body = tg('sendMessage', payload);
    return noteApiResult_('sendMessage', body);
  } catch (err) {
    noteApiError_('sendMessage: ' + errText_(err));
    return false;
  }
}

/** Один запрос к Telegram. */
function tg(method, payload) {
  if (!TOKEN) {
    var text = 'свойство TOKEN не задано, запрос ' + method + ' не отправлен';
    noteApiError_(text);
    return JSON.stringify({ ok: false, description: text });
  }
  return UrlFetchApp.fetch(API + TOKEN + '/' + method, {
    method: 'post',
    payload: payload,
    muteHttpExceptions: true
  }).getContentText();
}

/**
 * Несколько запросов разом, параллельно. calls: [['метод', {данные}], ...]
 * Ответы обязательно разбираются: отказ answerCallbackQuery или
 * editMessageText раньше не был виден нигде.
 */
function tgAsync(calls) {
  if (!TOKEN) {
    noteApiError_('свойство TOKEN не задано, запросы не отправлены');
    return;
  }
  var requests = calls.map(function (c) {
    return {
      url: API + TOKEN + '/' + c[0],
      method: 'post',
      payload: c[1],
      muteHttpExceptions: true
    };
  });
  try {
    var responses = UrlFetchApp.fetchAll(requests);
    responses.forEach(function (res, i) {
      noteApiResult_(calls[i][0], res.getContentText());
    });
  } catch (err) {
    noteApiError_('fetchAll: ' + errText_(err));
  }
}

/** true, если Telegram принял запрос. Отказ запоминается для журнала. */
function noteApiResult_(method, body) {
  if (String(body).indexOf('\"ok\":true') !== -1) return true;
  var parsed = jsonOf_(body);
  noteApiError_(method + ' отклонён: ' + (parsed ? descriptionOf_(parsed) : String(body).slice(0, 200)));
  return false;
}

function noteApiError_(text) {
  _lastApiError = _lastApiError ? _lastApiError + '; ' + text : text;
  console.error(text);
}

/*
====================== ПОРЯДОК ЗАПУСКА ======================

1. Ctrl+A в редакторе, вставить этот файл целиком поверх старого. Сохранить.
2. Развернуть → Управление развёртываниями → карандаш → Версия: Новая → Развернуть.
   БЕЗ ЭТОГО ШАГА БОТ ОСТАЁТСЯ НА СТАРОМ КОДЕ.
3. Выбрать функцию resetBot → Выполнить. В журнале три строки с "ok":true
   и «Триггеров в проекте: 0».
4. Выбрать dedupeSheet → Выполнить. Посмотреть отчёт в журнале.
   Затем в редакторе вызвать dedupeSheet(true), чтобы склеить дубли.
5. В Telegram нажать /start и пройти тест до конца.

Токен: Настройки проекта → Свойства скрипта → ключ TOKEN.
После /revoke у BotFather меняется только там, код править не нужно.

Если развёртывание создано заново и URL изменился — положите новый URL в
свойство WEBAPP_URL и снова выполните resetBot. Константа WEBAPP_URL в коде
используется только как значение по умолчанию.
=============================================================
*/
