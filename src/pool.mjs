/**
 * Runs `fn` over `items` with at most `limit` calls in flight, returning results
 * in input order. When a call fails, no new items are started, the calls already
 * in flight are allowed to finish (so their checkpoints are written), and the
 * first error is rethrown. A limit below one is treated as one.
 */
export async function runPool(items, limit, fn) {
  const n = items.length;
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, n));
  const results = new Array(n);
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (next < n && !failure) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        failure = failure ?? err;
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  if (failure) throw failure;
  return results;
}

/**
 * Serialises writes of one file: each call waits for the previous write to
 * finish, so concurrent workers checkpointing to the same path never interleave.
 */
export function serialWriter(write) {
  let chain = Promise.resolve();
  return (...args) => {
    chain = chain.then(() => write(...args), () => write(...args));
    return chain;
  };
}
