import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import { SUPPORTED_LANGS, type LangCode } from '@/lib/i18n';

/**
 * Compact language switcher for the AppShell header. Reads from i18n's
 * own state, writes back via i18n.changeLanguage — i18next-browser-language
 * detector persists the choice to localStorage.
 *
 * Visual style mirrors the header's other muted-text controls; deliberate
 * <select> over a custom dropdown so screen-reader + mobile UX is native.
 */
export function LanguageToggle() {
  const { i18n, t } = useTranslation();
  const current = (i18n.resolvedLanguage ?? i18n.language ?? 'en') as LangCode;

  return (
    <label className="flex items-center gap-1 text-xs text-muted">
      <Globe size={14} className="text-muted" strokeWidth={1.75} aria-hidden="true" />
      <span className="sr-only">{t('common.language')}</span>
      <select
        value={current}
        onChange={(e) => void i18n.changeLanguage(e.target.value)}
        data-testid="language-toggle"
        aria-label={t('common.language')}
        className="bg-transparent text-ink-sub text-xs px-1 py-0.5 rounded focus:outline-none focus:ring-2 focus:ring-action/40"
      >
        {SUPPORTED_LANGS.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}
