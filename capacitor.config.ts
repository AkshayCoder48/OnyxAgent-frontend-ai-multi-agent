import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ai.onyxagent.app',
  appName: 'OnyxAgent',
  webDir: 'out',
  server: {
    // When building as a standalone APK, the web assets are bundled.
    // For development, you can set the androidScheme to 'https'.
    androidScheme: 'https',
  },
  android: {
    // Allow mixed content (http + https) for local dev
    allowMixedContent: true,
    // Enable webview debugging in dev
    webContentsDebuggingEnabled: true,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1000,
      backgroundColor: '#0d4029',
      showSpinner: false,
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0d4029',
    },
    Keyboard: {
      resize: 'body',
      style: 'DARK',
      resizeOnFullScreen: true,
    },
  },
};

export default config;
