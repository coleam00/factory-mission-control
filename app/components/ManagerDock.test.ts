import { expect, test } from 'bun:test';
import { isManagerShortcut, readOpen, writeOpen } from './ManagerDock';

const memory = () => {
  const items = new Map<string, string>();
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
};

test('the dock is open until it is closed, and a closed dock stays closed on the next visit', () => {
  const store = memory();
  expect(readOpen(store)).toBe(true);
  writeOpen(store, false);
  expect(readOpen(store)).toBe(false);
  writeOpen(store, true);
  expect(readOpen(store)).toBe(true);
  expect(readOpen(undefined)).toBe(true);
});

test('⌘J and Ctrl+J toggle the dock, other keys do not', () => {
  const key = (k: string, mods: object) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...mods,
  });
  expect(isManagerShortcut(key('j', { ctrlKey: true }))).toBe(true);
  expect(isManagerShortcut(key('J', { metaKey: true }))).toBe(true);
  expect(isManagerShortcut(key('j', {}))).toBe(false);
  expect(isManagerShortcut(key('k', { ctrlKey: true }))).toBe(false);
  expect(isManagerShortcut(key('j', { ctrlKey: true, altKey: true }))).toBe(false);
});
