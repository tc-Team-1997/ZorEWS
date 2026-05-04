// services/bff/src/notifications/sse.ts
//
// Server-Sent Events helpers. SSE is the right pick over WebSocket for
// notification fan-out: one-way, plain HTTP, auto-reconnect built into
// the browser's EventSource client, no extra deps on the server side.

import type { Request, Response } from 'express';
import type { NotificationBus } from './bus';
import type { Notification } from './types';

/**
 * Open an SSE connection on the given Express response. Backfills the
 * bus's recent buffer first so a fresh client doesn't see a blank list,
 * then streams every subsequent publish until the client disconnects.
 *
 * Heartbeat: a comment line every 25s keeps proxies (nginx default 60s
 * idle timeout) from killing the stream.
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

  const send = (n: Notification) => {
    res.write(`id: ${n.id}\n`);
    res.write(`event: notification\n`);
    res.write(`data: ${JSON.stringify(n)}\n\n`);
  };

  // Backfill — most-recent first so client lists newest at the top.
  for (const n of bus.recent) send(n);

  const unsubscribe = bus.subscribe(send);
  const heartbeat = setInterval(() => {
    res.write(': hb\n\n');
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
