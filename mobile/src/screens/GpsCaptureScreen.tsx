// mobile/src/screens/GpsCaptureScreen.tsx
//
// Field officer logs a geotagged visit against a case. Acquires
// GPS, captures outcome note, posts to /v1/action with kind=visit.

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { TextField } from '../components/TextField';
import { colors, spacing, typography } from '../theme/tokens';
import { Location, LocationDenied, LocationUnavailable } from '../native/location';
import type { CasesApi } from '../api/cases';
import type { MobileGpsCoords } from '../types';
import { ApiError } from '../api/client';
import { SessionStore } from '../auth/session';

export interface GpsCaptureScreenProps {
  case_id: string;
  casesApi: CasesApi;
  onSuccess: () => void;
}

export function GpsCaptureScreen({ case_id, casesApi, onSuccess }: GpsCaptureScreenProps) {
  const [coords, setCoords] = useState<MobileGpsCoords | null>(null);
  const [outcomeNote, setOutcomeNote] = useState<string>('');
  const [acquiringGps, setAcquiringGps] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const acquireGps = useCallback(async () => {
    setAcquiringGps(true);
    setGpsError(null);
    try {
      const granted = await Location.hasPermission();
      const ok = granted || (await Location.requestPermission());
      if (!ok) {
        setGpsError('Location permission denied');
        return;
      }
      const c = await Location.getCurrentPosition({
        desired_accuracy_m: 20,
        timeout_ms: 10_000,
      });
      setCoords(c);
    } catch (e) {
      if (e instanceof LocationDenied) {
        setGpsError('Location permission denied');
      } else if (e instanceof LocationUnavailable) {
        setGpsError('GPS unavailable — check device location services');
      } else {
        setGpsError(e instanceof Error ? e.message : 'GPS acquisition failed');
      }
    } finally {
      setAcquiringGps(false);
    }
  }, []);

  useEffect(() => {
    // Eagerly acquire — by the time the operator finishes the form
    // we should have a fix.
    void acquireGps();
  }, [acquireGps]);

  const onSubmit = useCallback(async () => {
    setValidationError(null);
    setSubmitError(null);
    const trimmed = outcomeNote.trim();
    if (trimmed.length === 0) {
      setValidationError('Outcome note is required');
      return;
    }
    if (trimmed.length > 2000) {
      setValidationError('Outcome note must be ≤ 2000 chars');
      return;
    }
    if (!coords) {
      setValidationError('GPS fix required — tap "Capture GPS"');
      return;
    }
    const officerId = SessionStore.current()?.username ?? null;
    if (!officerId) {
      setSubmitError('No active session — please log in again');
      return;
    }
    setSubmitting(true);
    try {
      await casesApi.logVisit(case_id, officerId, trimmed, coords);
      onSuccess();
    } catch (e) {
      setSubmitError(e instanceof ApiError ? `${e.code}: ${e.message}` : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  }, [outcomeNote, coords, case_id, casesApi, onSuccess]);

  return (
    <ScrollView style={styles.container} testID="gps-capture-screen">
      <Card>
        <Text style={styles.title}>Log visit</Text>
        <Text style={styles.subtitle}>Case {case_id}</Text>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Location</Text>
          {coords ? (
            <View style={styles.gpsBox}>
              <Text style={styles.gpsCoord}>
                {coords.lat.toFixed(6)}, {coords.lng.toFixed(6)}
              </Text>
              <Text style={styles.gpsAccuracy}>
                ±{coords.accuracy_m ?? '?'}m
              </Text>
            </View>
          ) : (
            <Text style={styles.gpsPlaceholder}>
              {acquiringGps ? 'Acquiring GPS…' : 'No fix yet'}
            </Text>
          )}
          {gpsError ? <Text style={styles.errorText}>{gpsError}</Text> : null}
          <Button
            label={coords ? 'Re-capture GPS' : 'Capture GPS'}
            onPress={acquireGps}
            loading={acquiringGps}
            variant="secondary"
            testID="capture-gps"
          />
        </View>

        <TextField
          label="Outcome note"
          value={outcomeNote}
          onChangeText={setOutcomeNote}
          multiline
          numberOfLines={4}
          placeholder="Describe what happened during this visit"
          error={validationError}
          testID="outcome-note"
        />

        {submitError ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{submitError}</Text>
          </View>
        ) : null}

        <Button
          label="Submit visit"
          onPress={onSubmit}
          loading={submitting}
          disabled={!coords}
          testID="submit-visit"
        />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface_alt, padding: spacing.md },
  title: { ...typography.title, color: colors.ink, marginBottom: spacing.xs },
  subtitle: { ...typography.caption, marginBottom: spacing.lg },
  section: { marginBottom: spacing.lg },
  sectionLabel: { ...typography.caption, color: colors.ink, marginBottom: spacing.xs, fontWeight: '500' },
  gpsBox: {
    backgroundColor: colors.surface_alt,
    padding: spacing.md,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.divider,
    marginBottom: spacing.sm,
  },
  gpsCoord: { ...typography.body, color: colors.ink, fontFamily: 'Courier' },
  gpsAccuracy: { ...typography.caption, marginTop: 2 },
  gpsPlaceholder: { ...typography.body, color: colors.ink_subtle, marginBottom: spacing.sm },
  errorBanner: {
    padding: spacing.md,
    backgroundColor: '#fee2e2',
    borderRadius: 8,
    marginBottom: spacing.md,
  },
  errorText: { ...typography.body, color: colors.danger, marginBottom: spacing.xs },
});
