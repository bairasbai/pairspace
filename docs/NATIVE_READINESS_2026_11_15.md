# Native readiness after accepted prediction mobile91517f2

## Scope and observed checks

The accepted source is91517f2994bab80b1002978e0007fca0fb34d2f5.
Its author and independent FULL runs each passed11/11; independent mobile2696/2696
and PostgreSQL434/434. These are synthetic-loopback/JS checks, not device checks.

In an isolated cloud worktree, with the already installed Expo58.0.23 and bundled
local template, the following completed without downloads or dependency installs:

- `CI=1 EXPO_OFFLINE=1 node node_modules/expo/bin/cli config --type introspect --json`
- `CI=1 EXPO_OFFLINE=1 node node_modules/expo/bin/cli prebuild --no-install --platform android`
- `CI=1 EXPO_OFFLINE=1 node node_modules/expo/bin/cli prebuild --no-install --platform ios`

Both native project generations succeeded. No Gradle compilation, CocoaPods
installation, APK/IPA, emulator, simulator or physical-device test was performed.
Prebuild generated temporary `com.anonymous.pairspacepreview` identifiers; these
were not adopted as product identifiers. Generated directories/config were moved
outside the worktree, and tracked app configuration was restored byte-for-byte.
One early local command used an incorrect dependency-copy path, then help ran
before copying finished; these setup failures were retained, corrected, and do not
represent native build failures. Successful prebuild logs are retained separately.

## Concrete blockers

- Cloud Linux has Java21, but no Android SDK/NDK, adb or emulator was found.
  No /dev/kvm acceleration device is exposed. No Gradle cache was found.
- No macOS/Xcode/xcodebuild or iOS simulator is available. The only other listed
  computer is an offline Windows desktop; project rules forbid using owner devices.
- Accepted app.json lacks explicitly chosen Android package/iOS bundle IDs.
  Expo's anonymous defaults are diagnostic only, not store registrations.
- Default App remains disconnected. A synthetic SessionController must be injected
  into PairspaceApp by a dedicated development/test harness. Merely compiling App
  does not make the prediction API reachable in the normal preview.
- Auth configuration intentionally accepts HTTP localhost/127.0.0.1/[::1] only.
  LAN IPs, Android10.0.2.2, public tunnels and production URLs are rejected. Do not
  broaden this allowlist merely to make a device demo work.
- Android prebuild warned that userInterfaceStyle requires expo-system-ui. No new
  dependency was silently added. Device appearance remains unverified.
- Generated Android manifest includes Expo/template permissions such as legacy
  external storage and overlay. Their necessity requires review before release;
  no permission prompt was accepted and this is not a production configuration.

## Next bounded sequence

1. Choose explicit preview identifiers and add a development-only entry harness
   with synthetic data, explicit controller injection and fail-closed configuration.
   Keep normal preview disconnected and production networking disabled.
2. Provision an approved cloud Android SDK/build toolchain. Validate the exact
   installed Expo/React Native requirements before choosing SDK/NDK versions.
   Do not assume a successful JS export or prebuild satisfies this step.
3. For an Android debug-only fixture, investigate adb reverse against a loopback
   fixture on the same cloud host. Verify cookie/session transport and cleartext
   behaviour without relaxing release networking. No such tunnel was created here.
4. Compile/debug/install on an approved emulator; run RU/EN calendar input,
   accessibility, offline/retry, repeated taps, close-during-open, logout/pair
   changes and private-body lifecycle cases. Record actual device/runtime versions.
5. Use an approved macOS build host for iOS/CocoaPods/Xcode and equivalent tests.
   Two-device E2E and production review remain separate gates.

No cloud build account was created, no paid build started, no store submission or
signing credentials requested. No accepted application source or main was changed.

References: Expo [local development](https://docs.expo.dev/guides/local-app-development/),
[continuous native generation](https://docs.expo.dev/workflow/continuous-native-generation/),
[local build prerequisites](https://docs.expo.dev/build-reference/local-builds/).

## SDK provisioning follow-up

The official Google Android repository responded HTTP200 from this cloud host.
Network access to that endpoint is therefore not currently a demonstrated blocker.
The official command-line download requires the Android SDK License Agreement;
no SDK package or license was installed/accepted during this diagnostic. Other
Gradle/Maven dependencies and the required package versions are not yet verified.
See [Android tools](https://developer.android.com/studio/) and
[sdkmanager](https://developer.android.com/tools/sdkmanager).

Installed React Native catalog declares compileSdk37, buildTools37.0.0, minSdk24,
targetSdk36, NDK27.1.12297006 and AGP9.2.1. Generated wrapper declares Gradle9.4.1.
These are observed inputs, not proof that every artifact resolves or builds.
Generated Android debug manifest allows cleartext; iOS plist permits local
networking but rejects arbitrary loads. Release policy was not broadened.

## Explicit synthetic native harness

`apps/mobile/src/dev/synthetic-native-entry.tsx` now exports
`startSyntheticNativeHarness(config)`. Importing it does not create a runtime.
It rejects release builds, web and non-loopback origins; freezes the supplied
origin; injects the existing runtime into PairspaceApp with chat journal disabled.
Failed root registration disposes the controller. Ordinary index/App/package main
remain unchanged and disconnected. Eleven focused tests and typecheck pass;
independent code review and exact new FULL results are tracked separately.

For an isolated development copy only, create a temporary entry such as:

```tsx
import { startSyntheticNativeHarness } from './src/dev/synthetic-native-entry';
startSyntheticNativeHarness({
  mode: 'synthetic-loopback',
  baseURL: 'http://127.0.0.1:8787',
});
```

Select that temporary file as the copy's package.json main, never the accepted
normal entry, and restore it after testing. Port8787 is an example, not an implicit
configuration/default. The harness supplies neither API server nor accounts,
migrations, feature flags or reverse transport. Preprovision fictional accounts in
the isolated fixture; open Chat for the existing synthetic sign-in and pair setup,
then Together/Predictions after pair membership is ready. No credentials are
embedded, auto-created or loaded from environment by this harness.

The first explicit development-entry JS export failed to resolve the already
locked nested @expo/devtools dependency through expo-sqlite. Ordinary preview JS
export did not exercise this graph. The failure log is retained; a targeted Metro
resolution repair and a repeated explicit-entry export are required before this
new harness is considered checked. Journal execution stayed disabled throughout.

The targeted fix maps only the existing Expo-owned @expo/devtools package root;
hierarchical lookup remains disabled and no dependencies were added. Twelve
harness/config focused tests passed with100% of all four coverage metrics. The
explicit temporary-entry development JS export then passed for both Android and
iOS (retained retry1 log). Temporary main/entry were restored afterward. These are
connected-harness bundles, not execution on a device, authentication or native
compilation. Original failed export evidence is retained.
