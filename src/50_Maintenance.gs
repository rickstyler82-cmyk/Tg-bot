/** Обслуживание таблицы и офлайновая проверка логики. */

/**
 * Склеивает дубли строк по chat_id: остаётся одна строка, в неё поднимаются
 * все непустые значения из дублей (самое свежее значение побеждает).
 *
 * По умолчанию только отчёт. Чтобы действительно удалить строки:
 *   dedupeSheet(true)
 */
function dedupeSheet(apply) {
  var sheet = sheet_();
  var last = sheet.getLastRow();
  if (last < 3) { Logger.log('дублей нет'); return { duplicates: 0 }; }

  var width = CFG.HEADERS.length;
  var values = sheet.getRange(2, 1, last - 1, width).getValues();

  var keepIndexByChat = {};   // chat_id -> индекс в values
  var order = [];
  var toDelete = [];

  values.forEach(function (rowValues, i) {
    var chatId = String(rowValues[CFG.COL.chatId - 1]).trim();
    if (!chatId) return;
    if (!(chatId in keepIndexByChat)) {
      keepIndexByChat[chatId] = i;
      order.push(chatId);
      return;
    }
    var keep = values[keepIndexByChat[chatId]];
    for (var c = 0; c < width; c++) {
      if (c === CFG.COL.started - 1) continue;   // дата старта остаётся самой ранней
      if (rowValues[c] !== '' && rowValues[c] !== null) keep[c] = rowValues[c]; // свежее важнее
    }
    toDelete.push(i + 2);
  });

  var report = {
    rowsBefore: last - 1,
    uniqueChats: order.length,
    duplicates: toDelete.length,
    applied: !!apply
  };

  if (!apply) {
    Logger.log('Пробный прогон. ' + JSON.stringify(report) +
               '\nЧтобы применить: dedupeSheet(true)');
    return report;
  }

  // Сначала записываем склеенные значения, потом удаляем дубли снизу вверх.
  order.forEach(function (chatId) {
    var i = keepIndexByChat[chatId];
    sheet.getRange(i + 2, 1, 1, width).setValues([values[i]]);
  });
  toDelete.sort(function (a, b) { return b - a; })
          .forEach(function (row) { sheet.deleteRow(row); });

  rebuildRowIndex_();
  Logger.log('Готово. ' + JSON.stringify(report));
  return report;
}

/** Пересобирает кэш «chat_id → номер строки» после ручных правок таблицы. */
function rebuildRowIndex_() {
  var sheet = sheet_();
  var last = sheet.getLastRow();
  var sp = props_();
  Object.keys(sp.getProperties()).forEach(function (k) {
    if (k.indexOf('r_') === 0) sp.deleteProperty(k);
  });
  if (last < 2) return 0;
  var ids = sheet.getRange(2, CFG.COL.chatId, last - 1, 1).getValues();
  var map = {};
  ids.forEach(function (r, i) {
    var id = String(r[0]).trim();
    if (id) map['r_' + id] = String(i + 2);
  });
  sp.setProperties(map, false);
  Logger.log('индекс пересобран: ' + Object.keys(map).length + ' строк');
  return Object.keys(map).length;
}

function rebuildRowIndex() { return rebuildRowIndex_(); }

/** Сбрасывает зависшее состояние диалогов (шаги теста), строки не трогает. */
function resetAllDialogStates() {
  var sp = props_();
  var n = 0;
  Object.keys(sp.getProperties()).forEach(function (k) {
    if (k.indexOf('st_') === 0) { sp.deleteProperty(k); n++; }
  });
  Logger.log('сброшено состояний: ' + n);
  return n;
}

/** Проверка логики без обращения к Telegram и таблице. */
function selfTest() {
  var cases = [
    { a: { klass: '5–6 класс', kto: 'Ребёнок сам', proverka: 'Никак не проверяю',
           trevoga: 'Списывает, не думает сам', oshibki: 'Не знаю' },
      zone: 'красная', segment: 'Б (контролёр)' },
    { a: { klass: '7–9 класс', kto: 'Я сам(а) делаю с нейросетью', proverka: 'Читаю и проверяю сам(а)',
           trevoga: 'ИИ врёт, а мы этого не видим', oshibki: 'Да, ловили' },
      zone: 'жёлтая', segment: 'А (пользователь)' },
    { a: { klass: '10–11 класс', kto: 'Пока никто', proverka: 'Прошу ребёнка объяснить своими словами',
           trevoga: 'Ничего не беспокоит', oshibki: 'Да, ловили' },
      zone: 'зелёная', segment: 'В (на входе)' }
  ];
  var failures = [];
  cases.forEach(function (c, i) {
    var z = zoneOf_(c.a), s = segmentOf_(c.a);
    if (z !== c.zone) failures.push('кейс ' + i + ': зона ' + z + ' вместо ' + c.zone);
    if (s !== c.segment) failures.push('кейс ' + i + ': сегмент ' + s + ' вместо ' + c.segment);
    if (!resultText_(c.a, z)) failures.push('кейс ' + i + ': пустой текст результата');
  });
  QUESTIONS.forEach(function (q, i) {
    if (questionKeyboard_(i).length !== q.options.length) failures.push('клавиатура вопроса ' + i);
  });
  if (CFG.HEADERS.length !== 15) failures.push('в шапке должно быть 15 столбцов');
  Logger.log(failures.length ? 'ОШИБКИ:\n' + failures.join('\n') : 'selfTest: всё в порядке');
  return failures;
}
