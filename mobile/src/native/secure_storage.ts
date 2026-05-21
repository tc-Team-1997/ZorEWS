// mobile/src/native/secure_storage.ts
//
// Secure key/value bridge. Production: expo-secure-store (iOS
// Keychain / Android Keystore) or react-native-keychain. Stub:
// in-process Map for Jest tests.

const STUB_STORE = new Map<string, string>();

export const SecureStorage = {
  async read(key: string): Promise<string | null> {
    // Production: await SecureStore.getItemAsync(key);
    return STUB_STORE.get(key) ?? null;
  },
  async write(key: string, value: string): Promise<void> {
    // Production: await SecureStore.setItemAsync(key, value, { keychainAccessible: …, requireAuthentication: true });
    STUB_STORE.set(key, value);
  },
  async remove(key: string): Promise<void> {
    // Production: await SecureStore.deleteItemAsync(key);
    STUB_STORE.delete(key);
  },
  /** Test-only helper. */
  _clearStub(): void {
    STUB_STORE.clear();
  },
};
