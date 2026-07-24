# OnyxAgent — Capacitor Android APK Build Guide

This guide explains how to build the OnyxAgent web app into an Android APK using Capacitor.

## Prerequisites

1. **Node.js 18+** and **npm/bun**
2. **Android Studio** (with Android SDK)
3. **Java JDK 17+**

## Setup

### 1. Install Capacitor dependencies

```bash
cd /home/z/my-project
bun add @capacitor/core @capacitor/cli @capacitor/android @capacitor/status-bar @capacitor/splash-screen @capacitor/keyboard
```

### 2. Build the web app

```bash
bun run build
```

This creates the `.next/` directory. For Capacitor, we need static output:

```bash
# Add static export to next.config.ts:
# output: 'export'
# Then rebuild
bun run build
```

### 3. Add the Android platform

```bash
npx cap add android
```

### 4. Sync the web assets

```bash
npx cap sync android
```

### 5. Open in Android Studio

```bash
npx cap open android
```

### 6. Build the APK

In Android Studio:
1. Wait for Gradle sync to complete
2. Go to **Build → Build Bundle(s) / APK(s) → Build APK(s)**
3. The APK will be at `android/app/build/outputs/apk/debug/app-debug.apk`

### 7. Install on device

```bash
adb install android/app/build/outputs/apk/debug/app-debug.apk
```

## Configuration

The Capacitor config is at `capacitor.config.ts` in the project root.

Key settings:
- `appId`: `ai.onyxagent.app` — the Android package name
- `appName`: `OnyxAgent` — the app name shown on the home screen
- `webDir`: `out` — where the static web assets are (after `next build` with `output: 'export'`)
- `StatusBar`: Dark style with green background
- `SplashScreen`: 1 second display with green background
- `Keyboard`: Resize body when keyboard appears

## Notes

- The app uses OPFS (Origin Private File System) for local storage, which works inside the Capacitor WebView
- The E2B sandbox API calls go through the Next.js API routes — for the APK build, these need to be changed to direct HTTPS calls or a backend server
- The app is fully functional as a PWA (Progressive Web App) — users can "Add to Home Screen" from the browser without needing an APK

## PWA Alternative

If you don't want to build an APK, the app is already a PWA:
1. Visit https://my-project-livid-zeta-99.vercel.app on your phone
2. Tap the browser menu → "Add to Home Screen"
3. The app installs as a standalone app with its own icon
4. It runs in full-screen mode like a native app
