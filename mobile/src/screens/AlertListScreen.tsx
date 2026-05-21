// mobile/src/screens/AlertListScreen.tsx
//
// Field-officer alert feed. Severity filter chip strip + pull-to-
// refresh + tap-to-ack with optimistic UI.

import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  RefreshControl,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { colors, radii, spacing, typography } from '../theme/tokens';
import type { AlertSeverity, MobileAlert } from '../types';
import { AlertsApi, type AlertListResponse } from '../api/alerts';
import { ApiError } from '../api/client';

export interface AlertListScreenProps {
  api: AlertsApi;
  /** Navigation callback — implemented by the host navigator. */
  onSelectCase?: (caseId: string) => void;
}

const SEVERITY_FILTERS: ReadonlyArray<AlertSeverity | 'all'> = [
  'all',
  'critical',
  'high',
  'medium',
  'low',
];

export function AlertListScreen({ api, onSelectCase }: AlertListScreenProps) {
  const [items, setItems] = useState<MobileAlert[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<AlertSeverity | 'all'>('all');
  const [acking, setAcking] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      setError(null);
      const res: AlertListResponse = await api.list({
        severity: filter === 'all' ? undefined : filter,
        sort: 'criticality',
        dedup: true,
        limit: 100,
      });
      setItems(res.items);
    } catch (e) {
      const msg = e instanceof ApiError ? `${e.code}: ${e.message}` : 'Failed to load alerts';
      setError(msg);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api, filter]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void load();
  }, [load]);

  const onAck = useCallback(
    async (alert: MobileAlert) => {
      setAcking((prev) => new Set(prev).add(alert.id));
      try {
        await api.acknowledge(alert.id);
        // Optimistic local update — remove the alert from the list.
        setItems((prev) => prev.filter((a) => a.id !== alert.id));
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Ack failed');
      } finally {
        setAcking((prev) => {
          const next = new Set(prev);
          next.delete(alert.id);
          return next;
        });
      }
    },
    [api],
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.brand_blue} />
      </View>
    );
  }

  return (
    <View style={styles.container} testID="alert-list-screen">
      <View style={styles.filterRow}>
        {SEVERITY_FILTERS.map((sev) => {
          const active = filter === sev;
          return (
            <TouchableOpacity
              key={sev}
              testID={`filter-${sev}`}
              onPress={() => setFilter(sev)}
              style={[
                styles.filterChip,
                active && { backgroundColor: colors.brand_blue, borderColor: colors.brand_blue },
              ]}
            >
              <Text
                style={[
                  styles.filterChipLabel,
                  active && { color: '#ffffff' },
                ]}
              >
                {sev}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {error ? (
        <View style={styles.errorBanner} testID="alert-list-error">
          <Text style={styles.errorText}>{error}</Text>
          <Button label="Retry" variant="secondary" onPress={onRefresh} />
        </View>
      ) : null}
      <FlatList
        data={items}
        keyExtractor={(a) => a.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No alerts under current filter</Text>
          </View>
        }
        renderItem={({ item }) => (
          <Card>
            <View style={styles.cardHeader}>
              <Badge label={item.severity} tone={item.severity} />
              <Text style={styles.age}>{item.age_min}m ago</Text>
            </View>
            <Text style={styles.customerName}>{item.customer.name}</Text>
            <Text style={styles.ruleName}>{item.rule.name}</Text>
            {item.indicators.length > 0 ? (
              <Text style={styles.indicators}>{item.indicators.slice(0, 3).join(' · ')}</Text>
            ) : null}
            <View style={styles.cardActions}>
              <Button
                label="Acknowledge"
                onPress={() => onAck(item)}
                loading={acking.has(item.id)}
                testID={`ack-${item.id}`}
              />
              {onSelectCase && (
                <Button
                  label="View case"
                  variant="secondary"
                  onPress={() => onSelectCase(item.id)}
                />
              )}
            </View>
          </Card>
        )}
        contentContainerStyle={items.length === 0 ? styles.flatlistEmpty : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface_alt, padding: spacing.md },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.divider,
    backgroundColor: colors.surface,
    marginRight: spacing.xs,
  },
  filterChipLabel: { ...typography.caption, color: colors.ink, fontWeight: '500' },
  errorBanner: {
    padding: spacing.md,
    backgroundColor: '#fee2e2',
    borderRadius: radii.md,
    marginBottom: spacing.md,
  },
  errorText: { ...typography.body, color: colors.danger, marginBottom: spacing.sm },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  age: { ...typography.caption },
  customerName: { ...typography.heading, color: colors.ink, marginBottom: spacing.xs },
  ruleName: { ...typography.body, color: colors.ink_subtle, marginBottom: spacing.xs },
  indicators: { ...typography.caption, color: colors.brand_blue, marginBottom: spacing.md },
  cardActions: { flexDirection: 'row', gap: spacing.sm },
  empty: { padding: spacing.xl, alignItems: 'center' },
  emptyText: { ...typography.body, color: colors.ink_subtle },
  flatlistEmpty: { flex: 1 },
});
