// services/notification-svc/src/adapters/africas_talking.ts
//
// AfricasTalkingAdapter — sends SMS via the AT REST API.
// Falls back to LoggingAdapter when AT_API_KEY (or AT_USERNAME) is unset.
//
// NEVER inline credentials: env-only, IRSA / Vault sync upstream.
// Constructor accepts an injected fetch for tests.

import { LoggingAdapter } from './logging';
import type { Adapter, SendInput, SendResult } from '../types';

export interface AfricasTalkingOptions {
  username: string;
  apiKey: string;
  /** Sender id or short code; AT requires registration. */
  from?: string;
  /** Default endpoint is the live REST URL; sandbox URL if AT_USE_SANDBOX=1. */
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Optional default recipient phone number. */
  defaultTo?: string;
}

const DEFAULT_LIVE = 'https://api.africastalking.com/version1/messaging';
const DEFAULT_SANDBOX = 'https://api.sandbox.africastalking.com/version1/messaging';

export class AfricasTalkingAdapter implements Adapter {
  public readonly channel = 'sms' as const;
  public readonly name = 'africas-talking';
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: AfricasTalkingOptions) {
    this.endpoint = opts.endpoint ?? DEFAULT_LIVE;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  async send(input: SendInput): Promise<SendResult> {
    const to = input.target.phone ?? this.opts.defaultTo;
    if (!to) {
      return {
        channel: 'sms',
        ok: false,
        adapter: this.name,
        error: 'no recipient phone',
      };
    }
    // 160-char hard limit (single SMS) — long ones get truncated.
    const body = input.message.body.slice(0, 160);
    const params = new URLSearchParams({
      username: this.opts.username,
      to,
      message: body,
    });
    if (this.opts.from) params.set('from', this.opts.from);

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const r = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          apiKey: this.opts.apiKey,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
        signal: controller.signal,
      });
      const json: unknown = await r.json().catch(() => ({}));
      const recipients =
        (json as { SMSMessageData?: { Recipients?: Array<{ messageId?: string; status?: string }> } })
          .SMSMessageData?.Recipients ?? [];
      const first = recipients[0];
      const ok = r.ok && first?.status === 'Success';
      return {
        channel: 'sms',
        ok,
        adapter: this.name,
        provider_message_id: first?.messageId,
        error: ok ? undefined : (first?.status ?? `http ${r.status}`),
      };
    } catch (e) {
      return {
        channel: 'sms',
        ok: false,
        adapter: this.name,
        error: (e as Error).message,
      };
    } finally {
      clearTimeout(t);
    }
  }
}

/** Pick the right SMS adapter for the current environment. */
export function makeSmsAdapter(env: NodeJS.ProcessEnv, outboxDir: string): Adapter {
  const apiKey = env.AT_API_KEY;
  const username = env.AT_USERNAME;
  if (!apiKey || !username) {
    return new LoggingAdapter('sms', outboxDir);
  }
  const useSandbox = env.AT_USE_SANDBOX === '1';
  return new AfricasTalkingAdapter({
    username,
    apiKey,
    from: env.AT_FROM,
    defaultTo: env.AT_DEFAULT_TO,
    endpoint: useSandbox ? DEFAULT_SANDBOX : DEFAULT_LIVE,
  });
}
