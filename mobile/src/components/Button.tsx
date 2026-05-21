// mobile/src/components/Button.tsx

import React from 'react';
import { TouchableOpacity, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { colors, radii, spacing, typography } from '../theme/tokens';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  loading = false,
  disabled = false,
  testID,
}: ButtonProps) {
  const palette = {
    primary: { bg: colors.brand_blue, fg: '#ffffff' },
    secondary: { bg: colors.surface, fg: colors.brand_blue },
    danger: { bg: colors.danger, fg: '#ffffff' },
  }[variant];
  const isDisabled = disabled || loading;
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      disabled={isDisabled}
      style={[
        styles.button,
        {
          backgroundColor: palette.bg,
          opacity: isDisabled ? 0.6 : 1,
          borderColor: variant === 'secondary' ? colors.brand_blue : 'transparent',
          borderWidth: variant === 'secondary' ? 1 : 0,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={palette.fg} size="small" />
      ) : (
        <Text style={[styles.label, { color: palette.fg }]}>{label}</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  label: {
    ...typography.body,
    fontWeight: '600',
  },
});
