# Native application integration examples

These are thin source adapters demonstrating the public SMART Flint API. The TypeScript package is the initial SDK; these examples establish native contract parity and are not yet independently released, production-tested Swift/Kotlin SDKs.

`swift/` is a dependency-free Swift package for iOS 15+ and macOS 12+. It includes `SMARTFlintWebAuthentication`, which presents `ASWebAuthenticationSession` with an explicitly supplied window. `android/SMARTFlintClient.kt` targets Android API 26+ and uses Android's built-in JSON and URL APIs. Run Android network methods off the UI thread.

Both adapters implement native-owned PKCE/state, EHR launch-ticket resumption, callback binding, code redemption, gateway access, direct upstream credentials, original token-response access, handoff, and session closure. Pending transactions expire and have bounded capacity. Both hold sessions and in-flight transactions in memory. Application termination requires a fresh launch unless the app adds protected transaction persistence.

## Run the launch UI examples

Create a SMART Flint application/installation with the exact native callback `org.smartflint.sample://callback` for these examples. Configure its required patient context and permitted access modes. EHR OAuth credentials remain on the server; the native app receives no confidential EHR client secret. Replace the example service origin and installation ID with the installation worksheet's values.

For iOS, create a UIKit iOS app in Xcode and add the local Swift package in `swift/`. Replace the template app entry point with `ios-app/AppDelegate.swift`, add its `Info.plist` URL type to the target, and remove the template scene manifest/scene delegate so this app-delegate example owns its window. Do not replace other required bundle metadata with the small plist fragment. Add the `SMARTFlintNativeExample` library product to the target. The included screen opens the Apple authorization browser, handles standalone/EHR launches, obtains an activation-bound FHIR connection, and disconnects. The sample retains its system-browser controller for the duration of sign-in. For a deployment requiring claimed HTTPS returns, use the appropriate platform APIs and verified associated-domain configuration; this compatibility example uses a reverse-domain custom scheme.

For Android, create a Kotlin Android app with minimum API 26. Copy both Kotlin files into the `org.smartflint.example` package and merge `android/AndroidManifest.xml` into the app manifest. Set the service URL and installation ID in `SMARTFlintLaunchActivity.kt`; keep its configured callback equal to the manifest scheme/host and SMART Flint callback. The sample uses an external system browser via `ACTION_VIEW`, a single-task callback Activity and a background network executor. It avoids embedded WebViews, plaintext persistence and token logging. The manifest disables cleartext traffic and backup. Its orientation setting preserves the demonstration's in-memory transaction during rotation; a production app should implement its complete lifecycle policy.

Both screens display only connection status and patient context. Give the resulting FHIR endpoint and authorization header to your preferred native FHIR client. Call the adapter's connection method for each request when using direct access so it retrieves current upstream credentials; a header returned earlier is a snapshot. Gateway mode is the default; direct access is available through the adapter's explicit option. An EHR launch ticket sent to the app's registered callback resumes through the same browser authorization flow.

## Compile checks and acceptance boundaries

```sh
node scripts/check-native.mjs --swift
node scripts/check-native.mjs --android
```

The Apple check requires macOS/Xcode and compiles the macOS package, iOS Simulator module, system-browser wrapper and UIKit sample. The Android check compiles both Kotlin files against an installed Android SDK platform; set `ANDROID_HOME` and `KOTLINC` (or `KOTLIN_HOME`) when necessary. On macOS it also recognizes Android Studio's bundled compiler. Running with no options requires both toolchains. Missing tools are errors rather than a silent successful skip.

These are source compilation checks. They do not launch an emulator/device, verify claimed HTTPS app-link ownership, install a signed application, or establish EHR/native interoperability. Complete a device browser/callback/cancellation/process-restart/disconnect acceptance pass with your own app registration before shipping a native application. Vendor/pathway testing remains separate from this packaging work.

Present authorization in the system browser (`ASWebAuthenticationSession` on Apple platforms or a Custom Tab on Android). Register associated HTTPS return links where available. Verify the app's callback association and bind each callback to its initiating transaction. The app-to-bridge handshake is independent of the bridge-to-EHR authorization transaction.

Use Keychain for sensitive persistent data on Apple platforms. On Android, use a Keystore-protected encryption key for app-private credential storage. Never bundle an upstream confidential-client secret in a native application. Avoid placing tokens in deep links, logs, crash reports, clipboard content, notifications, or preferences.

Gateway mode returns a base URL and the local session's bearer authorization value. Direct mode returns the original upstream URL and current upstream token; use an asynchronous credential hook with your preferred FHIR client to obtain fresh credentials when needed. Original credential responses contain an envelope with `tokenResponse`, `refreshOwner`, and `refreshTokenWithheld`; refresh tokens are withheld while SMART Flint owns renewal. Full handoff returns current refresh credentials when supported and requires a compatible upstream registration, especially for confidential-client refresh or proof-bound tokens.

For Android emulator testing, expose the bridge using an explicitly configured reachable development address and registered callback rather than assuming the emulator's `localhost` is the host Mac. Production endpoints require HTTPS. Do not add a broad cleartext or certificate-validation exception to ship an application.

References: [OAuth for Native Apps](https://www.rfc-editor.org/rfc/rfc8252.html) and [SMART launch security and client types](https://hl7.org/fhir/smart-app-launch/STU2.2/app-launch.html).
