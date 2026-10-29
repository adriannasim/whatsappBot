import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openRecentMessageStore } from '../src/recent-store.js';

const MAX_FILE_BYTES = 40 * 1024 * 1024;
const failure = { code: 'RECENT_STORE_FAILED', message: 'The private message cache could not be read or saved.' };
const snapshot = sequence => ({ version: 1, owner: '123@s.whatsapp.net', buffer: { sequence, rows: [{ text: `Message ${sequence}` }] } });

async function fixture(t) {
  // Keep atomic-rename fixtures on the repository filesystem. Some Windows
  // sandbox temp mounts prohibit rename even when creating files is allowed.
  const parent = process.cwd();
  const root = await mkdtemp(path.join(parent, '.recent-store-test-'));
  const directory = path.join(root, 'private');
  const filename = path.join(directory, 'cache.json');
  const temporary = path.join(directory, '.cache.tmp');
  t.after(async () => {
    // The deletion target is the exact newly created test directory.
    assert.equal(path.dirname(root), path.resolve(parent));
    assert.ok(path.basename(root).startsWith('.recent-store-test-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, directory, filename, temporary };
}

async function createLink(t, target, link, type) {
  try { await symlink(target, link, type); return true; }
  catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.skip('Creating symbolic links requires permission on this system.');
    return false;
  }
}

test('private atomic snapshot survives reopening with no leftover temporary file', async t => {
  const f = await fixture(t);
  const store = await openRecentMessageStore(f);
  assert.equal(await store.load(), null);
  await store.save(snapshot(1));
  await store.flush();
  assert.deepEqual(await store.load(), snapshot(1));
  assert.deepEqual(await (await openRecentMessageStore(f)).load(), snapshot(1));
  assert.deepEqual(await readdir(f.directory), ['cache.json']);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(f.directory)).mode & 0o777, 0o700);
    assert.equal((await lstat(f.filename)).mode & 0o777, 0o600);
  }
});

