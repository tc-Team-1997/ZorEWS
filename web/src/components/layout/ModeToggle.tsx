// web/src/components/layout/ModeToggle.tsx
//
// G1 — Bank / Insurance vertical mode pill (Monday Playbook H1).
// Lives in the AppShell header next to LanguageToggle.

import { Banknote, ShieldCheck } from 'lucide-react';
import { useVerticalMode, type VerticalMode } from '@/lib/useVerticalMode';
import { cn } from '@/lib/cn';

const OPTIONS: ReadonlyArray<{
  value: VerticalMode;
  label: string;
  Icon: typeof Banknote;
  activeBg: string;
  activeText: string;
}> = [
  { value: 'bank', label: 'BANK', Icon: Banknote, activeBg: 'bg-warning/15', activeText: 'text-warning' },
  { value: 'insurance', label: 'INSURANCE', Icon: ShieldCheck, activeBg: 'bg-action/15', activeText: 'text-action' },
];

export function ModeToggle() {
  const [mode, setMode] = useVerticalMode();
  return (
    <div
      role="radiogroup"
      aria-label="Vertical mode"
      className="inline-flex items-center rounded-input border border-divider bg-surface p-0.5"
      data-testid="mode-toggle"
    >
      {OPTIONS.map(({ value, label, Icon, activeBg, activeText }) => {
        const isActive = mode === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={isActive}
            data-testid={`mode-${value}`}
            data-active={isActive}
            onClick={() => setMode(value)}
            className={cn(
              'flex items-center gap-1 rounded-input px-2.5 py-1 text-[11px] font-medium transition-colors',
              isActive
                ? `${activeBg} ${activeText}`
                : 'text-muted hover:bg-divider/40 hover:text-ink',
            )}
          >
            <Icon size={12} strokeWidth={2} aria-hidden />
            {label}
          </button>
        );
      })}
    </div>
  );
}
