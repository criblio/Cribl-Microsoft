// Type declarations for globals injected by the Cribl App Platform.
// These are set on window by the platform at runtime and are read-only.
// Declarations only: never define, assign, or polyfill them in app code,
// Vite config, or environment files (see AGENTS.md).

interface CriblUser {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  initials?: string;
}

declare global {
  interface Window {
    readonly CRIBL_API_URL: string;
    readonly CRIBL_BASE_PATH: string;
    readonly CRIBL_APP_ID?: string;
    readonly getCriblUser: () => Promise<CriblUser>;
    /**
     * Dev-only app version injected fresh into index.html on every load (the
     * dev server reloads when package.json changes, so live preview tracks the
     * current version instead of the frozen build-time define). Absent in the
     * built .tgz, where __APP_VERSION__ is authoritative.
     */
    readonly __APP_VERSION_RUNTIME__?: string;
  }
  /** Build-time app version from package.json (Vite define). */
  const __APP_VERSION__: string;
}

export {};
