// services/notification-svc/src/server.ts
//
// HTTP entrypoint for notification-svc.
//
// Endpoints
// ---------
//   POST /notify            — direct fan-out: { alert, target } → channel results
//   POST /events            — Kafka-equivalent test hook: same body, just an
//                              alias for /notify so we can drive it from a
//                              shell script that mimics the topic consumer
//                              (the real consumer is started inside `start`
//                              when KAFKA_BROKERS is set; that wiring is a
//                              TODO for agent-integration).
//   GET  /healthz           — liveness
//
// Adapters are picked per environment (real SES / AT if creds present, else
// LoggingAdapter to stdout + .outbox/<channel>-<date>.ndjson).

import express, { NextFunction, Request, Response } from 'express';
import * as path from 'node:path';
import { makeEmailAdapter } from './adapters/ses';
import { makeSmsAdapter } from './adapters/africas_talking';
import { AlertSubscriber } from './subscriber';
import type { AlertSummary, NotifyTarget } from './types';

export interface AppDeps {
  outboxDir?: string;
  emailAdapter?: ReturnType<typeof makeEmailAdapter>;
  smsAdapter?: ReturnType<typeof makeSmsAdapter>;
}

export function makeApp(deps: AppDeps = {}) {
  const outboxDir = deps.outboxDir ?? path.resolve(__dirname, '..', '.outbox');
  const emailAdapter = deps.emailAdapter ?? makeEmailAdapter(process.env, outboxDir);
  const smsAdapter = deps.smsAdapter ?? makeSmsAdapter(process.env, outboxDir);
  const subscriber = new AlertSubscriber({ emailAdapter, smsAdapter });

  const app = express();
  app.use(express.json({ limit: '512kb' }));

  app.get('/healthz', (_req, res) =>
    res.json({
      ok: true,
      adapters: { email: emailAdapter.name, sms: smsAdapter.name },
    }),
  );

  // POST /notify  body: { alert: AlertSummary, target: NotifyTarget }
  app.post('/notify', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { alert, target } = req.body as { alert?: AlertSummary; target?: NotifyTarget };
      if (!alert || !alert.alert_id) {
        return res.status(400).json({ error: 'alert.alert_id is required' });
      }
      const results = await subscriber.onAlert(alert, target ?? {});
      res.json({ alert_id: alert.alert_id, results });
    } catch (e) {
      next(e);
    }
  });

  // /events — alias used by tests to mimic the Kafka subscriber path.
  app.post('/events', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { alert, target } = req.body as { alert?: AlertSummary; target?: NotifyTarget };
      if (!alert) return res.status(400).json({ error: 'alert is required' });
      const results = await subscriber.onAlert(alert, target ?? {});
      res.json({ alert_id: alert.alert_id, results });
    } catch (e) {
      next(e);
    }
  });

  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });

  return { app, emailAdapter, smsAdapter, subscriber };
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 8083);
  const { app, emailAdapter, smsAdapter } = makeApp();
  // eslint-disable-next-line no-console
  app.listen(port, () =>
    // eslint-disable-next-line no-console
    console.log(
      `notification-svc listening on :${port} (email=${emailAdapter.name}, sms=${smsAdapter.name})`,
    ),
  );
}
