// services/bff/src/routing_channel_coverage.ts
//
// T6 M8.9 — Alert routing channel transport coverage.
//
// Cross-module consistency validator. M8.2 declares NotificationChannel
// = 'email' | 'sms' | 'in_app' | 'push' and routing rules can fire on
// any of those. M10.1/M10.2/M10.3 ship the actual transports for
// email, SMS, push respectively — 'in_app' has no out-of-process
// transport (it's a SPA bell badge surfaced via the existing
// notifications bus, not a `<Channel>Transport`).
//
// M8.9 surfaces the gap: for each routing rule, mark whether every
// channel in its `channels[]` has a wired transport. Lets ops catch
// "I configured this rule to fire SMS but I haven't enabled the SMS
// transport for this tenant" gaps before going live.
//
// Pure — no I/O. Caller passes the routing rules (typically via
// `alertRoutingEngine.listRules(tenant)`).

import type { RoutingRule, NotificationChannel } from './alert_routing';

// ─── Public types ─────────────────────────────────────────────────────

/** Set of channels that have an out-of-process transport wired. The
 *  in_app channel is intentionally absent — it's an in-process SPA
 *  surface, not a Transport. */
export const WIRED_CHANNELS: ReadonlySet<NotificationChannel> = new Set<NotificationChannel>([
  'email',
  'sms',
  'push',
]);

export interface ChannelStatus {
  channel: NotificationChannel;
  wired: boolean;
}

export interface RoutingRuleCoverage {
  class: RoutingRule['class'];
  channels: ChannelStatus[];
  has_unwired_channel: boolean;
  /** When has_unwired_channel=true, the channels[] of the rule that
   *  lack a wired transport. Empty array when has_unwired_channel=false. */
  unwired_channels: NotificationChannel[];
}

export interface RoutingChannelCoverageReport {
  total_rules: number;
  fully_wired_count: number;
  partially_wired_count: number;
  /** True iff every rule has every channel wired. */
  all_wired: boolean;
  /** Rules that have at least one unwired channel. */
  rules_with_unwired_channels: RoutingRuleCoverage[];
  /** Union of all unwired channels across the rule set, sorted asc.
   *  Lets the SPA render "to fully service your routing, enable
   *  transports for: in_app". */
  distinct_unwired_channels: NotificationChannel[];
  rules: RoutingRuleCoverage[];
}

// ─── Pure validator ──────────────────────────────────────────────────

export function checkRoutingChannelCoverage(
  rules: readonly RoutingRule[],
): RoutingChannelCoverageReport {
  const out: RoutingRuleCoverage[] = [];
  const distinctUnwired = new Set<NotificationChannel>();
  let fully_wired_count = 0;
  let partially_wired_count = 0;

  for (const rule of rules) {
    const channels: ChannelStatus[] = rule.channels.map((c) => ({
      channel: c,
      wired: WIRED_CHANNELS.has(c),
    }));
    const unwired = channels.filter((c) => !c.wired).map((c) => c.channel);
    for (const u of unwired) distinctUnwired.add(u);
    const has_unwired_channel = unwired.length > 0;
    if (has_unwired_channel) partially_wired_count += 1;
    else fully_wired_count += 1;
    out.push({
      class: rule.class,
      channels,
      has_unwired_channel,
      unwired_channels: unwired,
    });
  }

  const rules_with_unwired_channels = out.filter((r) => r.has_unwired_channel);
  return {
    total_rules: rules.length,
    fully_wired_count,
    partially_wired_count,
    all_wired: partially_wired_count === 0,
    rules_with_unwired_channels,
    distinct_unwired_channels: [...distinctUnwired].sort(),
    rules: out,
  };
}
