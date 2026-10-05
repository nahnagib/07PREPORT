// Local test of the dashboard (Debt Report etc.) against powerBI_Data, READ-ONLY. Started by local-test.cmd.
//
//   local-test.cmd [admin|gceo|gcco|b2b|salesperson]      (default: admin)
//
// Starts the read-only API (backend/scripts/page_server.ts: GET only, no ETL, no schedules, no Redis) on :4500 and
// the frontend (next dev) on :3500, then opens a separate Edge window already signed in as that role and on the
// Debt Report. Sign-in uses a token signed with a random secret made for this run only (no password, nothing
// written). Close the Edge window (or press Ctrl+C here) and everything stops.
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(APP, 'backend', 'package.json'));
const jwt = require('jsonwebtoken');
const puppeteer = createRequire(path.join(APP, 'package.json'))('puppeteer-core');

// existing users holding each role (powerBI_Data app_user); no permission row is changed
const USERS = { admin: 1, gceo: 5, gcco: 9, b2b: 3, salesperson: 27 };
const role = (process.argv[2] || 'admin').toLowerCase();
if (!USERS[role]) {
  console.log(`Unknown role "${role}". Use one of: ${Object.keys(USERS).join(', ')}`);
  process.exit(1);
}
const API = 4500;
const WEB = 3500;
const BROWSER = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) =>
  fs.existsSync(p),
);
const secret = crypto.randomBytes(32).toString('hex');
const children = [];

function start(name, cmd, cwd, env) {
  const p = spawn(cmd, { cwd, env: { ...process.env, ...env }, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = fs.createWriteStream(path.join(os.tmpdir(), `07ps-local-test-${name}.log`));
  p.stdout.pipe(log);
  p.stderr.pipe(log);
  children.push(p);
  return p;
}

function stopAll() {
  for (const p of children) {
    try {
      execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  }
}

async function waitFor(url, label, seconds) {
  for (let i = 0; i < seconds; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label} did not start; see ${path.join(os.tmpdir(), `07ps-local-test-*.log`)}`);
}

function portFree(port) {
  try {
    const out = execSync(`powershell -NoProfile -Command "(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Measure-Object).Count"`)
      .toString()
      .trim();
    return out === '0';
  } catch {
    return true;
  }
}

process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});

try {
  for (const port of [API, WEB]) {
    if (!portFree(port)) throw new Error(`Port ${port} is already in use (a previous test still running?). Run local-test-stop.cmd first.`);
  }
  console.log('Starting the read-only API (powerBI_Data) ...');
  start('api', 'npx tsx --env-file=.env scripts/page_server.ts', path.join(APP, 'backend'), {
    JWT_SECRET: secret,
    PORT: String(API),
    CORS_ORIGIN: `http://localhost:${WEB},http://127.0.0.1:${WEB}`,
  });
  console.log('Starting the frontend (first start takes about a minute) ...');
  start('web', `npx next dev -p ${WEB}`, path.join(APP, 'frontend'), { NEXT_PUBLIC_API_BASE_URL: `http://127.0.0.1:${API}` });
  await waitFor(`http://127.0.0.1:${API}/auth/me`, 'The API', 90);
  await waitFor(`http://localhost:${WEB}/Dashboard/login`, 'The frontend', 240);

  const token = jwt.sign({ sub: String(USERS[role]), jti: crypto.randomUUID() }, secret, { expiresIn: '8h' });
  const browser = await puppeteer.launch({
    executablePath: BROWSER,
    headless: false,
    defaultViewport: null,
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), '07ps-local-test-browser-')),
    args: ['--no-first-run', '--no-default-browser-check', '--start-maximized'],
  });
  const [page] = await browser.pages();
  await page.goto(`http://localhost:${WEB}/Dashboard/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('ps_auth_token', t), token);
  await page.goto(`http://localhost:${WEB}/Dashboard/price/debt-report`, { waitUntil: 'domcontentloaded' });
  console.log(`\nReady: signed in as ${role}. Use the Edge window. Close it (or press Ctrl+C here) to stop everything.\n`);
  browser.on('disconnected', () => {
    console.log('Browser closed: stopping the API and the frontend ...');
    stopAll();
    process.exit(0);
  });
} catch (err) {
  console.error(`\n${err.message}\n`);
  stopAll();
  process.exit(1);
}
