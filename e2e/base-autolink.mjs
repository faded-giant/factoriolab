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
      { id: 'nauvis', label: 'Nauvis', location: 'nauvis', build: 'T – Nauvis', links: { 'holmium-plate': 'fulgora' }, via: { 'holmium-plate': 'p1' } },
      { id: 'fulgora', label: 'Fulgora', location: 'fulgora' },
      { id: 'gleba', label: 'Gleba', location: 'gleba' },
      { id: 'p1', label: 'Shuttle', location: 'space-platform', route: {
        stops: [{ location: 'fulgora', wait: 60 }, { location: 'nauvis', wait: 60 }],
        speed: 100 } },
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
  // Shuttle: 2 x 15000 km at 100 km/s plus 2 x 60 s waiting = 7 min. Fulgora
  // holds 0.02 rockets/min x 7 min of holmium plate, rounded up to 1 rocket
  check('overview shows the shuttle lap', pageText.includes('7 min'));
  check(
    'overview shows the silo buffer for the shuttle',
    pageText.includes('to hold 1 rocket for Shuttle'),
    pageText.match(/.*rocket.*for.*/)?.[0],
  );
  check(
    'overview shows cargo per lap',
    /\d+ stacks\/lap/.test(pageText),
    pageText.match(/.*stacks.*/)?.[0],
  );
  check('no route warning', !pageText.includes('does not stop there'));

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

  // Fulgora launches the holmium plate to Nauvis, so it also makes rocket
  // parts: 50 per rocket launched
  const parts = f2.applied?.['rocket-part'];
  check('Fulgora makes rocket parts for its launches', !!parts, parts);
  check(
    'Fulgora build has a rocket part objective',
    fulgoraQuery.includes('rocket-part'),
    fulgoraQuery.slice(0, 80),
  );
  const nauvisApplied = b2.tabs.find((t) => t.id === 'nauvis').applied ?? {};
  check(
    'Nauvis launches nothing',
    !('rocket-part' in nauvisApplied),
    JSON.stringify(nauvisApplied),
  );

  // 6. Name a new platform, rename it, then delete it
  const click = (selector, text) =>
    evaluate(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((b) => b.textContent.trim() === ${JSON.stringify(text)}
          || b.getAttribute('aria-label') === ${JSON.stringify(text)});
      el?.click();
      return !!el;
    })()`);
  const type = (value) =>
    evaluate(`(() => {
      const input = document.activeElement;
      if (input?.tagName !== 'INPUT') return false;
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
  const savedBase = async () =>
    JSON.parse(await evaluate(`localStorage.getItem('preferences')`)).bases.spa
      .T;

  check('clicked + Platform', await click('lab-base-bar button', 'Platform'));
  await sleep(500);
  check('typed the platform name', await type('Iron Ship'));
  await sleep(1000);
  let ship = (await savedBase()).tabs.find((t) => t.label === 'Iron Ship');
  check(
    'platform created with its name',
    ship?.location === 'space-platform',
    JSON.stringify(ship),
  );
  check(
    'opened the platform tab',
    await click('lab-base-bar button', 'Iron Ship'),
  );
  await sleep(6000);
  check('clicked rename', await click('lab-base-bar button', 'Rename tab'));
  await sleep(500);
  check('typed the new name', await type('Copper Ship'));
  await sleep(2000);
  const prefs3 = JSON.parse(
    await evaluate(`localStorage.getItem('preferences')`),
  );
  ship = prefs3.bases.spa.T.tabs.find((t) => t.id === ship?.id);
  check(
    'platform renamed',
    ship?.label === 'Copper Ship',
    JSON.stringify(ship),
  );
  check(
    'its build renamed with it',
    ship?.build === 'T – Copper Ship' &&
      prefs3.states.spa['T – Copper Ship'] != null &&
      prefs3.states.spa['T – Iron Ship'] == null,
    ship?.build,
  );
  check('clicked delete', await click('lab-base-bar button', 'Delete tab'));
  await sleep(500);
  check('confirmed', await click('button', 'Delete'));
  await sleep(1000);
  check(
    'platform deleted',
    !(await savedBase()).tabs.some((t) => t.id === ship?.id),
  );

  // The route dialog shows the shuttle's estimated lap
  check(
    'opened the shuttle tab',
    await click('lab-base-bar button', 'Shuttle'),
  );
  await sleep(6000);
  check('clicked Route', await click('lab-base-bar button', 'Route'));
  await sleep(1000);
  const dialogText = await evaluate(
    `document.querySelector('lab-base-route-dialog')?.innerText ?? ''`,
  );
  check(
    'route dialog estimates the lap',
    dialogText.includes('Estimated lap: 7 min (5 min flying, 2 min waiting)'),
    dialogText.match(/Estimated.*/)?.[0],
  );
  await evaluate(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  );
  await sleep(500);

  // 7. A brand-new Space Age build starts on the legendary 4-beacon preset
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
