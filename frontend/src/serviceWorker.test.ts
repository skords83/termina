import workerSource from '../public/sw.js?raw';
import { expect, it, vi } from 'vitest';

it('purges legacy private caches before claiming clients without caching new API responses', async () => {
  const handlers = new Map<string, (event: { waitUntil: (promise: Promise<void>) => void }) => void>();
  const cacheNames = new Set(['termina-v1', 'termina-old', 'unrelated-app']);
  const claim = vi.fn(() => {
    expect([...cacheNames]).toEqual(['unrelated-app']);
  });
  new Function('self', 'caches', workerSource)({
    addEventListener: (name: string, handler: (event: { waitUntil: (promise: Promise<void>) => void }) => void) => handlers.set(name, handler),
    skipWaiting: vi.fn(),
    clients: { claim },
  }, {
    keys: async () => [...cacheNames],
    delete: async (key: string) => cacheNames.delete(key),
  });
  let activation: Promise<void> | undefined;
  handlers.get('activate')!({ waitUntil: (promise) => { activation = promise; } });
  await activation;
  expect(claim).toHaveBeenCalledOnce();
  expect(handlers.has('fetch')).toBe(false);
});
