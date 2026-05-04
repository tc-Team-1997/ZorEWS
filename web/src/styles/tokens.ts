/**
 * Raw token values for code that needs hex strings (Recharts stroke/fill, etc.).
 * Mirrors tailwind.config.ts — keep them in sync.
 */
export const color = {
  navy:      '#0D2B6A',
  blue:      '#1565C0',
  blueHover: '#104a94',
  sky:       '#2196F3',
  skyLight:  '#E3EFFF',

  success:   '#1D9E75',
  successBg: '#E0F5EE',
  warning:   '#EF9F27',
  warningBg: '#FAF0DC',
  danger:    '#E24B4A',
  dangerBg:  '#FCEBEB',
  purple:    '#7F77DD',
  purpleBg:  '#EEEDFE',

  ink:     '#2C2C2A',
  inkSub:  '#5F5E5A',
  muted:   '#888780',
  border:  '#D3D1C7',
  divider: '#F1EFE8',
  surface: '#FFFFFF',
  page:    '#F1F4F8',
} as const;

export const chartPalette = [
  color.blue,
  color.success,
  color.warning,
  color.danger,
  color.purple,
  color.sky,
] as const;
