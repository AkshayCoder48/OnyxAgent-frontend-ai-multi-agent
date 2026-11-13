import type { ExpoConfig } from 'expo/config';

const basePath = process.env.EXPO_BASE_PATH ?? '';

const config: ExpoConfig = {
  name: 'OnyxAgent',
  slug: 'onyxagent',
  version: '2.4.0',
  scheme: 'onyxagent',
  userInterfaceStyle: 'dark',
  orientation: 'portrait',
  icon: './assets/icon.png',
  assetBundlePatterns: ['**/*'],
  ios: {
    bundleIdentifier: 'ai.onyxagent.app',
    supportsTablet: true,
  },
  android: {
    package: 'ai.onyxagent.app',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#0B0200',
    },
  },
  web: {
    bundler: 'metro',
    output: 'static',
    favicon: './assets/favicon.png',
    basePath,
  },
  plugins: [
    'expo-router',
    [
      'expo-splash-screen',
      {
        image: './assets/splash.png',
        imageWidth: 200,
        resizeMode: 'contain',
        backgroundColor: '#0B0200',
      },
    ],
  ],
  experiments: {
    typedRoutes: false,
  },
};

export default config;
