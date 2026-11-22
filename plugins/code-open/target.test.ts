import { describe, expect, it } from 'vitest';
import { chatOpenKey, forgePath, projectTarget, withoutOverrides } from './target';

describe('forgePath', () => {
  it('builds the KodaForge deep link', () => {
    expect(forgePath({ kind: 'thread', id: 'thr_1' })).toBe('/plugins/kodaforge/forge/thread/thr_1');
    expect(chatOpenKey({ kind: 'environment', id: 'env_1' })).toBe('kodaforge:side:environment:env_1:open');
  });
});

describe('projectTarget', () => {
  it('links directly to the project and opens chat for that same scope', () => {
    const target = projectTarget('project with spaces');
    expect(forgePath(target)).toBe('/plugins/kodaforge/forge/project/project%20with%20spaces');
    expect(chatOpenKey(target)).toBe('kodaforge:side:project:project with spaces:open');
    expect(chatOpenKey({ kind: 'thread', id: 'thr_1' })).toBe('kodaforge:side:thread:thr_1:open');
  });
});

describe('withoutOverrides', () => {
  it('drops the three overridden keys and keeps the rest', () => {
    expect(withoutOverrides('{"smoothScrolling":true,"minimap":false,"stickyScroll":false,"fontSize":15}')).toBe('{"fontSize":15}');
  });
  it('removes the entry when nothing else was stored', () => {
    expect(withoutOverrides('{"smoothScrolling":true,"minimap":false,"stickyScroll":false}')).toBeNull();
    expect(withoutOverrides(null)).toBeNull();
    expect(withoutOverrides('{oops')).toBeNull();
  });
});
