import { expect, it, vi } from 'vitest';
import { addFinderItem, explorerFolder } from './explorer-menu';

const detail = (extra: object = {}) => ({ version: 1, hostId: 'host_1', path: '/srv/Проект #1/Отчёты за май', kind: 'directory', items: [] as { label: string; run(): void }[], ...extra });
const event = (d: unknown) => ({ detail: d }) as unknown as Event;

it('opens a folder, and a file’s parent folder', () => {
  expect(explorerFolder(detail())).toEqual({ hostId: 'host_1', path: '/srv/Проект #1/Отчёты за май' });
  expect(explorerFolder(detail({ kind: 'file', path: '/srv/a b/док.docx' }))).toEqual({ hostId: 'host_1', path: '/srv/a b', file: '/srv/a b/док.docx' });
  expect(explorerFolder(detail({ kind: 'file', path: '/док.md' }))?.path).toBe('/');
});
it.each([null, 'x', detail({ version: 2 }), detail({ kind: 'link' }), detail({ hostId: 5 }), detail({ path: 'C:\\work' }), detail({ path: '/a/../b' }), detail({ path: '/a\nb' }), detail({ hostId: 'a b' })])(
  'ignores unexpected details %#', value => { expect(explorerFolder(value)).toBeNull(); });
it('adds an item only in Finder mode and opens the encoded link', () => {
  for (const mode of ['files', 'native'] as const) { const d = detail(); addFinderItem(event(d), mode, vi.fn()); expect(d.items).toEqual([]); }
  const d = detail(); const open = vi.fn((_url: string) => true);
  addFinderItem(event(d), 'finder', open);
  expect(d.items.map(item => item.label)).toEqual(['Открыть в Finder']);
  d.items[0]!.run();
  const url = new URL(open.mock.calls[0]![0]);
  expect(url.protocol).toBe('bb-project-folder:');
  expect(url.searchParams.get('path')).toBe('/srv/Проект #1/Отчёты за май');
  expect(url.searchParams.get('host')).toBe('host_1');
});
it('selects a file only when the handler is known to support it', () => {
  for (const select of [false, true]) {
    const d = detail({ kind: 'file', path: '/srv/Отчёты/Договор #1.docx' }); const open = vi.fn((_url: string) => true);
    addFinderItem(event(d), 'finder', open, select);
    d.items[0]!.run();
    const url = new URL(open.mock.calls[0]![0]);
    expect(d.items[0]!.label).toBe(select ? 'Показать в Finder' : 'Открыть в Finder');
    expect(url.searchParams.get('path')).toBe(select ? '/srv/Отчёты/Договор #1.docx' : '/srv/Отчёты');
    // Handlers before 0.3.0 accept only these three parameters.
    expect([...url.searchParams.keys()]).toEqual(['host', 'path', 'request', ...(select ? ['select'] : [])]);
  }
  const folder = detail(); const open = vi.fn((_url: string) => true);
  addFinderItem(event(folder), 'finder', open, true); folder.items[0]!.run();
  expect(new URL(open.mock.calls[0]![0]).searchParams.has('select')).toBe(false);
});
it('survives a menu without an item list, and reports a missing handler', () => {
  expect(() => addFinderItem(event(detail({ items: undefined })), 'finder', vi.fn())).not.toThrow();
  const d = detail(); addFinderItem(event(d), 'finder', () => false);
  expect(() => d.items[0]!.run()).toThrow(/Finder/);
});
