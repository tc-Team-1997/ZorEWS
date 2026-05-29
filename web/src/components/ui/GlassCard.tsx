import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * GlassCard — premium AI-native surface (P0 redesign).
 *
 * A floating glassmorphism container (soft blur, hairline ring, layered
 * indigo-tinted shadow) for the modernised login + executive + copilot
 * surfaces. Additive — operational screens keep `.card` until migrated.
 *
 * `elevated` bumps the shadow to the float treatment; `rise` plays the
 * soft entrance animation (respects prefers-reduced-motion via the CSS).
 */
export function GlassCard({
  children,
  className,
  elevated = false,
  rise = false,
  as: Tag = 'div',
  ...rest
}: {
  children: ReactNode;
  className?: string;
  elevated?: boolean;
  rise?: boolean;
  as?: 'div' | 'section' | 'article';
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag
      className={cn('glass-card', elevated && 'shadow-float', rise && 'aurora-rise', className)}
      {...rest}
    >
      {children}
    </Tag>
  );
}
