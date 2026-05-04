import { useEffect, useRef, useState } from 'react';

/**
 * Idle-timeout hook for banking-grade session policy.
 *
 * After `idleMs` of no user activity, fires `onTimeout`. `warnBeforeMs`
 * before that, flips `warning` to true so the consumer can show a
 * "stay signed in?" modal. Any activity (mousemove, keydown, click,
 * scroll, touchstart) resets both timers.
 *
 * Why a hook instead of a global service: tied to component lifecycle —
 * mounts/unmounts cleanly with the AppShell, so a logged-out user (no
 * AppShell rendered) automatically has no listeners hanging around.
 *
 * The activity listener is throttled to once per second via a `ref` —
 * setTimeout reset is cheap but `clearTimeout`+`setTimeout` on every
 * mousemove is wasteful and can interfere with smooth UI.
 */
export interface IdleTimeoutOptions {
  idleMs: number;
  warnBeforeMs: number;
  onTimeout: () => void;
}

export interface IdleTimeoutState {
  /** True once the user enters the warning window. Resets to false on activity. */
  warning: boolean;
  /** Seconds remaining before timeout fires. 0 when not in warning state. */
  remainingSec: number;
  /** Manually reset the timer — useful for the "Stay signed in" button. */
  extend: () => void;
}

const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'] as const;
const THROTTLE_MS = 1000;

export function useIdleTimeout({ idleMs, warnBeforeMs, onTimeout }: IdleTimeoutOptions): IdleTimeoutState {
  const [warning, setWarning] = useState(false);
  const [remainingSec, setRemainingSec] = useState(0);
  const lastActivityRef = useRef(Date.now());
  const warnTimerRef = useRef<number | null>(null);
  const timeoutTimerRef = useRef<number | null>(null);
  const tickIntervalRef = useRef<number | null>(null);
  // scheduleTimers is closed over in the effect; expose via ref so the
  // returned `extend()` callback can re-trigger scheduling without going
  // back through the activity throttle.
  const scheduleRef = useRef<() => void>(() => {});
  // Stash the latest onTimeout in a ref so the effect doesn't re-run when
  // the parent passes a fresh function each render.
  const onTimeoutRef = useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  useEffect(() => {
    const clearAll = () => {
      if (warnTimerRef.current !== null) window.clearTimeout(warnTimerRef.current);
      if (timeoutTimerRef.current !== null) window.clearTimeout(timeoutTimerRef.current);
      if (tickIntervalRef.current !== null) window.clearInterval(tickIntervalRef.current);
      warnTimerRef.current = null;
      timeoutTimerRef.current = null;
      tickIntervalRef.current = null;
    };

    const scheduleTimers = () => {
      clearAll();
      const warnDelay = Math.max(0, idleMs - warnBeforeMs);
      warnTimerRef.current = window.setTimeout(() => {
        setWarning(true);
        setRemainingSec(Math.ceil(warnBeforeMs / 1000));
        // Tick the countdown each second so the modal shows live remaining.
        tickIntervalRef.current = window.setInterval(() => {
          const elapsed = Date.now() - lastActivityRef.current;
          const remaining = Math.max(0, Math.ceil((idleMs - elapsed) / 1000));
          setRemainingSec(remaining);
        }, 1000);
      }, warnDelay);
      timeoutTimerRef.current = window.setTimeout(() => {
        clearAll();
        setWarning(false);
        setRemainingSec(0);
        onTimeoutRef.current();
      }, idleMs);
    };
    scheduleRef.current = scheduleTimers;

    const onActivity = () => {
      const now = Date.now();
      // Throttle: ignore activity within THROTTLE_MS of the last reset.
      // Don't throttle while the warning is up — every interaction during
      // the warning window must reset the timers immediately, otherwise
      // a quick "Stay signed in" click followed by no further activity
      // would still time out at the original deadline.
      if (!warning && now - lastActivityRef.current < THROTTLE_MS) return;
      lastActivityRef.current = now;
      setWarning(false);
      setRemainingSec(0);
      scheduleTimers();
    };

    scheduleTimers();
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, onActivity, { passive: true });
    }
    return () => {
      clearAll();
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, onActivity);
      }
    };
  }, [idleMs, warnBeforeMs, warning]);

  const extend = () => {
    lastActivityRef.current = Date.now();
    setWarning(false);
    setRemainingSec(0);
    scheduleRef.current();
  };

  return { warning, remainingSec, extend };
}
