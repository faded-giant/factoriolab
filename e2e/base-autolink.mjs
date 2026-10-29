// End-to-end check of base auto-linking in the built app, driven over the
// Chrome DevTools protocol. Chrome runs headless with all non-local traffic
// sent to a dead proxy. Usage: node e2e.mjs <port-of-app-server>
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = `http://127.0.0.1:${process.argv[2]}/factoriolab`;
const DEBUG_PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), 'chrome-'));
const chrome = spawn('/usr/bin/google-chrome', [
  '--headless=new',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--no-pings',
  '--disable-domain-reliability',
  '--proxy-server=http://127.0.0.1:9',
  '--proxy-bypass-list=localhost;127.0.0.1',
  'about:blank',
]);

let ws;
let nextId = 1;
const pending = new Map();
const errors = [];

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (
        await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)
      ).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r) => ws.addEventListener('open', r));
        ws.addEventListener('message', (e) => {
          const msg = JSON.parse(e.data);
          if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
          } else if (msg.method === 'Runtime.exceptionThrown') {
            errors.push(
              msg.params.exceptionDetails.exception?.description ??
                msg.params.exceptionDetails.text,
            );
          } else if (
            msg.method === 'Runtime.consoleAPICalled' &&
            msg.params.type === 'error'
          ) {
            errors.push(
              msg.params.args.map((a) => a.value ?? a.description).join(' '),
            );
          }
        });
        return;
      }
    } catch {
      // Chrome not up yet
    }
    await sleep(200);
  }
  throw new Error('Could not connect to Chrome');
}

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.result?.exceptionDetails)
    throw new Error(res.result.exceptionDetails.exception?.description);
  return res.result?.result?.value;
}

async function go(url, wait = 6000) {
  await send('Page.navigate', { url });
  await sleep(wait);
}

