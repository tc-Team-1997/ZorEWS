// mobile/App.tsx
//
// Root navigator. Stitches the 3 production screens with a stack
// navigator. AppShell handles session hydration + the redirect-to-
// login flow.

import React, { useCallback, useEffect, useState } from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Text, View, ActivityIndicator, StyleSheet } from 'react-native';
import { AlertListScreen } from './src/screens/AlertListScreen';
import { CaseViewScreen } from './src/screens/CaseViewScreen';
import { GpsCaptureScreen } from './src/screens/GpsCaptureScreen';
import { buildApiClient } from './src/auth/interceptor';
import { SessionStore } from './src/auth/session';
import { AlertsApi } from './src/api/alerts';
import { CasesApi } from './src/api/cases';
import { InvestigationsApi } from './src/api/investigations';
import { colors, spacing, typography } from './src/theme/tokens';

export type RootStackParamList = {
  AlertList: undefined;
  CaseView: { case_id: string };
  GpsCapture: { case_id: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

const BFF_BASE_URL =
  // RN doesn't have process.env at runtime — Expo injects via app.config.ts
  // For the shell stub we default to localhost:8084 (matches `make up`).
  process.env.MOBILE_BFF_BASE_URL ?? 'http://localhost:8084';

export default function App() {
  const [hydrated, setHydrated] = useState<boolean>(false);
  const [hasSession, setHasSession] = useState<boolean>(false);

  useEffect(() => {
    (async () => {
      const s = await SessionStore.hydrate();
      setHasSession(s != null && !SessionStore.isExpired());
      setHydrated(true);
    })();
  }, []);

  const onUnauthorised = useCallback(() => {
    setHasSession(false);
  }, []);

  if (!hydrated) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.brand_blue} />
      </View>
    );
  }

  if (!hasSession) {
    // The login screen would live here in production — for this
    // shell we render an instruction card pointing at the SPA login
    // flow.
    return (
      <SafeAreaProvider>
        <View style={styles.centered}>
          <Text style={styles.title}>ZorEWS Mobile</Text>
          <Text style={styles.subtitle}>
            Please sign in from the web SPA and provision a mobile
            session token via the admin → service-clients page.
          </Text>
        </View>
      </SafeAreaProvider>
    );
  }

  const client = buildApiClient({ baseUrl: BFF_BASE_URL, onUnauthorised });
  const alertsApi = new AlertsApi(client);
  const casesApi = new CasesApi(client);
  const investigationsApi = new InvestigationsApi(client);

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <Stack.Navigator initialRouteName="AlertList">
          <Stack.Screen name="AlertList" options={{ title: 'Alerts' }}>
            {({ navigation }) => (
              <AlertListScreen
                api={alertsApi}
                onSelectCase={(case_id) => navigation.navigate('CaseView', { case_id })}
              />
            )}
          </Stack.Screen>
          <Stack.Screen name="CaseView" options={{ title: 'Case' }}>
            {({ route, navigation }) => (
              <CaseViewScreen
                case_id={route.params.case_id}
                casesApi={casesApi}
                investigationsApi={investigationsApi}
                onLogVisit={(case_id) => navigation.navigate('GpsCapture', { case_id })}
              />
            )}
          </Stack.Screen>
          <Stack.Screen name="GpsCapture" options={{ title: 'Log visit' }}>
            {({ route, navigation }) => (
              <GpsCaptureScreen
                case_id={route.params.case_id}
                casesApi={casesApi}
                onSuccess={() => navigation.goBack()}
              />
            )}
          </Stack.Screen>
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  title: { ...typography.title, color: colors.ink, marginBottom: spacing.md },
  subtitle: { ...typography.body, color: colors.ink_subtle, textAlign: 'center' },
});
