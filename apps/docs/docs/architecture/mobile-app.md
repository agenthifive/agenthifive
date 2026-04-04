---
sidebar_position: 9
title: Mobile App
description: React Native mobile application for approval management and push notifications
---

# Mobile App

## Overview

The AgentHiFive mobile app (`@agenthifive/mobile`) is an enterprise feature that provides on-the-go access to the AgentHiFive platform. It is built with React Native via Expo and uses a **WebView-based hybrid architecture**: authentication happens natively, and the main application experience is delivered through a WebView that loads the web dashboard.

Key capabilities:

- **Push notifications** for approval requests, delivered via Expo's push service and Firebase Cloud Messaging.
- **Approve/deny actions** from mobile through the embedded WebView dashboard.
- **Activity monitoring** via the full web dashboard rendered inside the app.
- **Secure authentication** with native login (email/password and social OAuth) powered by Better Auth.

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | [Expo](https://expo.dev/) ~54.0, React Native 0.81 |
| Authentication | [Better Auth](https://www.better-auth.com/) + `@better-auth/expo` |
| Push notifications | `expo-notifications`, Firebase (Android via `google-services.json`) |
| Secure storage | `expo-secure-store` for session tokens |
| OAuth browser flow | `expo-web-browser` + `expo-linking` for deep link callbacks |
| App shell | `react-native-webview` to embed the web dashboard |
| Language | TypeScript ~5.9 |

## Architecture

The app follows a hybrid native/web pattern:

1. **Native login screen** (`src/LoginScreen.tsx`) handles authentication using the Better Auth client for email/password, and a manual OAuth flow (native fetch + expo-web-browser) for social providers (Google, Microsoft, Facebook).
2. **Session cookies** are stored in `expo-secure-store` and injected into the WebView before the page loads via `injectedJavaScriptBeforeContentLoaded`.
3. **WebView** (`App.tsx`) loads the web dashboard at the configured `APP_URL`. Navigation state changes are monitored to detect logout (redirect to `/login`) and trigger push token registration when the dashboard loads.
4. **Push token registration** happens by injecting JavaScript into the WebView that exchanges the session cookie for a JWT and calls the `/v1/push/subscribe` API endpoint.

### Source Structure

```
apps/mobile/
  App.tsx              # Root component — loading, login, and WebView screens
  app.json             # Expo configuration (bundle IDs, plugins, splash)
  eas.json             # EAS Build profiles (dev, integration, staging, production)
  index.ts             # Entry point
  src/
    LoginScreen.tsx    # Native login UI (social OAuth + email/password)
    auth.ts            # Better Auth client, session cookie management, social OAuth flow
    config.ts          # APP_URL configuration (env-driven)
    notifications.ts   # Push notification permissions, token acquisition, subscribe script
```

## Features

### Push Notifications

The app registers for push notifications on startup via `expo-notifications`. On Android, a dedicated notification channel named `approvals` is created with max importance, vibration, and badge support. When a notification is tapped, the app navigates the WebView to the URL specified in the notification data payload.

Foreground notifications are displayed with alerts, sounds, and badge updates.

### Authentication

Two sign-in methods are supported:

- **Email/password** -- Uses the Better Auth API client (`authClient.signIn.email`) directly. The `@better-auth/expo` plugin stores session cookies in `expo-secure-store` using the `agenthifive` URL scheme.
- **Social OAuth** (Google, Microsoft, Facebook) -- Uses a manual flow that bypasses `signIn.social()` to avoid known issues with the `@better-fetch` wrapper on Android. The flow is: POST to `/api/auth/sign-in/social` to get the authorization URL, open it via `expo-web-browser`, receive the callback with a `cookie` parameter via deep link, and store the session.

Social providers are controlled by `EXPO_PUBLIC_SOCIAL_GOOGLE`, `EXPO_PUBLIC_SOCIAL_MICROSOFT`, and `EXPO_PUBLIC_SOCIAL_FACEBOOK` environment variables.

### Logout Detection

The app monitors WebView navigation state. If the user was previously authenticated and the WebView navigates to `/login`, the app clears the stored session and returns to the native login screen.

## Building

Builds are managed through [EAS Build](https://docs.expo.dev/build/introduction/) with profiles defined in `eas.json`. A GitHub Actions workflow (`.github/workflows/mobile-build.yml`) provides a manual dispatch trigger.

### Build Profiles

| Profile | Distribution | `APP_URL` |
|---|---|---|
| `development` | internal | `http://localhost:3000` |
| `dev-remote` | internal | `https://ah5.agenthifive.it` |
| `integration` | internal | `https://app-integration.agenthifive.com` |
| `staging` | internal | `https://app-staging.agenthifive.com` |
| `production` | store | `https://app.agenthifive.com` |

### Running a Build

From the `apps/mobile` directory:

```bash
eas build --profile <profile> --platform <platform>
```

Where `<platform>` is `ios`, `android`, or `all`.

### CI/CD

The `Mobile Build` GitHub Actions workflow supports manual dispatch with two inputs:

- **profile** -- One of `dev-remote`, `integration`, `staging`, `production` (default: `integration`).
- **platform** -- One of `all`, `ios`, `android` (default: `android`).

The workflow installs dependencies with pnpm, sets up EAS via the `expo/expo-github-action@v8` action using an `EXPO_TOKEN` secret, and runs the build with `--non-interactive`.

## Push Notification Setup

### Token Registration

When the WebView loads the dashboard, the app injects JavaScript that registers the device's Expo push token with the API:

1. The injected script calls `POST /api/auth/token` (with the session cookie) to exchange the session for a JWT.
2. It then calls `POST /v1/push/subscribe` with the JWT in the `Authorization` header and a body containing:
   - `expoPushToken` -- The Expo push token (format: `ExponentPushToken[xxxxx]`).
   - `platform` -- `ios` or `android`.
   - `deviceName` -- Optional human-readable device name.

The API upserts the token -- if the same device switches accounts, the existing row is updated.

### Token Removal

On logout or app uninstall, tokens should be removed via:

```
DELETE /v1/push/subscribe
```

With a JSON body containing the `expoPushToken` to remove. The server verifies that the token belongs to the authenticated user before deleting.

### Firebase Configuration

Android push notifications require Firebase Cloud Messaging. The Expo config (`app.json`) references a `google-services.json` file for Android:

```json
"android": {
  "googleServicesFile": "./google-services.json"
}
```

This file must be present in the `apps/mobile` directory and contain valid Firebase project credentials. The `expo-notifications` plugin is configured in `app.json` with a custom notification icon and accent color (`#8BC98B`).

## Development

### Prerequisites

- Node.js 24+
- pnpm (workspace root)
- Expo CLI (`npx expo`)
- For device testing: Expo Go or a development client build

### Running Locally

From the repository root:

```bash
pnpm install
```

Then from `apps/mobile`:

```bash
# Start Metro bundler
npx expo start

# Platform-specific
npx expo start --ios
npx expo start --android
```

### APP_URL Configuration

The app connects to the web dashboard URL configured via the `EXPO_PUBLIC_APP_URL` environment variable. Defaults:

- **Android emulator**: `http://10.0.2.2:3000` (maps to host machine localhost)
- **iOS simulator**: `http://localhost:3000`

For non-standard emulators (e.g., MuMu), override the URL at startup:

```bash
EXPO_PUBLIC_APP_URL=http://<HOST_IP>:3000 npx expo start --dev-client
```

### Bundle Identifiers

- **iOS**: `com.agenthifive.app`
- **Android**: `com.agenthifive.app`
