// services/notification-svc/src/adapters/ses.ts
//
// SESAdapter — sends transactional email via AWS SES v2.
// Falls back to LoggingAdapter when AWS_REGION is unset (i.e. dev / no creds).
//
// We deliberately do NOT pass any AWS credentials in code: the SDK's default
// credential chain (IRSA on EKS, env vars locally) is the only source.
// Constructor accepts an injected client for tests.

import type { SendEmailCommandInput } from '@aws-sdk/client-sesv2';
import { LoggingAdapter } from './logging';
import type { Adapter, SendInput, SendResult } from '../types';

export interface SESAdapterOptions {
  region: string;
  /** Verified SES sender, e.g. 'ews-alerts@apex-ews.example.com'. */
  fromAddress: string;
  /** Optional default recipient — used if SendInput.target.email is missing. */
  defaultTo?: string;
  /** Inject for tests (must implement SESv2Client.send). */
  client?: { send(cmd: { input: SendEmailCommandInput }): Promise<{ MessageId?: string }> };
}

/** Lazy import so unit tests don't require the SDK to be installed. */
async function makeSesClient(region: string): Promise<{
  send(cmd: { input: SendEmailCommandInput }): Promise<{ MessageId?: string }>;
}> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SESv2Client } = require('@aws-sdk/client-sesv2');
  return new SESv2Client({ region });
}

export class SESAdapter implements Adapter {
  public readonly channel = 'email' as const;
  public readonly name = 'ses';

  constructor(private readonly opts: SESAdapterOptions) {}

  async send(input: SendInput): Promise<SendResult> {
    const to = input.target.email ?? this.opts.defaultTo;
    if (!to) {
      return {
        channel: 'email',
        ok: false,
        adapter: this.name,
        error: 'no recipient email',
      };
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { SendEmailCommand } = require('@aws-sdk/client-sesv2');
      const client = this.opts.client ?? (await makeSesClient(this.opts.region));
      const cmd: { input: SendEmailCommandInput } = new SendEmailCommand({
        FromEmailAddress: this.opts.fromAddress,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: input.message.subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: input.message.body, Charset: 'UTF-8' },
            },
          },
        },
      });
      const r = await client.send(cmd);
      return {
        channel: 'email',
        ok: true,
        adapter: this.name,
        provider_message_id: r.MessageId,
      };
    } catch (e) {
      return {
        channel: 'email',
        ok: false,
        adapter: this.name,
        error: (e as Error).message,
      };
    }
  }
}

/**
 * Pick the right email adapter for the current environment.
 * AWS_REGION absent → LoggingAdapter; the prototype must work without creds.
 */
export function makeEmailAdapter(env: NodeJS.ProcessEnv, outboxDir: string): Adapter {
  const region = env.AWS_REGION;
  const from = env.APEX_SES_FROM ?? 'ews-alerts@apex-ews.example.com';
  if (!region) {
    return new LoggingAdapter('email', outboxDir);
  }
  return new SESAdapter({
    region,
    fromAddress: from,
    defaultTo: env.APEX_SES_DEFAULT_TO,
  });
}
