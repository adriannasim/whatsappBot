import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILE_BYTES = 40 * 1024 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const isWindows = process.platform === 'win32';

function storeError() {
  return Object.assign(new Error('The private message cache could not be read or saved.'), { code: 'RECENT_STORE_FAILED' });
}

async function statIfPresent(filename) {
  try { return await lstat(filename); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function ownedRegular(info) {
  return info.isFile() && !info.isSymbolicLink()
    && (typeof process.getuid !== 'function' || info.uid === process.getuid());
}

/** Private atomic snapshots; the caller validates owners, retention and contents. */
export async function openRecentMessageStore({ directory = './data/recent-messages', onWarning = () => {} } = {}) {
  if (typeof directory !== 'string' || !directory.trim() || typeof onWarning !== 'function') throw storeError();
  const root = path.resolve(directory);
  const filename = path.join(root, 'cache.json');
  const temporary = path.join(root, '.cache.tmp');
  const warn = message => { try { onWarning(message); } catch { /* Logging cannot affect storage. */ } };

  async function checkDirectory() {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()
      || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw storeError();
    await chmod(root, 0o700);
  }

  async function checkFile() {
    const info = await statIfPresent(filename);
    if (info && (!ownedRegular(info) || info.size > MAX_FILE_BYTES)) throw storeError();
    return info;
  }

  // Only this store's fixed, private, regular temporary file can be removed.
  async function removeTemporary(expected) {
    const info = await statIfPresent(temporary);
    if (!info) return;
    if (!ownedRegular(info) || (!isWindows && (info.mode & 0o077) !== 0)
      || (expected && (info.dev !== expected.dev || info.ino !== expected.ino))) throw storeError();
    await unlink(temporary);
  }

  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await checkDirectory();
    await removeTemporary();
  } catch { throw storeError(); }

  let pending;
  let writing;
  let lastFailure;

  async function atomicWrite(json) {
    let handle;
    let temporaryInfo;
    try {
      await checkDirectory();
      await checkFile();
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600);
      temporaryInfo = await handle.stat();
      if (!ownedRegular(temporaryInfo)) throw storeError();
      await handle.chmod(0o600);
      await handle.writeFile(json, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await checkFile();
      await rename(temporary, filename);
      temporaryInfo = undefined;
      // Windows does not support opening directories for fsync through Node.
      if (!isWindows) {
        const directoryHandle = await open(root, constants.O_RDONLY | NO_FOLLOW);
        try { await directoryHandle.sync(); }
        finally { await directoryHandle.close(); }
      }
    } catch {
      throw storeError();
    } finally {
      await handle?.close().catch(() => {});
      if (temporaryInfo) await removeTemporary(temporaryInfo).catch(() => {});
    }
  }

  async function drain() {
    while (pending) {
      const batch = pending;
      pending = undefined;
      try {
        await atomicWrite(batch.json);
        lastFailure = undefined;
        for (const waiter of batch.waiters) waiter.resolve();
      } catch {
        lastFailure = storeError();
        for (const waiter of batch.waiters) waiter.reject(lastFailure);
      }
    }
    writing = undefined;
  }

  function save(snapshot) {
    let json;
    try {
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw storeError();
      json = JSON.stringify(snapshot);
      if (typeof json !== 'string' || !json.startsWith('{') || Buffer.byteLength(json, 'utf8') > MAX_FILE_BYTES) throw storeError();
    } catch { return Promise.reject(storeError()); }
    // Capture now so subsequent caller mutations cannot change the saved snapshot.
    const saved = new Promise((resolve, reject) => {
      if (pending) {
        pending.json = json;
        pending.waiters.push({ resolve, reject });
      } else pending = { json, waiters: [{ resolve, reject }] };
    });
    if (!writing) writing = Promise.resolve().then(drain);
    return saved;
  }

  async function flush() {
    while (writing) await writing;
    if (lastFailure) throw storeError();
  }

  async function load() {
    await flush();
    let handle;
    let data;
    try {
      await checkDirectory();
      if (!await checkFile()) return null;
      handle = await open(filename, constants.O_RDONLY | NO_FOLLOW);
      const info = await handle.stat();
      if (!ownedRegular(info) || info.size > MAX_FILE_BYTES) throw storeError();
      await handle.chmod(0o600);
      // Never allocate/read more than the bounded snapshot, including if it grows.
      const buffer = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await handle.read(buffer, length, buffer.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length === buffer.length) throw storeError();
      data = buffer.subarray(0, length);
    } catch { throw storeError(); }
    finally { await handle?.close().catch(() => {}); }
    try {
      const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw storeError();
      return result;
    } catch {
      warn('The saved message cache was invalid and was ignored. New messages can create a fresh cache.');
      return null;
    }
  }

  return { load, save, flush };
}
