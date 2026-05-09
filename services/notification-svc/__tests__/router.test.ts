import { channelsFor, fanout } from '../src/router';
import type { Adapter, AlertSummary, SendInput, SendResult, WireSeverity } from '../src/types';

class RecorderAdapter implements Adapter {
  public sent: SendInput[] = [];
  constructor(public readonly channel: 'email' | 'sms', public readonly name = 'recorder') {}
  async send(input: SendInput): Promise<SendResult> {
    this.sent.push(input);
    return { channel: this.channel, ok: true, adapter: this.name, provider_message_id: 'rec-1' };
  }
}

function makeAlert(severity: WireSeverity, overrides: Partial<AlertSummary> = {}): AlertSummary {
  return {
    alert_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    customer_id: 'CUST0000001',
    severity,
    rule_id: 'RULE-014',
    reason_summary: 'Salary inflow stopped 60d',
    raised_at: '2026-04-26T08:00:00.000Z',
    pd: 0.42,
    risk_level: 'High',
    ...overrides,
  };
}

describe('severity → channel routing matrix (FR-ALERT-4)', () => {
  test('CRITICAL → SMS + Email', () => {
    expect(channelsFor('CRITICAL').sort()).toEqual(['email', 'sms']);
  });
  test('HIGH → Email only', () => {
    expect(channelsFor('HIGH')).toEqual(['email']);
  });
  test('MEDIUM → Email only', () => {
    expect(channelsFor('MEDIUM')).toEqual(['email']);
  });
  test('LOW → in-app only (no fan-out)', () => {
    expect(channelsFor('LOW')).toEqual([]);
  });
});

describe('fanout end-to-end', () => {
  test('CRITICAL hits both adapters with templated bodies', async () => {
    const email = new RecorderAdapter('email', 'rec-email');
    const sms = new RecorderAdapter('sms', 'rec-sms');
    const results = await fanout(
      { emailAdapter: email, smsAdapter: sms },
      {
        alert: makeAlert('CRITICAL'),
        target: { email: 'risk@example.com', phone: '+254700000000', display_name: 'Ravi' },
      },
    );

    expect(results).toHaveLength(2);
    expect(email.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(1);

    // Email subject mentions severity + rule
    expect(email.sent[0].message.subject).toContain('CRITICAL');
    expect(email.sent[0].message.subject).toContain('RULE-014');
    expect(email.sent[0].message.body).toContain('Ravi');
    expect(email.sent[0].message.body).toContain('Salary inflow stopped 60d');

    // SMS is bounded to 160 chars and is single-segment
    expect(sms.sent[0].message.body.length).toBeLessThanOrEqual(160);
    expect(sms.sent[0].message.body).toContain('[ZorEWS]');
    expect(sms.sent[0].message.body).toContain('CRITICAL');
  });

  test('MEDIUM hits email adapter only', async () => {
    const email = new RecorderAdapter('email');
    const sms = new RecorderAdapter('sms');
    await fanout(
      { emailAdapter: email, smsAdapter: sms },
      { alert: makeAlert('MEDIUM'), target: { email: 'risk@example.com' } },
    );
    expect(email.sent).toHaveLength(1);
    expect(sms.sent).toHaveLength(0);
  });

  test('LOW does not call any adapter', async () => {
    const email = new RecorderAdapter('email');
    const sms = new RecorderAdapter('sms');
    const results = await fanout(
      { emailAdapter: email, smsAdapter: sms },
      { alert: makeAlert('LOW'), target: {} },
    );
    expect(results).toEqual([]);
    expect(email.sent).toHaveLength(0);
    expect(sms.sent).toHaveLength(0);
  });

  test('SMS template substitutes ${alert.summary} and includes id', async () => {
    const email = new RecorderAdapter('email');
    const sms = new RecorderAdapter('sms');
    await fanout(
      { emailAdapter: email, smsAdapter: sms },
      {
        alert: makeAlert('CRITICAL', { reason_summary: 'Multi-bureau delinquency confirmed' }),
        target: { phone: '+254700000000' },
      },
    );
    expect(sms.sent[0].message.body).toContain('Multi-bureau delinquency');
    expect(sms.sent[0].message.body).toContain('id:');
  });
});
