import { useEffect } from 'react';
import { useChat, type ChatContext } from '@/store/chat';

/**
 * Pages call this in render so the floating ChatWidget can ask context-aware
 * questions ("what is this customer's PD?", "summarise this case"). On unmount
 * the context is cleared back to `unknown` so a stale entity doesn't leak.
 */
export function useChatContext(ctx: ChatContext): void {
  const setContext = useChat((s) => s.setContext);

  useEffect(() => {
    setContext(ctx);
    return () => setContext({ page: 'unknown' });
    // The caller is expected to memoise ctx if needed; we only re-publish when
    // page / entity identity / fact-snapshot changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.page, ctx.entity?.type, ctx.entity?.id, JSON.stringify(ctx.entity?.facts ?? null)]);
}
