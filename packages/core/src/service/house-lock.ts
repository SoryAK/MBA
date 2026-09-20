/**
 * Per-file mutation queue.
 *
 * The daemon is the only writer, but overlapping HTTP handlers still
 * interleave at `await`. Connect, boot, stop, and config updates read,
 * wait, then write — the second write can erase the first. This lock is
 * the queue: one key (a house file path) runs one mutation at a time.
 * Different keys do not wait on each other.
 */

const tails = new Map<string, Promise<void>>();

export async function withHouseLock<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  tails.set(key, next);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (tails.get(key) === next) tails.delete(key);
  }
}
