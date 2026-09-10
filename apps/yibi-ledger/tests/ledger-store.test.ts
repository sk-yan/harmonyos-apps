import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { beforeEach, test } from 'node:test';
import { encodeLedger } from '../entry/src/main/ets/model/Ledger.ts';
import type { LedgerEntry } from '../entry/src/main/ets/model/Ledger.ts';
import { readStored, reset, seed, state } from './helpers/harmony-kit-mock.ts';

interface Store {
  load(): Promise<LedgerEntry[]>;
  save(entries: LedgerEntry[]): Promise<void>;
}

// Execute the actual .ets storage logic against a mock of only the native Kit APIs.
// This does not compile ArkUI or establish HarmonyOS SDK/device compatibility.
const source = await readFile(new URL('../entry/src/main/ets/storage/LedgerStore.ets', import.meta.url), 'utf8');
const kitUrl = new URL('./helpers/harmony-kit-mock.ts', import.meta.url).href;
const coreUrl = new URL('../entry/src/main/ets/model/Ledger.ts', import.meta.url).href;
const executable = stripTypeScriptTypes(source)
  .replace(/from '@kit\.[^']+'/g, `from '${kitUrl}'`)
  .replace('import { LedgerEntry, encodeLedger, decodeLedger }', 'import { encodeLedger, decodeLedger }')
  .replace("from '../model/Ledger'", `from '${coreUrl}'`);
const storageModule = await import('data:text/javascript;base64,' + Buffer.from(executable).toString('base64')) as {
  LedgerStore: new (context: { filesDir: string }) => Store
};
const LedgerStore = storageModule.LedgerStore;
const path = '/sandbox/ledger-v1.json';

function entry(id: string, note = ''): LedgerEntry {
  return { id, note, type: 'expense', amountCents: 29, categoryId: 'food',
    date: '2026-09-10', createdAt: 100 };
}

beforeEach(() => reset());

test('missing ledger starts empty without creating a file; read errors remain errors', async () => {
  const store = new LedgerStore({ filesDir: '/sandbox' });
  assert.deepEqual(await store.load(), []);
  assert.equal(state.files.size, 0);
  state.failNext = 'read';
  await assert.rejects(store.load(), /无法读取/);
});

test('existing corrupt data blocks load and save and remains byte-for-byte intact', async () => {
  const store = new LedgerStore({ filesDir: '/sandbox' });
  seed(path, '{broken ledger');
  await assert.rejects(store.load(), /无法解析/);
  await assert.rejects(store.save([entry('new')]), /无法解析/);
  assert.equal(readStored(path), '{broken ledger');
  assert.equal(state.events.includes('open'), false);
});

test('partial UTF-8 writes are completed, flushed, closed and verified before rename', async () => {
  const store = new LedgerStore({ filesDir: '/sandbox' });
  state.maxWriteBytes = 3;
  const entries = [entry('a', '午餐两人份 💰')];
  await store.save(entries);
  assert.deepEqual(await store.load(), entries);
  assert.equal(state.handles.size, 0);
  assert.equal(state.files.has(path + '.tmp'), false);
  assert.ok(state.events.filter((name) => name === 'write').length > 1);
  assert.deepEqual(state.events.slice(-5), ['fsync', 'close', 'read', 'rename', 'read']);
});

test('write, fsync and rename failures preserve the old ledger and allow retry', async () => {
  for (const failure of ['write', 'fsync', 'rename']) {
    reset();
    const store = new LedgerStore({ filesDir: '/sandbox' });
    const original = [entry('old', '原账本')];
    const originalRaw = encodeLedger(original);
    seed(path, originalRaw);
    state.failNext = failure;
    await assert.rejects(store.save([entry('new')]), /Injected I\/O failure/);
    assert.equal(readStored(path), originalRaw, failure);
    assert.deepEqual(await store.load(), original);
    assert.equal(state.handles.size, 0);
    await store.save([entry('retry')]);
    assert.deepEqual(await store.load(), [entry('retry')]);
  }
});

test('zero-progress write fails without replacing the live ledger', async () => {
  const store = new LedgerStore({ filesDir: '/sandbox' });
  seed(path, encodeLedger([entry('old')]));
  state.maxWriteBytes = 0;
  await assert.rejects(store.save([entry('new')]), /写入未完成/);
  assert.deepEqual(await store.load(), [entry('old')]);
  assert.equal(state.handles.size, 0);
});

test('instances serialize read/write operations and snapshot payloads at save call time', async () => {
  const first = new LedgerStore({ filesDir: '/sandbox' });
  const second = new LedgerStore({ filesDir: '/sandbox' });
  const initial = [entry('first', '最初内容')];
  const savingFirst = first.save(initial);
  const readBetween = second.load();
  const savingSecond = second.save([entry('second')]);
  const readLast = first.load();
  initial[0].note = '排队期间的外部修改';
  await Promise.all([savingFirst, savingSecond]);
  assert.deepEqual(await readBetween, [entry('first', '最初内容')]);
  assert.deepEqual(await readLast, [entry('second')]);
  assert.equal(state.handles.size, 0);
  assert.equal(state.events.filter((name) => name === 'rename').length, 2);
});

test('invalid entries reject save before touching storage', async () => {
  const store = new LedgerStore({ filesDir: '/sandbox' });
  const invalid = entry('invalid');
  invalid.amountCents = 0.1;
  await assert.rejects(store.save([invalid]), /金额/);
  assert.deepEqual(state.events, []);
});
