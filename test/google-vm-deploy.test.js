import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, readlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The deployment helper targets Ubuntu and requires GNU tools and Bash 4+.
const test = (name, run) => nodeTest(name, { skip: process.platform !== 'linux' }, run);
const helper = fileURLToPath(new URL('../deploy/google-vm/deploy.sh', import.meta.url));
const revision = 'a'.repeat(40);
const previous = 'b'.repeat(40);

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'whatsapp-vm-deploy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'bot');
  const bin = path.join(directory, 'bin');
  const source = path.join(directory, 'source');
  const archive = path.join(directory, 'source.tar');
  const events = path.join(directory, 'events');
  const active = path.join(directory, 'active');
  const shared = path.join(root, 'shared');
  for (const name of [bin, shared, path.join(root, 'releases', previous), path.join(source, 'src'), path.join(source, 'scripts')]) {
    await mkdir(name, { recursive: true });
  }
  await symlink(process.execPath, path.join(bin, 'node'));
  await writeFile(path.join(shared, 'node-bin'), bin + '\n');
  await writeFile(path.join(shared, '.env'), 'TEST_PRIVATE_VALUE=keep\n');
  await mkdir(path.join(shared, '.baileys-auth'));
  await writeFile(path.join(shared, '.baileys-auth', 'creds.json'), '{"fixture":"keep"}');
  await symlink(path.join(root, 'releases', previous), path.join(root, 'current'));
  await writeFile(path.join(source, 'package.json'), '{"name":"fixture","version":"1.0.0","type":"module"}');
  await writeFile(path.join(source, 'package-lock.json'), '{}');
  await writeFile(path.join(source, 'src', 'index.js'), '// Offline fixture; never starts WhatsApp.\n');
  await writeFile(path.join(source, 'scripts', 'check-runtime.mjs'), [
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync(process.env.FIXTURE_EVENTS, 'runtime\\n');",
    "if (process.env.FIXTURE_FAIL_RUNTIME === '1') process.exit(1);",
  ].join('\n'));
  const executable = (name, text) => writeFile(path.join(bin, name), '#!/bin/sh\nset -eu\n' + text, { mode: 0o755 });
  await executable('npm', [
    'printf "install %s\\n" "$*" >> "$FIXTURE_EVENTS"',
    '[ "${FIXTURE_FAIL_INSTALL:-0}" != 1 ]',
  ].join('\n'));
  await executable('systemctl', [
    'case "$*" in',
    '  "show --property=LoadState --value whatsapp-summary-bot.service") printf "loaded\\n" ;;',
    '  "show --property=MainPID --value whatsapp-summary-bot.service") printf "1234\\n" ;;',
    '  "is-active --quiet whatsapp-summary-bot.service") [ "${FIXTURE_FAIL_STATUS:-0}" != 1 ] ;;',
    '  "is-active whatsapp-summary-bot.service")',
    '    if [ -f "$FIXTURE_ACTIVE" ]; then printf "active\\n"; else printf "inactive\\n"; exit 3; fi ;;',
    '  *) exit 9 ;;',
    'esac',
  ].join('\n'));
  await executable('sudo', [
    '[ "$1" = "-n" ]',
    'if [ "$2" = "-l" ]; then [ "${FIXTURE_DENY_SUDO:-0}" != 1 ]; exit; fi',
    '[ "$2" = "$BOT_SYSTEMCTL_BIN" ] && [ "$3" = restart ] && [ "$4" = whatsapp-summary-bot.service ]',
    'printf "restart\\n" >> "$FIXTURE_EVENTS"',
    '[ "${FIXTURE_FAIL_RESTART:-0}" != 1 ]',
    'touch "$FIXTURE_ACTIVE"',
  ].join('\n'));
  await executable('sleep', 'exit 0\n');
  const env = {
    ...process.env,
    PATH: bin + path.delimiter + process.env.PATH,
    BOT_DEPLOY_ROOT: root,
    BOT_SYSTEMCTL_BIN: path.join(bin, 'systemctl'),
    FIXTURE_EVENTS: events,
    FIXTURE_ACTIVE: active,
  };
  function pack(extras = []) {
    const result = spawnSync('tar', ['-cf', archive, '-C', source, 'package.json', 'package-lock.json', 'src', 'scripts', ...extras], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  pack();
  return {
    root, source, shared, bin, active, pack,
    run: (extraEnv = {}, args = []) => spawnSync('bash', [helper, revision, archive, ...args], {
      env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 10_000,
    }),
    events: async () => (await readFile(events, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean),
    current: () => readlink(path.join(root, 'current')),
    preserved: async () => {
      assert.equal(await readFile(path.join(shared, '.env'), 'utf8'), 'TEST_PRIVATE_VALUE=keep\n');
      assert.equal(await readFile(path.join(shared, '.baileys-auth', 'creds.json'), 'utf8'), '{"fixture":"keep"}');
      await access(path.join(root, 'releases', previous));
    },
  };
}

test('installs and validates the release before one restart, preserving shared credentials', async t => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await f.events(), ['install ci --omit=dev --ignore-scripts --no-audit --no-fund', 'runtime', 'restart']);
  assert.equal(await f.current(), path.join(f.root, 'releases', revision));
  assert.match(result.stdout, /systemd process remained running/);
  await f.preserved();
});

