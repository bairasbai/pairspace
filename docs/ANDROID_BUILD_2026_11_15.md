# Android native build verification

## Source and scope

Source176285416ad4f8378a72dbd11e1b90610d833244 was restored from GitHub into a new
cloud checkout after the earlier execution workspace was replaced. Locked mobile
dependencies were restored with npm ci, without changing the lockfile. No owner
computer was used. The owner explicitly approved official Android SDK installation
and acceptance of the Google Android SDK License Agreement before installation.

## Installed and checked

- Official Android command-line tools15859902: SHA256 matched Google's published
  4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583.
- SDK Platform37.0 revision2, Build-Tools37.0.0, Platform-Tools37.0.1,
  NDK27.1.12297006. Gradle additionally installed required Build-Tools36.0.0 and
  CMake3.22.1 under the accepted SDK license.
- Gradle9.4.1 was downloaded from its official distribution endpoint and verified
  against its official SHA256. Java21.0.13 was already installed.
- Offline Expo Android prebuild succeeded. Anonymous diagnostic application ID
  com.anonymous.pairspacepreview was generated only in the build checkout.

## Actual native build result

`:app:assembleDebug -PreactNativeArchitectures=x86_64` PASSED.
The first attempt failed when the Gradle daemon disappeared during native C/C++
compilation. Exact cause is unproven; its log is retained. A retry using one Gradle
worker, two available CPUs, native parallelism2 and JVM processor count2 succeeded
without application source changes:198 actionable tasks,23 executed/175 up-to-date.
This was a native Kotlin/Java/C++/resource/APK build, not merely JS export or prebuild.

APK: Amio-Android-x86_64-debug-requires-Metro-1762854.apk
Bytes:49370048
SHA256:f33e749b6722a1000d0ae2d06657df24162dfeb3a8ba694a7053f713041a7514
Android apksigner verification:PASS, v2 debug signature. Minimum API24,target36,
compiled API37. The diagnostic APK is for x86_64, not ordinary ARM phones. It uses
Metro rather than an embedded release JS bundle; the normal entry remains offline
preview. It is not a production/release-signed or ready-to-share consumer app.
The SDK, caches, signing keystore and generated native project are not committed.

## Runtime attempt and limits

Official emulator37.2.13 and AOSP API36 default x86_64 image were installed.
No /dev/kvm acceleration device is available. Headless software emulation was
attempted with acceleration disabled. Initial starts failed because the default
runtime directory was read-only; a writable scoped XDG_RUNTIME_DIR resolved that.
In the final bounded attempt adb detected emulator-5554 as a device, but Android
sys.boot_completed never became1 within450 seconds. Cleanup stopped the emulator.
APK installation/launch, UI verification and connected sign-in were therefore
NOT_RUN. This is not evidence that the APK crashes, nor proof the emulator can
never boot; it is a failed runtime-verification attempt in this environment.

No phone, two-device test, iOS native compilation, production readiness or E2EE
claim follows. The existing exact1762854 author/independent FULL11/11 checks remain
historical application evidence; this documentation-only checkpoint does not claim
new full test runs. Generated manifest permissions still require release review.

Next useful gate: an approved accelerated Android emulator/device host, followed
by explicit synthetic harness/Metro testing using fictional fixture accounts and
loopback-preserving transport. Native iOS still requires macOS/Xcode.

Sources: [Android tools](https://developer.android.com/studio/),
[SDK terms](https://developer.android.com/studio/terms),
[Gradle distributions](https://services.gradle.org/distributions/).
