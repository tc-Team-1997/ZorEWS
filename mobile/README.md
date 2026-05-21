# ZorEWS Mobile — React Native Shell

**Status:** Phase T4.3 — enterprise-mobile architecture shell.

Mobile companion to the ZorEWS web SPA. Targets field officers + case
investigators who need to act on alerts on the go (call/visit + GPS
capture).

## Scope (this phase)

- React Native + TypeScript shell with scalable navigation
- 3 production-grade screens reusing existing `/v1/*` BFF endpoints:
  - **Alert List** — newest-first, filterable by severity + status,
    pull-to-refresh, optimistic ack
  - **Case View** — single-case drill-through (state machine + actions
    + investigation step checklist + linked alert)
  - **GPS Capture** — field officer logs a visit / call / inspection
    against a case with location + outcome + free-text notes
- Shared API client reusing the envelope contract from T4.24
- JWT-bearer or API-key auth via M1.2/M1.3 (no new auth surface)
- Native bridge stubs for: GPS (`mobile/src/native/location.ts`),
  biometric unlock (`mobile/src/native/biometric.ts`), secure storage
  (`mobile/src/native/secure_storage.ts`)
- Theme + design tokens mirroring `DMS_Network` reference

## Out of scope (deferred to Year-2 follow-on tickets)

- App Store / Play Store release pipeline (Theme F)
- Push notification client (server side is M10.3 — FCM/APNS;
  client-side wiring lands here in a follow-on)
- Offline mode + sync queue
- Native module wiring (this commit ships the TypeScript
  contract + stubs; a native engineer wires `@react-native-community/
  geolocation` etc.)

## Layout

```
mobile/
├── README.md                # this file
├── package.json             # RN + TypeScript dependencies (not installed
│                            #   in CI — RN toolchain runs outside the BFF
│                            #   workspace)
├── tsconfig.json
├── app.config.ts            # Expo-style config (env injection)
├── App.tsx                  # root navigator
└── src/
    ├── api/                 # shared API client (envelope-aware)
    │   ├── client.ts
    │   ├── alerts.ts
    │   ├── cases.ts
    │   └── investigations.ts
    ├── auth/                # JWT + API-key handling
    │   ├── session.ts
    │   └── interceptor.ts
    ├── components/          # design-system primitives
    │   ├── Badge.tsx
    │   ├── Button.tsx
    │   ├── Card.tsx
    │   └── TextField.tsx
    ├── native/              # platform bridges (stubs)
    │   ├── location.ts
    │   ├── biometric.ts
    │   └── secure_storage.ts
    ├── screens/             # 3 main views
    │   ├── AlertListScreen.tsx
    │   ├── CaseViewScreen.tsx
    │   └── GpsCaptureScreen.tsx
    ├── theme/               # tokens + dark/light palette
    │   └── tokens.ts
    └── types.ts             # shared response shapes (mirror BFF)
```

## Build / Run (operator)

This shell is **not yet hooked into the top-level Makefile** — RN
toolchain lives outside the BFF workspace to keep `make ci` lean.
Engineer install path:

```bash
cd mobile
npm install
# iOS
npx expo run:ios          # or:  npx react-native run-ios
# Android
npx expo run:android      # or:  npx react-native run-android
```

Set `MOBILE_BFF_BASE_URL` to point at the running BFF (default
`http://localhost:8084` matches `make up`).

## Auth flow

1. Operator signs in on the login screen → calls `POST /oauth/token`
   (client_credentials) OR `POST /auth/login` (TOTP) per M1.1.
2. Access token stored in **secure storage** (Keychain on iOS,
   Keystore on Android via `mobile/src/native/secure_storage.ts`).
3. Every API request goes through `interceptor.ts` which injects:
   - `Authorization: Bearer <token>` (M1.3 verifies)
   - `X-Tenant-ID` (resolved from JWT claim — defense-in-depth)
   - `X-Channel: MOBILE` (vs the SPA's `API`)
   - `X-APEX-USER` (the signed-in operator)
4. 401 → clear session + redirect to login.

## Why a separate workspace

- RN toolchain has heavy native dependencies (CocoaPods on iOS,
  Gradle on Android) that we don't want polluting the BFF
  `node_modules`.
- CI gates (BFF jest + tsc + vitest) are not blocked on the mobile
  shell — Year-2 Theme F lands the App-Store CI pipeline.

## Test coverage

The shell ships:

- Type-safe API client tests at `mobile/__tests__/` (mocked fetch).
- Snapshot tests for the 3 screens.

Runs via `jest` inside the `mobile/` workspace. Not part of the BFF
test suite count.