test('install or runtime failure leaves current and the running service untouched', async t => {
  for (const key of ['FIXTURE_FAIL_INSTALL', 'FIXTURE_FAIL_RUNTIME']) {
    const f = await fixture(t);
    const result = f.run({ [key]: '1' });
    assert.notEqual(result.status, 0);
    assert.equal(await f.current(), path.join(f.root, 'releases', previous));
    assert.ok(!(await f.events()).includes('restart'));
    await f.preserved();
  }
});

test('sudo permission failure is caught before installing or switching releases', async t => {
  const f = await fixture(t);
  const result = f.run({ FIXTURE_DENY_SUDO: '1' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(await f.events(), []);
  assert.equal(await f.current(), path.join(f.root, 'releases', previous));
});

test('prepare installs a release without restart and refuses an active bot', async t => {
  const f = await fixture(t);
  let result = f.run({}, ['--prepare']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!(await f.events()).includes('restart'));
  await writeFile(f.active, '');
  result = f.run({}, ['--prepare']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Stop the bot/);
});

test('same revision retries reuse installed dependencies and reject changed source', async t => {
  const f = await fixture(t);
  assert.equal(f.run().status, 0);
  assert.equal(f.run().status, 0);
  assert.equal((await f.events()).filter(value => value.startsWith('install ')).length, 1);
  await writeFile(path.join(f.source, 'src', 'index.js'), '// Changed source\n');
  f.pack();
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /different source/);
});

test('archive rejects credentials and symlinks before installation', async t => {
  for (const kind of ['credentials', 'symlink']) {
    const f = await fixture(t);
    if (kind === 'credentials') {
      await writeFile(path.join(f.source, '.env'), 'bad');
      f.pack(['.env']);
    } else {
      await symlink('/etc/passwd', path.join(f.source, 'src', 'link.js'));
      f.pack();
    }
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.deepEqual(await f.events(), []);
    assert.equal(await f.current(), path.join(f.root, 'releases', previous));
    await f.preserved();
  }
});

test('failed post-restart process check preserves both releases and credentials', async t => {
  const f = await fixture(t);
  const result = f.run({ FIXTURE_FAIL_STATUS: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /service stopped/);
  assert.equal(await f.current(), path.join(f.root, 'releases', revision));
  await f.preserved();
});

test('node-bin is read as data and a real current directory is never replaced', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.shared, 'node-bin'), f.bin + '\necho should-not-run\n');
  let result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly one directory/);
  await writeFile(path.join(f.shared, 'node-bin'), f.bin + '\n');
  await rm(path.join(f.root, 'current'));
  await mkdir(path.join(f.root, 'current'));
  result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /current must be a symlink/);
  assert.deepEqual(await f.events(), []);
});
