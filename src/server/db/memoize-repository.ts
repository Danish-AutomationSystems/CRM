/**
 * Serves each distinct read once for the life of one request.
 *
 * Cases and dashboards call `listUsers`/`listHandlers` up to five times per
 * request through different service layers; without this each of those is a
 * separate connection, and a handful of concurrent requests exhaust the pool.
 *
 * A method absent from `readMethods` is assumed to be a write and clears the
 * cache, so adding one later cannot silently serve stale data.
 */
export function memoizeRepository<T extends object>(repo: T, readMethods: readonly string[]): T {
  const cache = new Map<string, Promise<unknown>>();
  const reads = new Set<string>(readMethods);

  function keyFor(method: string, args: unknown[]): string | null {
    try {
      return `${method}:${JSON.stringify(args)}`;
    } catch {
      return null; // unserialisable argument - safer not to cache at all
    }
  }

  return new Proxy(repo, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string') return value;

      if (!reads.has(property)) {
        return (...args: unknown[]) => {
          cache.clear();
          const result = value.apply(target, args);
          return result instanceof Promise ? result.finally(() => cache.clear()) : result;
        };
      }

      return (...args: unknown[]) => {
        const key = keyFor(property, args);
        if (key === null) return value.apply(target, args);

        const hit = cache.get(key);
        if (hit) return hit;

        const result = Promise.resolve(value.apply(target, args));
        cache.set(key, result);
        return result.catch((error: unknown) => {
          cache.delete(key);
          throw error;
        });
      };
    }
  }) as T;
}
