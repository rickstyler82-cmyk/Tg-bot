/**
 * Проверяет, что по адресу развёртывания отвечает именно текущий код.
 *
 * Сверяется не номер версии, а отметка сборки: одна и та же версия могла
 * быть собрана из разного кода, и именно на этом ловится «я развернул,
 * а работает старое».
 *
 * Запуск: npm run verify
 */
import { readEnv, readConst, fetchReport, die } from './lib.mjs';

const env = readEnv(process.env.ENV_FILE || '.env.deploy');
if (!env.WEBAPP_URL) die('в .env.deploy не задан WEBAPP_URL');

const localVersion = readConst('CODE_VERSION');
const localStamp = readConst('BUILD_STAMP');

const url = env.WEBHOOK_SECRET
  ? env.WEBAPP_URL + '?k=' + encodeURIComponent(env.WEBHOOK_SECRET)
  : env.WEBAPP_URL;

let result;
try {
  result = await fetchReport(url);
} catch (err) {
  die('адрес ' + env.WEBAPP_URL + ' не ответил: ' + err.message);
}

if (!result.report) {
  console.log('Развёрнутый код не отдаёт отчёт о состоянии.');
  console.log('Это старая версия — разверните текущую: npm run deploy');
  console.log('Ответ адреса (' + result.status + '): ' + result.body.slice(0, 200));
  process.exit(1);
}

const r = result.report;
const problems = [];

console.log('локально:   версия ' + localVersion + ', сборка ' + localStamp);
console.log('развёрнуто: версия ' + r['версия_кода'] + ', сборка ' + r['отметка_сборки']);
if (r['версия_кода'] !== localVersion) problems.push('версии не совпадают');
if (r['отметка_сборки'] !== localStamp) problems.push('отметки сборки не совпадают — развёрнут другой код');

console.log('токен задан: ' + r['токен_задан'] + ', секрет задан: ' + r['секрет_задан']);
if (r['токен_задан'] === false) problems.push('в свойствах скрипта нет TOKEN');
console.log('строк ответов: ' + r['строк_ответов'] + ', записей журнала: ' + r['строк_журнала']);
console.log('уровень журнала: ' + r['уровень_журнала']);

const hook = r['вебхук'];
if (hook) {
  console.log('вебхук установлен: ' + hook['установлен'] + ', в очереди: ' + hook['в_очереди']);
  if (hook['последняя_ошибка']) {
    console.log('ПОСЛЕДНЯЯ ОШИБКА ДОСТАВКИ: ' + hook['последняя_ошибка'] + ' (' + hook['когда'] + ')');
    problems.push('Telegram не может доставить обновления');
  }
  if (hook['в_очереди']) problems.push('в очереди ' + hook['в_очереди'] + ' недоставленных обновлений');
  if (hook['установлен'] === false) problems.push('вебхук не установлен — выполните resetBot() в редакторе');
} else {
  console.log('вебхук: состояние не показано (укажите WEBHOOK_SECRET в .env.deploy)');
}

if (problems.length) {
  console.log('\nПРОБЛЕМЫ: ' + problems.join('; '));
  process.exit(1);
}
console.log('\nРазвёрнут текущий код.');
