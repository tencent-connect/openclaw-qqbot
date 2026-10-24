/** Run after npm run build: node --test tests/runtime-lifecycle.test.cjs */
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const entry = path.resolve(__dirname, '../dist/index.cjs');
const setup = `
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const q = require(${JSON.stringify(entry)});
  const services = [];
  const register = () => q.default.register({
    runtime: { version: '2026.10.6' },
    registerService(service) { services.push(service); },
    registerChannel() {}, registerTool() {},
  });
`;

function isolatedHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-lifecycle-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function run(t, body) {
  const home = isolatedHome(t);
  const child = spawnSync(process.execPath, ['-e', setup + body], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  return home;
}

test('registering without QQ accounts leaves host signals alone and installs one exit fallback', (t) => {
  run(t, `
    const before = Object.fromEntries(['SIGINT', 'SIGTERM', 'beforeExit'].map(s => [s, process.listenerCount(s)]));
    register();
    q.setQQBotRuntime({ version: '2026.10.6' });
    assert.equal(process.listenerCount('SIGINT'), before.SIGINT);
    assert.equal(process.listenerCount('SIGTERM'), before.SIGTERM);
    assert.equal(process.listenerCount('beforeExit'), before.beforeExit + 1);
  `);
});

test('host service stop persists all account ref indexes and can run repeatedly', (t) => {
  run(t, `
    register();
    assert.equal(services.length, 1);
    const service = services[0];
    service.start({});
    for (const account of ['account-a', 'account-b']) {
      const store = q.getPersistedRefIndexStore(account);
      const value = { messageId: account, content: 'pending quote ' + account };
      store.set('REFIDX-test', value);
    }
    service.stop({});
    service.stop({});
    for (const account of ['account-a', 'account-b']) {
      const store = q.getPersistedRefIndexStore(account);
      const reopened = new q.PersistedRefIndexStore({ filePath: store.stats().filePath });
      assert.deepEqual(reopened.get('REFIDX-test'), { messageId: account, content: 'pending quote ' + account });
    }
  `);
});

test('beforeExit still compacts the latest ref index when the host exits naturally', (t) => {
  const home = run(t, `
    register();
    const store = q.getPersistedRefIndexStore('natural-exit');
    store.set('REFIDX-test', { messageId: 'old' });
    store.set('REFIDX-test', { messageId: 'latest' });
  `);
  const file = path.join(home, '.openclaw/qqbot/data/natural-exit/ref-index.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].v.messageId, 'latest');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} lets the host finish asynchronous shutdown`, { timeout: 10000 }, async (t) => {
    const home = isolatedHome(t);
    const child = spawn(process.execPath, ['-e', setup + `
      const keepAlive = setInterval(() => {}, 1000);
      process.on('${signal}', () => {
        setTimeout(() => {
          fs.writeFileSync(process.env.HOME + '/host-cleanup-complete', '${signal}');
          clearInterval(keepAlive);
        }, 50);
      });
      register();
      process.stdout.write('ready\\n');
    `], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, sig) => resolve({ code, sig }));
    });
    const deadline = Date.now() + 10000;
    while (!stdout.includes('ready\n')) {
      assert.equal(child.exitCode, null, stdout + stderr);
      assert.ok(Date.now() < deadline, 'plugin registration timed out: ' + stderr);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    child.kill(signal);
    const result = await exited;
    assert.deepEqual(result, { code: 0, sig: null }, stdout + stderr);
    assert.equal(fs.readFileSync(path.join(home, 'host-cleanup-complete'), 'utf8'), signal);
  });
}
