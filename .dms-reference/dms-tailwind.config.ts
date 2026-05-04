import type { Config } from 'tailwindcss';

/**
 * Token set mirrored from apex_core_cbs/apps/banking/tailwind.config.ts.
 * DO NOT add raw hex values to TSX — reference these tokens.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── Brand ────────────────────────────────────────────────
        brand: {
          navy:      '#0D2B6A',
          blue:      '#1565C0',
          blueHover: '#104a94',
          sky:       '#2196F3',
          skyLight:  '#E3EFFF',
        },

        // Sidebar + action aliases
        sidebar:         '#0D2B6A',
        'sidebar-hover': '#1A3B85',
        'sidebar-text':  '#A5C3EB',
        action:          '#1565C0',
        'action-hover':  '#104a94',
        'action-subtle': '#E3EFFF',

        // ── Semantic (DEFAULT + bg) ─────────────────────────────
        success: { DEFAULT: '#1D9E75', bg: '#E0F5EE' },
        warning: { DEFAULT: '#EF9F27', bg: '#FAF0DC' },
        danger:  { DEFAULT: '#E24B4A', bg: '#FCEBEB' },
        purple:  { DEFAULT: '#7F77DD', bg: '#EEEDFE' },

        // Legacy aliases kept for compatibility with apex-derived code
        ok:   { DEFAULT: '#1D9E75', bg: '#E0F5EE' },
        warn: { DEFAULT: '#EF9F27', bg: '#FAF0DC' },
        risk: { DEFAULT: '#E24B4A', bg: '#FCEBEB' },

        // ── Neutrals ────────────────────────────────────────────
        ink:            '#2C2C2A',
        'ink-sub':      '#5F5E5A',
        sub:            '#5F5E5A',
        muted:          '#888780',
        border:         '#D3D1C7',
        borderMed:      '#B9B7AE',
        divider:        '#F1EFE8',
        raised:         '#F7F6F2',
        surface:        '#FFFFFF',
        'surface-alt':  '#F7F6F2',
        page:           '#F1F4F8',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
      borderRadius: {
        card:  '12px',
        badge: '11px',
        input: '8px',
      },
      fontSize: {
        '2xs': ['10px', { lineHeight: '14px' }],
        xs:   ['11px', { lineHeight: '16px' }],
        sm:   ['12px', { lineHeight: '18px' }],
        base: ['13px', { lineHeight: '20px' }],
        md:   ['14px', { lineHeight: '22px' }],
        lg:   ['16px', { lineHeight: '24px' }],
        xl:   ['20px', { lineHeight: '28px' }],
        '2xl':['28px', { lineHeight: '36px' }],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgba(16, 24, 40, 0.04)',
      },
    },
  },
  plugins: [],
} satisfies Config;
