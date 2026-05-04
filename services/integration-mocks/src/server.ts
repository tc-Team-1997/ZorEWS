// services/integration-mocks/src/server.ts
//
// Single Express app hosting all four upstream mocks on one port. Each
// router applies its own chaos profile (latency + error injection). The
// /healthz endpoint always responds without chaos so probes can tell the
// mock-server is up even when individual upstream profiles are degraded.

import express from 'express';
import { cbsRouter } from './cbs';
import { amlRouter } from './aml';
import { ifrs9Router } from './ifrs9';
import { collectionRouter } from './collection';
import { profileFor } from './chaos';

export function buildServer() {
  const app = express();
  app.use(express.json({ limit: '512kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      upstreams: {
        cbs: profileFor('cbs'),
        aml: profileFor('aml'),
        ifrs9: profileFor('ifrs9'),
        collection: profileFor('collection'),
      },
    });
  });

  app.use(cbsRouter());
  app.use(amlRouter());
  app.use(ifrs9Router());
  app.use(collectionRouter());

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 8091);
  const app = buildServer();
  // eslint-disable-next-line no-console
  app.listen(port, () => console.log(`integration-mocks listening on :${port}`));
}
