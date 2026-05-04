/**
 * Tiny math-CAPTCHA challenge store. Each call to `issue()` returns a
 * fresh challenge ("What is 7 + 4?") with a short TTL; `verify(id, n)`
 * is single-use (removes the entry whether the answer is right or wrong)
 * so a leaked id can't be replayed.
 *
 * Why prototype-friendly: zero external dependencies, no third-party
 * service keys. Production would swap to reCAPTCHA / hCaptcha — keep the
 * issue/verify shape identical so the route layer doesn't change.
 */

import { randomBytes, randomInt } from "node:crypto";

export interface CaptchaChallenge {
  id: string;
  question: string;
  /** ISO timestamp of expiry. */
  expires_at: string;
}

interface Entry {
  answer: number;
  expires_at_ms: number;
}

const TTL_MS = 5 * 60 * 1000; // 5 min — long enough for slow typers, short enough to limit replay

export class CaptchaStore {
  private byId = new Map<string, Entry>();
  constructor(private readonly nowFn: () => number = Date.now) {}

  issue(): CaptchaChallenge {
    const a = randomInt(1, 10);
    const b = randomInt(1, 10);
    const id = `cap-${randomBytes(8).toString("base64url")}`;
    const expires_at_ms = this.nowFn() + TTL_MS;
    this.byId.set(id, { answer: a + b, expires_at_ms });
    return {
      id,
      question: `What is ${a} + ${b}?`,
      expires_at: new Date(expires_at_ms).toISOString(),
    };
  }

  /**
   * Single-use verify. Returns true only when the id exists, hasn't
   * expired, and the supplied answer matches. Always removes the entry
   * after the call (even on miss) so the same id can't be retried.
   */
  verify(id: string, answer: number): boolean {
    const entry = this.byId.get(id);
    if (!entry) return false;
    this.byId.delete(id);
    if (entry.expires_at_ms < this.nowFn()) return false;
    return entry.answer === answer;
  }

  /** Test helper. */
  size(): number {
    return this.byId.size;
  }

  /** Test helper. */
  clear(): void {
    this.byId.clear();
  }
}

/**
 * Per-(IP+username) recent-failure counter. Independent of the rate
 * limiter — the rate limiter caps total request rate (legit user + bot
 * alike); this counter only triggers the captcha gate after 2 wrong
 * passwords from the same actor and resets on a successful login.
 */
export class FailureCounter {
  private counts = new Map<string, number>();

  bump(key: string): number {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }

  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  reset(key: string): void {
    this.counts.delete(key);
  }

  clear(): void {
    this.counts.clear();
  }
}

export const CAPTCHA_THRESHOLD = 2;
