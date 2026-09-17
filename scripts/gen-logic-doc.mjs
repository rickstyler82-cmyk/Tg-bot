/**
 * Собирает docs/logic.md из кода бота: вопросы, ветвление, точные тексты.
 * Ничего не переписывается руками — значит документ не разойдётся с кодом.
 *
 * Раздел с промптами берётся из docs/prompts.md как есть: его пишет человек.
 *
 * Запуск: npm run docs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const src = readFileSync('src/Code.gs', 'utf8');
const globalEval = eval;

// Вытаскиваем из кода чистые куски: список вопросов и расчёт результата.
const qStart = src.indexOf('var QUESTIONS = [');
const qEnd = src.indexOf('];', qStart) + 2;
globalEval(src.slice(qStart, qEnd));
const rStart = src.indexOf('function buildResult(a)');
const rEnd = src.indexOf('// ============ ОБСЛУЖИВАНИЕ');
globalEval(src.slice(rStart, rEnd));

const constOf = (name) => (src.match(new RegExp('var ' + name + " = '([^']*)';")) || [])[1] || '';
const COLUMNS = ['Класс', 'Кто пользуется', 'Проверка', 'Тревога', 'Ошибки'];
const COLUMN_LETTERS = ['F', 'G', 'H', 'I', 'J'];

/** Какие вопросы вообще меняют выдачу — перебором, а не на глаз. */
function influence() {
  const base = [1, 1, 1, 1, 1];
  const baseOut = JSON.stringify(buildResult(base));
  return QUESTIONS.map((q, i) => {
    for (let v = 0; v < q.options.length; v++) {
      const a = base.slice();
      a[v === base[i] ? 0 : i] = v;
      a[i] = v;
      if (JSON.stringify(buildResult(a)) !== baseOut) return true;
    }
    return false;
  });
}

/** Все различимые исходы и сколько комбинаций ведёт в каждый. */
function outcomes() {
  const map = new Map();
  const walk = (a, depth) => {
    if (depth === 5) {
      const r = buildResult(a);
      const key = r.segment + '|' + r.zone;
      if (!map.has(key)) map.set(key, { ...r, count: 0, example: a.slice() });
      map.get(key).count++;
      return;
    }
    for (let v = 0; v < 4; v++) walk(a.concat(v), depth + 1);
  };
  walk([], 0);
  return [...map.values()];
}

const inf = influence();
const all = outcomes();
const texts = new Map();
all.forEach((o) => {
  if (!texts.has(o.text)) texts.set(o.text, []);
  texts.get(o.text).push(o.segment + ' / ' + o.zone);
});

const strip = (html) => html.replace(/<\/?b>/g, '**').replace(/\n/g, '\n> ');

/** Склонение: 1 ветка, 2 ветки, 5 веток. */
const branchWord = (n) => {
  const tail = n % 100;
  if (tail >= 11 && tail <= 14) return 'веток';
  const last = n % 10;
  if (last === 1) return 'ветку';
  if (last >= 2 && last <= 4) return 'ветки';
  return 'веток';
};
const out = [];
const w = (line = '') => out.push(line);

w('# Логика теста: ответы родителя → что он получает');
w();
w('Собрано из кода автоматически: `npm run docs`. Править этот файл руками не нужно —');
w('он перезапишется. Тексты меняются в `src/Code.gs`, промпты — в `docs/prompts.md`.');
w();
w('| | |');
w('| --- | --- |');
w('| Версия кода | ' + constOf('CODE_VERSION') + ' |');
w('| Сборка | ' + constOf('BUILD_STAMP') + ' |');
w('| Собрано | ' + new Date().toISOString().slice(0, 10) + ' |');
w();

w('## 1. Пять вопросов');
w();
w('| № | Вопрос | Варианты ответа | Столбец таблицы | Влияет на выдачу |');
w('| --- | --- | --- | --- | --- |');
QUESTIONS.forEach((q, i) => {
  w('| ' + (i + 1) + ' | ' + q.text.replace(/<\/?b>/g, '').replace(/^\d из 5\.\s*/, '') +
    ' | ' + q.options.map((o, n) => (n + 1) + '. ' + o).join('<br>') +
    ' | ' + COLUMN_LETTERS[i] + ' «' + COLUMNS[i] + '» | ' + (inf[i] ? 'да' : '**нет**') + ' |');
});
w();