test('concurrent saves keep the final snapshot and capture caller values immediately', async t => {
  const f = await fixture(t);
  const store = await openRecentMessageStore(f);
  await store.save(snapshot(0));
  const saves = [];
  for (let index = 1; index <= 20; index += 1) {
    const value = snapshot(index);
    saves.push(store.save(value));
    value.buffer.rows[0].text = 'Changed after save';
    if (index % 4 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  await store.flush();
  await Promise.all(saves);
  assert.deepEqual(await store.load(), snapshot(20));
  assert.deepEqual(await readdir(f.directory), ['cache.json']);
});

test('readers see only complete snapshots while atomic replacement is in progress', { skip: process.platform === 'win32' ? 'Windows cannot always rename a file held open by another reader.' : false }, async t => {
  const f = await fixture(t);
  const store = await openRecentMessageStore(f);
  await store.save(snapshot(0));
  let finished = false;
  const writer = (async () => {
    for (let sequence = 1; sequence <= 8; sequence += 1) await store.save(snapshot(sequence));
  })().finally(() => { finished = true; });
  writer.catch(() => {});
  while (!finished) {
    const value = JSON.parse(await readFile(f.filename, 'utf8'));
    assert.deepEqual(value, snapshot(value.buffer.sequence));
  }
  await writer;
  assert.deepEqual(await store.load(), snapshot(8));
});

test('invalid JSON, UTF-8 and non-object cache data are ignored with a fixed safe warning', async t => {
  const f = await fixture(t);
  const warnings = [];
  const store = await openRecentMessageStore({ ...f, onWarning: message => warnings.push(message) });
  for (const invalid of ['{"private-content":', 'null', '[]', Buffer.from([0xff])]) {
    await writeFile(f.filename, invalid, { mode: 0o600 });
    assert.equal(await store.load(), null);
  }
  assert.equal(warnings.length, 4);
  assert.equal(new Set(warnings).size, 1);
  assert.equal(warnings[0].includes('private-content'), false);
  assert.equal(warnings[0].includes(f.directory), false);
  await store.save(snapshot(2));
  assert.deepEqual(await store.load(), snapshot(2));
});

test('a throwing warning callback cannot prevent replacing an invalid cache', async t => {
  const f = await fixture(t);
  const store = await openRecentMessageStore({ ...f, onWarning: () => { throw new Error('logger failed'); } });
  await writeFile(f.filename, 'invalid', { mode: 0o600 });
  assert.equal(await store.load(), null);
  await store.save(snapshot(1));
  assert.deepEqual(await store.load(), snapshot(1));
});

test('oversized files are rejected before reading or replacing them', async t => {
  const f = await fixture(t);
  const store = await openRecentMessageStore(f);
  const handle = await open(f.filename, 'w', 0o600);
  try { await handle.truncate(MAX_FILE_BYTES + 1); }
  finally { await handle.close(); }
  await assert.rejects(store.load(), failure);
  await assert.rejects(store.save(snapshot(1)), failure);
  assert.equal((await lstat(f.filename)).size, MAX_FILE_BYTES + 1);
  await assert.rejects(store.flush(), failure);
});

test('invalid and oversized snapshots leave the existing cache unchanged', async t => {
  const f = await fixture(t);
  const store = await openRecentMessageStore(f);
  await store.save(snapshot(1));
  const circular = {};
  circular.self = circular;
  for (const value of [null, [], 'text', circular, { toJSON: () => null }, { text: 'x'.repeat(MAX_FILE_BYTES) }]) {
    await assert.rejects(store.save(value), failure);
  }
  assert.deepEqual(await store.load(), snapshot(1));
});

test('nonregular cache entries fail safely and a later successful save recovers flush', async t => {
  const f = await fixture(t);
  const store = await openRecentMessageStore(f);
  await mkdir(f.filename);
  await assert.rejects(store.load(), failure);
  await assert.rejects(store.save(snapshot(1)), failure);
  await assert.rejects(store.flush(), failure);
  assert.equal((await lstat(f.filename)).isDirectory(), true);
  await rmdir(f.filename);
  await store.save(snapshot(2));
  await store.flush();
  assert.deepEqual(await store.load(), snapshot(2));
});

test('startup removes only its own private regular leftover temporary file', async t => {
  const f = await fixture(t);
  await mkdir(f.directory);
  await writeFile(f.temporary, 'incomplete old snapshot', { mode: 0o600 });
  await writeFile(path.join(f.directory, 'unrelated.txt'), 'untouched');
  const store = await openRecentMessageStore(f);
  assert.deepEqual(await readdir(f.directory), ['unrelated.txt']);
  assert.equal(await store.load(), null);
  assert.equal(await readFile(path.join(f.directory, 'unrelated.txt'), 'utf8'), 'untouched');
});

test('startup rejects nonregular or nonprivate temporary paths without deleting them', async t => {
  const f = await fixture(t);
  await mkdir(f.temporary, { recursive: true });
  await assert.rejects(openRecentMessageStore(f), failure);
  assert.equal((await lstat(f.temporary)).isDirectory(), true);
  if (process.platform !== 'win32') {
    await rmdir(f.temporary);
    await writeFile(f.temporary, 'private contents', { mode: 0o600 });
    await chmod(f.temporary, 0o644);
    await assert.rejects(openRecentMessageStore(f), failure);
    assert.equal(await readFile(f.temporary, 'utf8'), 'private contents');
  }
});

test('cache symbolic links are not read or overwritten', async t => {
  const f = await fixture(t);
  const store = await openRecentMessageStore(f);
  const target = path.join(f.root, 'outside.json');
  await writeFile(target, JSON.stringify(snapshot(1)));
  if (!await createLink(t, target, f.filename, 'file')) return;
  await assert.rejects(store.load(), failure);
  await assert.rejects(store.save(snapshot(2)), failure);
  assert.equal((await lstat(f.filename)).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), snapshot(1));
});

test('directory symbolic links are rejected without following them', async t => {
  const f = await fixture(t);
  const target = path.join(f.root, 'other');
  await mkdir(target);
  if (!await createLink(t, target, f.directory, process.platform === 'win32' ? 'junction' : 'dir')) return;
  await assert.rejects(openRecentMessageStore(f), failure);
  assert.deepEqual(await readdir(target), []);
});

test('leftover temporary symbolic links are rejected without following or removing them', async t => {
  const f = await fixture(t);
  await mkdir(f.directory);
  const targetFile = path.join(f.root, 'keep.txt');
  await writeFile(targetFile, 'untouched');
  if (!await createLink(t, targetFile, f.temporary, 'file')) return;
  await assert.rejects(openRecentMessageStore(f), failure);
  assert.equal((await lstat(f.temporary)).isSymbolicLink(), true);
  assert.equal(await readFile(targetFile, 'utf8'), 'untouched');
});
