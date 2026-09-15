/**
 * Автоматическое развёртывание бота на script.google.com.
 *
 * По порядку:
 *   1. тесты — без них не разворачиваем;
 *   2. отметка сборки в код (дата + хеш коммита);
 *   3. clasp push — файлы уходят в проект Apps Script;
 *   4. новая версия и перевод на неё СУЩЕСТВУЮЩЕГО развёртывания:
 *      адрес /exec не меняется, вебхук переставлять не нужно;
 *   5. проверка — у развёрнутого адреса спрашивается его отметка сборки.
 *
 * Запуск: npm run deploy
 */
import { existsSync } from 'node:fs';
import { readEnv, buildStamp, writeStamp, run, say, die } from './lib.mjs';

if (!existsSync('.clasp.json')) {
  die('нет .clasp.json. Скопируйте .clasp.json.example и впишите scriptId\n' +
      '        (в редакторе: Настройки проекта → Идентификаторы → Идентификатор скрипта)');
}
const env = readEnv(process.env.ENV_FILE || '.env.deploy');
if (!env.DEPLOYMENT_ID) die('в .env.deploy не задан DEPLOYMENT_ID (посмотреть: npm run deployments)');
if (!env.WEBAPP_URL) die('в .env.deploy не задан WEBAPP_URL');

say('1/5 Тесты');
if (run(process.execPath, ['test/run_tests.js']) !== 0) {
  die('тесты не прошли — развёртывание отменено');
}

say('2/5 Отметка сборки');
const stamp = buildStamp();
writeStamp(stamp);
console.log('   ' + stamp);

say('3/5 Отправка кода в проект');
if (run('npx', ['clasp', 'push', '-f']) !== 0) {
  die('clasp push не удался.\n' +
      '        Проверьте вход (npm run login) и что Apps Script API включён\n' +
      '        на странице script.google.com/home/usersettings');
}

say('4/5 Новая версия и обновление развёртывания ' + env.DEPLOYMENT_ID);
if (run('npx', ['clasp', 'create-deployment', '-i', env.DEPLOYMENT_ID, '-d', stamp]) !== 0) {
  die('не удалось обновить развёртывание ' + env.DEPLOYMENT_ID + '\n' +
      '        Список развёртываний: npm run deployments');
}

say('5/5 Проверка развёрнутого кода');
if (run(process.execPath, ['scripts/verify.mjs']) !== 0) {
  die('развёрнутый код не совпал с локальным — смотрите вывод проверки выше');
}

console.log('\nГотово. Отметка сборки попала в src/Code.gs — закоммитьте её:');
console.log('   git add src/Code.gs && git commit -m "Развёрнуто ' + stamp + '"\n');
