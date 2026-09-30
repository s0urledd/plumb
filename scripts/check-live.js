// Checks a running Plumb from outside: the page loads, the API answers, the
// index follows the chain, contract state is fresh and the event history is
// complete. Exits 1 on any failure, so a scheduled workflow run fails and
// GitHub mails the repository owner. With TELEGRAM_BOT_TOKEN and
// TELEGRAM_CHAT_ID set, it also sends the failures (and the recovery) there.
//   node scripts/check-live.js [https://plumb.huginn.tech]
const SITE = (process.argv[2] || process.env.PLUMB_URL || 'https://plumb.huginn.tech').replace(/\/$/, '');
const MAX_LAG_S = Number(process.env.MAX_LAG_S || 180); // the index may trail the wall clock by this much

async function get(path, timeoutMs = 20000) {
  const started = Date.now();
  const res = await fetch(SITE + path, { signal: AbortSignal.timeout(timeoutMs) });
  return { res, ms: Date.now() - started };
}

async function checks() {
  const failures = [];
  const fail = text => failures.push(text);
  try {
    const { res, ms } = await get('/');
    if (res.status !== 200) fail(`page: HTTP ${res.status}`);
    else if (!(await res.text()).includes('Plumb')) fail('page: unexpected content');
    else if (ms > 10000) fail(`page: slow (${ms} ms)`);
  } catch (error) { fail(`page: ${error.name === 'TimeoutError' ? 'timed out' : error.message}`); }
  try {
    const { res } = await get('/api/v1/health');
    if (res.status !== 200) fail(`health: HTTP ${res.status}`);
    else {
      const h = await res.json(), now = Date.now() / 1000;
      if (h.ok !== true) fail('health: not ok');
      const lag = now - Number(h.index?.live?.toTs ?? 0);
      if (!(lag < MAX_LAG_S)) fail(`index: ${Math.round(lag)} s behind the clock`);
      if (h.snapshot?.status !== 'fresh') fail(`contract state: ${h.snapshot?.status ?? 'unknown'}`);
      if (h.index?.backfill && h.index.backfill.complete !== true) fail('history: incomplete');
    }
  } catch (error) { fail(`health: ${error.name === 'TimeoutError' ? 'timed out' : error.message}`); }
  return failures;
}

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(10000) });
  } catch { /* the workflow failure still reports it */ }
}

// A failure is retried once after a short pause, so a deploy's restart does not raise an alarm.
let failures = await checks();
if (failures.length) { await new Promise(resolve => setTimeout(resolve, 45000)); failures = await checks(); }
const previous = process.env.PREVIOUS_STATE; // 'down' when the last run failed (from the workflow cache)
if (failures.length) {
  console.log(`DOWN ${SITE}\n- ${failures.join('\n- ')}`);
  if (previous !== 'down') await telegram(`Plumb check failed (${SITE}):\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log(`OK ${SITE}`);
  if (previous === 'down') await telegram(`Plumb is back up (${SITE}).`);
}
