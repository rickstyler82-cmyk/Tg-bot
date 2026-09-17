/** Общее для скриптов развёртывания. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export const CODE_PATH = 'src/Code.gs';

export function die(message) {
  console.error('\nОШИБКА: ' + message);
  process.exit(1);
}

export function say(message) {
  console.log('\n=== ' + message + ' ===');
}

/** Читает .env.deploy в объект. Формат простой: КЛЮЧ=значение, # — комментарий. */
export function readEnv(path = '.env.deploy') {
  if (!existsSync(path)) {
    die('нет ' + path + '. Скопируйте .env.deploy.example и заполните');
  }
  const env = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

export function readConst(name) {
  const src = readFileSync(CODE_PATH, 'utf8');
  const match = src.match(new RegExp('var ' + name + " = '([^']*)';"));
  return match ? match[1] : '';
}

export function writeStamp(stamp) {
  const src = readFileSync(CODE_PATH, 'utf8');
  const pattern = /var BUILD_STAMP = '[^']*';/;
  if (!pattern.test(src)) die('в ' + CODE_PATH + ' не найдена строка var BUILD_STAMP = ...');
  writeFileSync(CODE_PATH, src.replace(pattern, "var BUILD_STAMP = '" + stamp + "';"));
}

export function buildStamp() {
  const iso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const git = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  const sha = git.status === 0 ? git.stdout.trim() : 'без-git';
  return iso + ' ' + sha;
}

/** Запускает команду, показывая её вывод. Возвращает код возврата. */
export function run(command, args) {
  const res = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (res.error) die('не удалось запустить ' + command + ': ' + res.error.message);
  return res.status;
}

/** Скачивает отчёт по адресу развёртывания. */
export async function fetchReport(url) {
  const res = await fetch(url, { redirect: 'follow' });
  const body = await res.text();
  let report = null;
  try { report = JSON.parse(body); } catch { report = null; }
  return { report, body, status: res.status };
}
