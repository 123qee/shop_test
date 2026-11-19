import assert from 'node:assert/strict';
import test from 'node:test';
import { lastSorterBatch, readSorterProgress, saveSorterProgress, type SorterProgress } from '../../web/src/sorter-progress';

test('分拣断点区分店铺和批次，两个标签各自的跳过和暂选都可保留', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  } });
  try {
    const initial: SorterProgress = { source: 'asos', currentId: 'shirt', choices: {}, skipped: {} };
    saveSorterProgress('A', undefined, initial);
    const firstTab = { ...initial, currentId: 'hoodie', skipped: { shirt: true } as const };
    const secondTab = { ...initial, choices: { hoodie: 'cotton' } };
    saveSorterProgress('A', undefined, firstTab, initial);
    saveSorterProgress('A', undefined, secondTab, initial);
    const merged = readSorterProgress('A');
    assert.deepEqual(merged?.skipped, { shirt: true });
    assert.deepEqual(merged?.choices, { hoodie: 'cotton' });
    assert.equal(readSorterProgress('B'), null);

    saveSorterProgress('A', 'batch', { ...initial, currentId: 'batch-shirt' });
    assert.equal(lastSorterBatch('A'), 'batch');
    assert.equal(lastSorterBatch('B'), undefined);
    assert.equal(readSorterProgress('A', 'batch')?.currentId, 'batch-shirt');
    saveSorterProgress('A', 'batch', null);
    assert.equal(lastSorterBatch('A'), undefined);
    assert.deepEqual(readSorterProgress('A'), merged);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