let fails = 0;
const check = (label, ok, detail = '') => {
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`,
  );
  if (!ok) fails++;
};

try {
  await connect();
  await send('Runtime.enable');
  await send('Page.enable');

  // 1. A Nauvis build making superconductors, with holmium plate imported
  await go(`${APP}/spa/list?o=superconductor*60&v=12`, 8000);
  const clicked = await evaluate(`(() => {
    const label = [...document.querySelectorAll('span[aria-hidden="true"]')]
      .find((s) => s.textContent.trim() === 'Holmium plate');
    const button = label?.parentElement?.querySelector('lab-exclude-button button');
    button?.click();
    return !!button;
  })()`);
  check('found and clicked the Holmium plate exclude button', clicked);
  await sleep(2000);
  const nauvisQuery = await evaluate('location.search.substring(1)');
  check('build has a URL state', !!nauvisQuery, nauvisQuery?.slice(0, 40));

  // 2. Save it as the Nauvis tab of a base, with holmium linked to Fulgora
  await evaluate(`(() => {
    const prefs = JSON.parse(localStorage.getItem('preferences') ?? '{}');
    prefs.states = { ...prefs.states, spa: { 'T – Nauvis': ${JSON.stringify(nauvisQuery)} } };
    prefs.bases = { spa: { T: { tabs: [
      { id: 'nauvis', label: 'Nauvis', location: 'nauvis', build: 'T – Nauvis', links: { 'holmium-plate': 'fulgora' } },
      { id: 'fulgora', label: 'Fulgora', location: 'fulgora' },
      { id: 'gleba', label: 'Gleba', location: 'gleba' },
    ] } } };
    localStorage.setItem('preferences', JSON.stringify(prefs));
    localStorage.setItem('base', JSON.stringify({ modId: 'spa', name: 'T' }));
  })()`);

  // 3. Reload on an unrelated page; the base should update itself
  await go(`${APP}/spa/list?o=iron-gear-wheel*10&v=12`, 20000);
  const prefs = JSON.parse(
    await evaluate(`localStorage.getItem('preferences')`),
  );
  const base = prefs.bases?.spa?.T;
  const fulgoraTab = base?.tabs?.find((t) => t.id === 'fulgora');
  const glebaTab = base?.tabs?.find((t) => t.id === 'gleba');
  const imported = base?.imports?.nauvis?.['holmium-plate']?.rate;
  check(
    'Nauvis solved in background: imports holmium plate',
    !!imported,
    `rate/s=${imported}`,
  );
  check(
    'Fulgora build created automatically',
    !!fulgoraTab?.build && prefs.states?.spa?.[fulgoraTab.build] != null,
    fulgoraTab?.build,
  );
  check(
    'Fulgora export recorded equal to Nauvis import',
    fulgoraTab?.applied?.['holmium-plate'] === imported,
    JSON.stringify(fulgoraTab?.applied),
  );
  check(
    'Fulgora has totals',
    !!base?.summaries?.fulgora,
    JSON.stringify(base?.summaries?.fulgora),
  );
  check('unused Gleba left alone', !glebaTab?.build);
  const pageText = await evaluate('document.body.innerText');
  check(
    'page is still the unrelated gear build',
    (await evaluate('location.search')).includes('iron-gear-wheel') ||
      !pageText.includes('Superconductor'),
  );
  check('overview lists the export', pageText.includes('Holmium plate'));
  check(
    'no background error shown',
    !pageText.includes('Background update failed'),
  );

  // 4. Open the Fulgora build: holmium plate objective, Fulgora-only recipes
  if (fulgoraTab?.build) {
    await go(`${APP}/spa/list?${prefs.states.spa[fulgoraTab.build]}`, 8000);
    const text = await evaluate('document.body.innerText');
    check('Fulgora build makes holmium plate', text.includes('Holmium plate'));
    check(
      'Fulgora build uses Fulgora resources (holmium ore via scrap)',
      /Scrap|Holmium ore/.test(text),
    );
  }

  // 5. Open the Nauvis tab, double the objective in the UI: Fulgora follows
  await go(`${APP}/spa/list?o=iron-gear-wheel*10&v=12`, 6000);
  const opened = await evaluate(`(() => {
    const tab = [...document.querySelectorAll('lab-base-bar button')]
      .find((b) => b.textContent.trim() === 'Nauvis');
    tab?.click();
    return !!tab;
  })()`);
  check('clicked the Nauvis tab', opened);
  await sleep(6000);
  check(
    'Nauvis build is on screen',
    (await evaluate('location.search')).includes('superconductor'),
  );
  const edited = await evaluate(`(() => {
    const input = document.querySelector('lab-objectives input');
    if (!input) return false;
    input.focus();
    input.value = '120';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    return true;
  })()`);
  check('changed the objective to 120/min', edited);
  await sleep(10000);
  const after = JSON.parse(
    await evaluate(`localStorage.getItem('preferences')`),
  );
  const b2 = after.bases.spa.T;
  const nauvisSaved = after.states.spa['T – Nauvis'];
  check(
    'edit autosaved into the Nauvis build',
    nauvisSaved.includes('superconductor*120'),
    nauvisSaved.slice(0, 40),
  );
  check(
    'Nauvis import doubled',
    b2.imports?.nauvis?.['holmium-plate']?.rate === '2/3',
    b2.imports?.nauvis?.['holmium-plate']?.rate,
  );
  const f2 = b2.tabs.find((t) => t.id === 'fulgora');
  check(
    'Fulgora export followed without opening it',
    f2.applied?.['holmium-plate'] === '2/3',
    JSON.stringify(f2.applied),
  );
  const fulgoraQuery = after.states.spa[f2.build];
  check(
    'Fulgora build objective updated (40/min)',
    fulgoraQuery.includes('holmium-plate*40'),
    fulgoraQuery.slice(0, 60),
  );

  // 6. A brand-new Space Age build starts on the legendary 4-beacon preset
  await go(`${APP}/spa/list`, 8000);
  const fresh = await evaluate('location.search');
  check('new build uses the default preset', fresh.includes('mpr=6'), fresh);

  check(
    'no uncaught errors in the page',
    errors.length === 0,
    errors.slice(0, 3).join(' | '),
  );
} catch (err) {
  console.log('FAIL script error —', err.message);
  fails++;
} finally {
  ws?.close();
  chrome.kill();
}
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exit(fails ? 1 : 0);
