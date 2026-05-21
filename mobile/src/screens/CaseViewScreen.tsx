// mobile/src/screens/CaseViewScreen.tsx
//
// Single-case drill-through. Surfaces:
//   - Case header (state + outcome + assignee + customer + SLA badge)
//   - Investigation step checklist with tap-to-complete (M9.1)
//   - "Log visit" CTA → navigates to GpsCaptureScreen

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { colors, spacing, typography } from '../theme/tokens';
import type { CaseState, MobileCase } from '../types';
import type { CasesApi } from '../api/cases';
import type { InvestigationsApi, MobileInvestigation } from '../api/investigations';
import { ApiError } from '../api/client';

export interface CaseViewScreenProps {
  case_id: string;
  casesApi: CasesApi;
  investigationsApi: InvestigationsApi;
  onLogVisit: (caseId: string) => void;
}

const SEVERITY_BY_STATE: Record<CaseState, 'critical' | 'high' | 'medium' | 'low' | 'neutral'> = {
  open: 'medium',
  assigned: 'medium',
  in_action: 'high',
  monitored: 'low',
  closed: 'neutral' as never,
  reopened: 'high',
};

export function CaseViewScreen({
  case_id,
  casesApi,
  investigationsApi,
  onLogVisit,
}: CaseViewScreenProps) {
  const [caseRow, setCaseRow] = useState<MobileCase | null>(null);
  const [investigation, setInvestigation] = useState<MobileInvestigation | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [completing, setCompleting] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      setError(null);
      const c = await casesApi.get(case_id);
      setCaseRow(c);
      const inv = await investigationsApi.listByCase(case_id);
      setInvestigation(inv.items[0] ?? null);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Failed to load case');
    } finally {
      setLoading(false);
    }
  }, [case_id, casesApi, investigationsApi]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCompleteStep = useCallback(
    async (step_id: string) => {
      if (!investigation) return;
      setCompleting((prev) => new Set(prev).add(step_id));
      try {
        const updated = await investigationsApi.completeStep(
          investigation.investigation_id,
          step_id,
        );
        setInvestigation(updated);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Step completion failed');
      } finally {
        setCompleting((prev) => {
          const next = new Set(prev);
          next.delete(step_id);
          return next;
        });
      }
    },
    [investigation, investigationsApi],
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.brand_blue} />
      </View>
    );
  }

  if (!caseRow) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>{error ?? 'Case not found'}</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} testID="case-view-screen">
      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
      <Card>
        <View style={styles.headerRow}>
          <Badge label={caseRow.state} tone={SEVERITY_BY_STATE[caseRow.state] as never} />
          {caseRow.sla_status === 'breached' ? (
            <Badge label="SLA BREACHED" tone="critical" />
          ) : caseRow.sla_status === 'approaching' ? (
            <Badge label="SLA WARNING" tone="medium" />
          ) : null}
        </View>
        <Text style={styles.title}>{caseRow.customer.name}</Text>
        <Text style={styles.subtitle}>Case {caseRow.id}</Text>
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Assignee:</Text>
          <Text style={styles.metaValue}>{caseRow.assignee ?? 'unassigned'}</Text>
        </View>
        {caseRow.outcome ? (
          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>Outcome:</Text>
            <Text style={styles.metaValue}>{caseRow.outcome}</Text>
          </View>
        ) : null}
        {caseRow.loan_id ? (
          <View style={styles.metaRow}>
            <Text style={styles.metaLabel}>Loan:</Text>
            <Text style={styles.metaValue}>{caseRow.loan_id}</Text>
          </View>
        ) : null}
      </Card>

      <Button
        label="Log visit (with GPS)"
        onPress={() => onLogVisit(caseRow.id)}
        testID="log-visit-cta"
      />

      {investigation ? (
        <Card style={{ marginTop: spacing.md }}>
          <Text style={styles.sectionTitle}>Investigation</Text>
          <Text style={styles.investigationStatus}>
            Status: {investigation.status}
            {investigation.decision ? ` · Decision: ${investigation.decision}` : ''}
          </Text>
          {investigation.steps.map((step) => {
            const isCompleting = completing.has(step.step_id);
            return (
              <View key={step.step_id} style={styles.stepRow}>
                <View style={{ flex: 1 }}>
                  <Text
                    style={[
                      styles.stepName,
                      step.completed && { textDecorationLine: 'line-through', color: colors.ink_subtle },
                    ]}
                  >
                    {step.required ? '✱ ' : ''}{step.name}
                  </Text>
                  {step.completed && step.completed_at ? (
                    <Text style={styles.stepMeta}>
                      ✓ {step.completed_by} · {new Date(step.completed_at).toLocaleString()}
                    </Text>
                  ) : null}
                </View>
                {!step.completed ? (
                  <Button
                    label="Mark done"
                    variant="secondary"
                    onPress={() => onCompleteStep(step.step_id)}
                    loading={isCompleting}
                    testID={`complete-step-${step.step_id}`}
                  />
                ) : null}
              </View>
            );
          })}
        </Card>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface_alt, padding: spacing.md },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.md },
  title: { ...typography.title, color: colors.ink, marginBottom: spacing.xs },
  subtitle: { ...typography.caption, marginBottom: spacing.md },
  metaRow: { flexDirection: 'row', marginBottom: spacing.xs },
  metaLabel: { ...typography.caption, color: colors.ink_subtle, width: 80 },
  metaValue: { ...typography.body, color: colors.ink },
  sectionTitle: { ...typography.heading, color: colors.ink, marginBottom: spacing.sm },
  investigationStatus: { ...typography.caption, marginBottom: spacing.md, color: colors.brand_blue },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  stepName: { ...typography.body, color: colors.ink },
  stepMeta: { ...typography.caption, marginTop: 2 },
  errorBanner: {
    padding: spacing.md,
    backgroundColor: '#fee2e2',
    borderRadius: 8,
    marginBottom: spacing.md,
  },
  errorText: { ...typography.body, color: colors.danger },
  emptyText: { ...typography.body, color: colors.ink_subtle },
});