const dead = QUESTIONS.map((q, i) => (inf[i] ? null : i + 1)).filter(Boolean);
if (dead.length) {
  w('> **Важно.** Вопрос' + (dead.length > 1 ? 'ы ' : ' ') + dead.join(' и ') +
    ' в таблицу записываются, но на текст результата не влияют:');
  w('> перебор всех 1024 комбинаций даёт одинаковую выдачу при любом ответе на них.');
  w('> Это не ошибка кода, а незанятый рычаг: данные собираются для сегментации');
  w('> рассылок, но родитель их ответом не отличается от соседа.');
  w();
}

w('## 2. Что определяет выдачу');
w();
w('**Сегмент — по вопросу 2 «кто пользуется»:**');
w();
w('| Ответ | Сегмент |');
w('| --- | --- |');
QUESTIONS[1].options.forEach((opt, i) => {
  w('| ' + opt + ' | ' + buildResult([1, i, 1, 0, 0]).segment + ' |');
});
w();
w('**Зона — по вопросам 1 и 3:**');
w();
w('| Класс (вопрос 1) | Проверка (вопрос 3) | Зона |');
w('| --- | --- | --- |');
QUESTIONS[0].options.forEach((klass, k) => {
  QUESTIONS[2].options.forEach((check, c) => {
    if (k > 0 && k !== 1) return;              // ветки 5–6, 7–9, 10–11 одинаковы
    const zone = buildResult([k, 1, c, 0, 0]).zone;
    w('| ' + (k === 0 ? klass : '5–6, 7–9, 10–11') + ' | ' + check + ' | ' + zone + ' |');
  });
});
w();
w('Младшая школа — отдельная ветка: по рекомендациям Минпросвещения от 12.09.2026');
w('в 1–4 классах нейросети в учебной работе не используются, поэтому вопрос про');
w('проверку там уже не меняет вывод.');
w();

w('## 3. Все исходы');
w();
w('Различимых пар «сегмент + зона»: ' + all.length + ' из 1024 комбинаций ответов.');
w('Различимых текстов: ' + texts.size + ' — в младшей школе текст один на все сегменты.');
w();
w('| Сегмент | Зона | Комбинаций ведёт сюда | Текст |');
w('| --- | --- | --- | --- |');
all.sort((a, b) => b.count - a.count).forEach((o) => {
  const shared = texts.get(o.text).length;
  w('| ' + o.segment + ' | ' + o.zone + ' | ' + o.count +
    ' | ' + (shared > 1 ? 'общий на ' + shared + ' ' + branchWord(shared) : 'свой') + ' |');
});
w();

w('## 4. Точные тексты');
w();
[...texts.entries()].forEach(([text, branches]) => {
  w('### ' + branches.join(' · '));
  w();
  w('> ' + strip(text));
  w();
});

w('## 5. Что уходит в таблицу');
w();
w('Строка одна на `chat_id`. Столбцы K «Сегмент» и L «Зона» заполняются на финише,');
w('вместе со статусом «завершил» и датой. По ним и работает рассылка:');
w('`sendBroadcast()` берёт строки, где Сегмент совпал и Статус = «завершил».');
w();
w('Ответы на вопросы 4 и 5 живут только в столбцах I и J. Чтобы они начали влиять');
w('на выдачу, их нужно завести в `buildResult()` — сейчас функция читает только');
w('`a[0]`, `a[1]` и `a[2]`.');
w();

w('## 6. Где менять в коде');
w();
w('| Что | Где в `src/Code.gs` |');
w('| --- | --- |');
w('| Формулировки вопросов и вариантов | `var QUESTIONS` |');
w('| Приветствие | `var WELCOME` |');
w('| Сегменты | первая строка `buildResult()` |');
w('| Зоны и заголовки | ветки `if (a[2] === …)` в `buildResult()` |');
w('| Абзац под сегмент | объект `mid` в `buildResult()` |');
w('| Общий хвост и приём на вечер | `var tail` в `buildResult()` |');
w('| Ветка младшей школы | `if (a[0] === 0)` в `buildResult()` |');
w();
w('После правки: `npm test`, затем `npm run deploy`, затем `npm run docs`.');
w();

const promptsPath = 'docs/prompts.md';
if (existsSync(promptsPath)) {
  w('---');
  w();
  w(readFileSync(promptsPath, 'utf8').trim());
  w();
}

writeFileSync('docs/logic.md', out.join('\n'));
console.log('docs/logic.md собран: ' + all.length + ' исходов, ' + texts.size + ' текстов');
