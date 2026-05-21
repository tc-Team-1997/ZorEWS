// mobile/src/components/Badge.tsx
//
// Severity badge. Mirrors `web/src/components/ui/Badge.tsx`.

import React from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { colors, radii, spacing, typography, severityColor } from '../theme/tokens';

export interface BadgeProps {
  label: string;
  tone?: 'critical' | 'high' | 'medium' | 'low' | 'neutral';
}

export function Badge({ label, tone = 'neutral' }: BadgeProps) {
  const bg = tone === 'neutral' ? colors.divider : severityColor(tone);
  const fg = tone === 'neutral' ? colors.ink : '#ffffff';
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.label, { color: fg }]}>{label.toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.sm,
    alignSelf: 'flex-start',
  },
  label: {
    ...typography.caption,
    color: '#ffffff',
    fontWeight: '600',
    letterSpacing: 0.5,
  },
});
