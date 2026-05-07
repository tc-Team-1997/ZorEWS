import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/index.css';

async function bootstrap() {
  // MSW is on by default in dev mode (offline UI demo). Set
  // VITE_USE_MSW=false in .env.development.local to talk to the real BFF
  // proxied by Vite (see vite.config.ts proxy).
  const useMsw = import.meta.env.DEV && import.meta.env.VITE_USE_MSW !== 'false';
  if (useMsw) {
    const { worker } = await import('./mocks/browser');
    await worker.start({ onUnhandledRequest: 'bypass' });
  }
  const container = document.getElementById('root');
  if (!container) throw new Error('Root container missing');
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
