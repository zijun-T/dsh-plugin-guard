/**
 * Append-only, size-capped, content-free audit log.
 *
 * "Content-free" is a design decision, not an oversight: after the incident we
 * only ever needed counts, verdict names, tool names and digests to reconstruct
 * what happened — never prompts or commands. Keeping them out makes the log
 * safe to keep, and cheap enough to never be the reason a run is slow.
 */
import { appendFile, mkdir, open, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

const DENY_KEYS = new Set(['text', 'content', 'arguments', 'args', 'command', 'prompt', 'output', 'result', 'messages']);

/** Strip any field that could carry user content unless explicitly allowed. */
export function redact(record, includeArguments) {
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (!includeArguments && DENY_KEYS.has(key)) {
        out[key] = typeof inner === 'string' ? `sha:${inner.length}` : '[redacted]';
        continue;
      }
      out[key] = walk(inner);
    }
    return out;
  };
  return walk(record);
}

export function createAudit({ dir, file = 'audit.jsonl', maxBytes = 8 * 1024 * 1024, includeArguments = false, enabled = true }) {
  const path = join(dir, file);
  let queue = Promise.resolve();
  let bytes = 0;
  let ready = false;
  let written = 0;

  async function ensure() {
    if (ready) return;
    await mkdir(dir, { recursive: true });
    try {
      bytes = (await stat(path)).size;
    } catch {
      bytes = 0;
    }
    ready = true;
  }

  async function rotate() {
    if (bytes < maxBytes) return;
    try {
      await rename(path, `${path}.1`);
    } catch {
      /* rotation is best-effort */
    }
    bytes = 0;
  }

  /** Queue one record; resolves once it is on disk (never throws at the caller). */
  function write(record) {
    if (!enabled) return Promise.resolve();
    queue = queue.then(async () => {
      try {
        await ensure();
        await rotate();
        const line = `${JSON.stringify(redact(record, includeArguments))}\n`;
        await appendFile(path, line, 'utf8');
        bytes += Buffer.byteLength(line);
        written += 1;
      } catch {
        /* an audit failure must never break the session it audits */
      }
    });
    return queue;
  }

  async function tail(limit = 200) {
    try {
      const handle = await open(path, 'r');
      try {
        const size = (await handle.stat()).size;
        const readBytes = Math.min(size, 512 * 1024);
        const buffer = Buffer.alloc(readBytes);
        await handle.read(buffer, 0, readBytes, size - readBytes);
        return buffer.toString('utf8').trim().split('\n').slice(-limit).map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { raw: line.slice(0, 200) };
          }
        });
      } finally {
        await handle.close();
      }
    } catch {
      return [];
    }
  }

  return { write, tail, path, stats: () => ({ bytes, written, path }) };
}
