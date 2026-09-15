/**
 * Проверка скриптов развёртывания без обращения к Google.
 * Поднимается локальный сервер, отдающий такой же отчёт, как развёрнутый бот.
 *
 * Запуск: node test/test_deploy_tools.mjs
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { readConst } from '../scripts/lib.mjs';

const ENV_FILE = 'test/.env.deploy.test';
const results = [];

function serve(payload, statusCode = 200) {
  const server = createServer((req, res) => {
    const withSecret = String(req.url).indexOf('k=sekret') !== -1;
    const body = typeof payload === 'string'
      ? payload
      : JSON.stringify(withSecret ? payload : omit(payload, 'вебхук'));
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
function omit(obj, key) {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}
/**
 * Запуск дочернего процесса обязательно асинхронный: spawnSync заблокировал бы
 * тот же поток, в котором работает локальный сервер, и сервер не смог бы
 * ответить — процессы встали бы насмерть.
 */
function runScript(script, envFileContents) {
  writeFileSync(ENV_FILE, envFileContents);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ENV_FILE } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

function runVerify(port, withSecret = true) {
  return runScript('scripts/verify.mjs',
    'WEBAPP_URL=http://127.0.0.1:' + port + '/exec\n' +
    (withSecret ? 'WEBHOOK_SECRET=sekret\n' : ''));
}
function check(name, fn) {
  return fn().then(
    () => results.push(['PASS', name, '']),
    (err) => results.push(['FAIL', name, err.message])
  );
}
function must(condition, message) { if (!condition) throw new Error(message); }

const version = readConst('CODE_VERSION');
const stamp = readConst('BUILD_STAMP');

const healthy = {
  'версия_кода': version,
  'отметка_сборки': stamp,
  'токен_задан': true,
  'секрет_задан': true,
  'уровень_журнала': 'all',
  'строк_ответов': 3,
  'строк_журнала': 12,
  'вебхук': { 'установлен': true, 'в_очереди': 0, 'последняя_ошибка': '', 'когда': '' }
};

await check('развёрнут текущий код — проверка проходит', async () => {
  const server = await serve(healthy);
  const { code, out } = await runVerify(server.address().port);
  server.close();
  must(code === 0, 'код возврата ' + code + ':\n' + out);
  must(/Развёрнут текущий код/.test(out), 'нет подтверждения:\n' + out);
});

await check('другая отметка сборки — проверка падает и говорит почему', async () => {
  const server = await serve({ ...healthy, 'отметка_сборки': '2026-01-01T00:00:00Z abc1234' });
  const { code, out } = await runVerify(server.address().port);
  server.close();
  must(code === 1, 'код возврата ' + code);
  must(/развёрнут другой код/.test(out), 'нет причины:\n' + out);
});

await check('старая версия без отчёта — понятное объяснение', async () => {
  const server = await serve('ok');
  const { code, out } = await runVerify(server.address().port);
  server.close();
  must(code === 1, 'код возврата ' + code);
  must(/не отдаёт отчёт/.test(out), 'нет объяснения:\n' + out);
  must(/npm run deploy/.test(out), 'нет подсказки что делать');
});

await check('очередь недоставленных и ошибка доставки видны', async () => {
  const server = await serve({
    ...healthy,
    'вебхук': {
      'установлен': true, 'в_очереди': 17,
      'последняя_ошибка': 'Wrong response from the webhook: 302 Found',
      'когда': '15.09.2026 15:00:00'
    }
  });
  const { code, out } = await runVerify(server.address().port);
  server.close();
  must(code === 1, 'код возврата ' + code);
  must(/302 Found/.test(out), 'ошибка доставки не показана:\n' + out);
  must(/17 недоставленных/.test(out), 'очередь не показана');
});

await check('вебхук не установлен — сказано, что делать', async () => {
  const server = await serve({ ...healthy, 'вебхук': { 'установлен': false, 'в_очереди': 0 } });
  const { code, out } = await runVerify(server.address().port);
  server.close();
  must(code === 1, 'код возврата ' + code);
  must(/resetBot/.test(out), 'нет подсказки:\n' + out);
});

await check('нет TOKEN — проверка не молчит', async () => {
  const server = await serve({ ...healthy, 'токен_задан': false });
  const { code, out } = await runVerify(server.address().port);
  server.close();
  must(code === 1, 'код возврата ' + code);
  must(/нет TOKEN/.test(out), 'не сказано про токен:\n' + out);
});

await check('без WEBHOOK_SECRET проверка работает, но без состояния вебхука', async () => {
  const server = await serve(healthy);
  const { code, out } = await runVerify(server.address().port, false);
  server.close();
  must(code === 0, 'код возврата ' + code + ':\n' + out);
  must(/состояние не показано/.test(out), 'нет пояснения:\n' + out);
});

await check('адрес не отвечает — понятная ошибка, а не след стека', async () => {
  const { code, out } = await runScript('scripts/verify.mjs',
    'WEBAPP_URL=http://127.0.0.1:1/exec\n');
  must(code === 1, 'код возврата ' + code);
  must(/не ответил/.test(out), 'нет понятной ошибки:\n' + out);
  must(!/at Object\./.test(out), 'в вывод попал след стека:\n' + out);
});

await check('deploy без .clasp.json объясняет, чего не хватает', async () => {
  const { code, out } = await runScript('scripts/deploy.mjs',
    'DEPLOYMENT_ID=AKfycb_test\nWEBAPP_URL=http://127.0.0.1:1/exec\n');
  must(code === 1, 'код возврата ' + code);
  must(/\.clasp\.json/.test(out), 'не назван нужный файл:\n' + out);
  must(/scriptId/.test(out), 'нет подсказки, что в него вписать');
});

await check('отметка сборки в коде не испорчена тестами', async () => {
  must(readConst('BUILD_STAMP') === stamp, 'отметка изменилась во время прогона');
  must(/var BUILD_STAMP = '[^']*';/.test(readFileSync('src/Code.gs', 'utf8')),
       'строка BUILD_STAMP не на месте');
});

try { unlinkSync(ENV_FILE); } catch { /* уже удалён */ }

const failed = results.filter((r) => r[0] === 'FAIL');
console.log('');
results.forEach(([st, name, msg]) =>
  console.log('  ' + (st === 'PASS' ? '✓' : '✗') + ' ' + name + (msg ? '\n      ' + msg : '')));
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' тестов прошли\n');
process.exit(failed.length ? 1 : 0);
