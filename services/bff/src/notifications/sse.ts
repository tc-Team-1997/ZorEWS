// services/bff/src/notifications/sse.ts
//
// Server-Sent Events helpers. SSE is the right pick over WebSocket for
// notification fan-out: one-way, plain HTTP, auto-reconnect built into
// the browser's EventSource client, no extra deps on the server side.

import type { Request, Response } from 'express';
import type { NotificationBus } from './bus';
import type { Notification } from './types';

/**
 * Returns true when the response socket is still open and writable.
 * Checks both the legacy `writable` flag and Node ≥18's `writableEnded` /
 * `destroyed` — any closed indicator means we should not attempt a write.
 */
function isWritable(res: Response): boolean {
  const r = res as Response & { writableEnded?: boolean; destroyed?: boolean };
  if (r.destroyed) return false;
  if (r.writableEnded) return false;
  return res.writable !== false;
}

/**
 * Open an SSE connection on the given Express response. Backfills the
 * bus's recent buffer first so a fresh client doesn't see a blank list,
 * then streams every subsequent publish until the client disconnects.
 *
 * Heartbeat: a comment line every 25s keeps proxies (nginx default 60s
 * idle timeout) from killing the stream.
 *
 * Defensive write: every `res.write()` call is guarded — if the socket
 * closes mid-backfill (e.g. the tab is closed before the first frame
 * lands) a raw EPIPE would propagate to Express and produce an HTTP 500.
 * The guard prevents that: we check `isWritable()` before each write and
 * absorb any thrown `Error` so Express's error handler never fires.
 */
export function openSse(req: Request, res: Response, bus: NotificationBus): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx: don't buffer
  // Flush headers immediately so the browser sees the open.
  if (typeof (res as { flushHeaders?: () => void }).flushHeaders === 'function') {
    (res as { flushHeaders: () => void }).flushHeaders();
  }

  const send = (n: Notification): void => {
    // Guard: skip writes to a closed/destroyed socket to avoid EPIPE → 500.
    if (!isWritable(res)) return;
    try {
      res.write(`id: ${n.id}\n`);
      res.write(`event: notification\n`);
      res.write(`data: ${JSON.stringify(n)}\n\n`);
    } catch {
      // Socket closed mid-write — cleanup will fire via the 'close' event.
    }
  };

  // Backfill — most-recent first so client lists newest at the top.
  // Loop guarded so that an early client disconnect (socket closed between
  // flushHeaders and the first write) cannot produce a 500 via EPIPE.
  for (const n of bus.recent) {
    if (!isWritable(res)) break;
    send(n);
  }

  const unsubscribe = bus.subscribe(send);

  const heartbeat = setInterval(() => {
    if (!isWritable(res)) {
      clearInterval(heartbeat);
      return;
    }
    try {
      res.write(': hb\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 25_000);
  // Don't let the heartbeat keep the node process alive — when all real
  // requests have closed, a lingering setInterval would block exit.
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
    try {
      res.end();
    } catch {
      // already closed
    }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}
