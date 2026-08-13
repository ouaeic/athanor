# Releasing athanor clients

This document covers client artifacts. The Linux server is installed from reviewed source; it is not
distributed as an image, container, or virtual machine.

## Release boundary

A pushed `vX.Y.Z` tag starts the draft-only release workflow. It:

1. requires the root package, desktop package, Tauri configuration, Cargo manifest, and tag to use
   the same strict semantic version;
2. repeats dependency-license, generic-client configuration, and native-client tests;
3. compiles the release commit into every native client so its SSH installer verifies both the
   bootstrap checksum and exact downloaded Git revision;
4. builds Linux x64, Linux ARM64, macOS universal, Windows x64, a four-ABI Android APK/AAB, and an
   iOS arm64 IPA on GitHub-hosted runners;
5. requires protected macOS, Windows, Android, and iOS distribution credentials before those
   platform jobs can complete;
6. audits the final native binaries and mobile packages, not only their source configuration;
7. attaches every package to one draft GitHub release; and
8. attaches a `SHA256SUMS` manifest only after every platform job succeeds.

Workflow actions are pinned to full commit hashes. Checkout credentials are not persisted. A failed
platform build leaves the release in draft and prevents checksum completion.

## Prepare

1. Update all four version fields checked by `pnpm release:check`.
2. Add user-visible changes and known limitations to the release notes.
3. Run:

   ```bash
   pnpm install --frozen-lockfile
   CI=true pnpm check
   pnpm license:rust
   pnpm release:check
   cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
   actionlint .github/workflows/verify.yml .github/workflows/release.yml
   ```

4. Review the exact committed tree and create an annotated tag:

   ```bash
   git tag -a vX.Y.Z -m "athanor vX.Y.Z"
   git push origin main vX.Y.Z
   ```

Do not reuse or move a release tag.

## Required acceptance before publishing the draft

- Verify `SHA256SUMS` from a separately downloaded copy of every asset.
- Install each package on a clean supported operating system.
- Pair against a server whose URL was not compiled into the client.
- Complete first-owner registration and create a passkey.
- Restart the client and prove session persistence without retaining the one-time owner code.
- Change the server's reachable address and prove pinned-identity reconnect.
- Exercise task streaming, file download, media display, preview, browser/desktop takeover, and a
  non-replayable request during a forced disconnect.
- Confirm the packaged client exposes no remote Tauri IPC capability.
- On Android, verify all intended ABIs, exact permission and backup policy, exact localhost
  cleartext exception, 16 KiB package/64-bit ELF alignment, and release signature.
- On iOS, verify the final IPA identity, arm64 binary, exact localhost and Bonjour policy, deep-link
  scheme, privacy declarations, App Store provisioning profile, entitlements, and code signature.
- On macOS, verify the exact bundle identity/privacy/localhost policy, universal architecture,
  build-path and secret scanning, strict Developer ID team identity, notarization, Gatekeeper,
  and stapling for both the app and DMG. On Windows, verify every executable and installer has a
  valid timestamped Authenticode signature.
- Run the no-content log canary and release security checklist.

## Protected signing configuration

The release workflow is fail-closed. Configure these as reviewer-protected repository or environment
secrets; never place them in source, logs, artifacts, or a developer `.env`:

| Platform | Required protected secrets                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | `ATHANOR_MACOS_CERTIFICATE`, `ATHANOR_MACOS_CERTIFICATE_PASSWORD`, `ATHANOR_APPLE_ID`, `ATHANOR_APPLE_APP_PASSWORD`, `ATHANOR_APPLE_TEAM_ID` |
| Windows  | `ATHANOR_WINDOWS_CERTIFICATE`, `ATHANOR_WINDOWS_CERTIFICATE_PASSWORD`                                                                        |
| Android  | `ATHANOR_ANDROID_KEYSTORE_BASE64`, `ATHANOR_ANDROID_KEYSTORE_PASSWORD`, `ATHANOR_ANDROID_KEY_ALIAS`, `ATHANOR_ANDROID_KEY_PASSWORD`          |
| iOS      | `ATHANOR_IOS_CERTIFICATE`, `ATHANOR_IOS_CERTIFICATE_PASSWORD`, `ATHANOR_IOS_MOBILE_PROVISION`, `ATHANOR_APPLE_TEAM_ID`                       |

The macOS certificate must be a Developer ID Application certificate; the Apple password must be an
app-specific password so Tauri can notarize and staple the direct-download artifacts. The Windows
certificate is a base64-encoded PFX and is imported only into the ephemeral runner account. Android
uses a base64-encoded release keystore. iOS uses the manual Tauri signing inputs: base64-encoded
Apple Distribution P12 and App Store Connect provisioning profile.

Local Android builds may be unsigned and local macOS builds may be ad-hoc for testing. They are
explicitly rejected by the protected release path. Store submission and review remain operator
actions outside the source repository.

Client updates deliberately use checksum-verified, platform-signed manual downloads. Athanor does
not ship a mutable updater feed or an additional updater signing root. This keeps the first public
release independent of a hosted control service; a future release may change that boundary only
through an explicit, reviewed threat-model and migration decision.

## Declared operating-system floors

Reviewed 13 August 2026. These four numbers are a decision, not a default. Each is asserted twice:
once in `apps/desktop/verify-native-config.mjs`, which needs no build and therefore runs on every
`pnpm check`, and once in the artifact verifier for that platform, which reads the number back out
of the package that is about to be published.

| Platform | Floor          | Why this number                                                                                                       |
| -------- | -------------- | --------------------------------------------------------------------------------------------------------------------- |
| Android  | `minSdk 26`    | A deliberate raise above Tauri's configuration default of 24. No external rule constrains it.                         |
| Android  | `targetSdk 36` | The store's target-API rule for submissions from 31 August 2026.                                                      |
| iOS      | `15.0`         | The oldest deployment target Xcode 27 will build. Range is 15.0 to 27.0.                                              |
| macOS    | `12.0`         | The oldest deployment target Xcode 27 will build, and the oldest the macOS 27 SDK back-deploys a universal binary to. |

macOS was the one that was wrong. No `minimumSystemVersion` was declared at all, so the bundle
inherited Tauri's default of `10.13` and the artifact verifier ratified it by asserting only
`>= 10.13`. That number was never chosen and could not have been honoured: Tauri supports macOS
10.15 and newer, `rustc --print=deployment-target` reports `11.0` for `aarch64-apple-darwin`, and
the key is documented as setting `MACOSX_DEPLOYMENT_TARGET` as well as `LSMinimumSystemVersion`. A
10.13 or 10.14 Mac would have been offered an install of a binary whose own toolchain never targeted
it. `12.0` is the lowest value that no part of the toolchain contradicts.

Both Apple floors are now exact-match assertions rather than `>=`. A lower bound cannot detect the
failure these invariants exist to catch, which is a regenerated project silently shipping a
different target than the one that was agreed.

Windows declares no floor, which is correct rather than an oversight. Tauri states support for
Windows 7 and later, the default `webviewInstallMode` bootstraps the WebView2 runtime from the
installer, `minimumWebview2Version` is unset, and no store rule applies to a direct download.

Next review is forced by the store's target-API rule. `targetSdk 36` meets the 31 August 2026
requirement, so nothing is due now; an extension to 1 November 2026 exists but is not needed.
Android 17 is API 37, so on the annual cadence `targetSdk 37` becomes the requirement around
31 August 2027. Treat that date as expected rather than confirmed: only the 2026 requirement is
published today. Re-read the target-API help page before planning the work, and note that raising
`targetSdk` is a behaviour change rather than a number change — API 37 gates local-network access
behind a runtime permission, which this client needs for the Bonjour discovery declared in
`Info.plist`. Budget a real device test for it.

`minSdk 26` is the only one of the four with nothing external pushing on it: no store rule sets a
minimum, and Tauri's own prerequisites do not state an Android floor, so the 26 is this project's
choice rather than a constraint. It costs whatever compatibility shims API 26 to 36 imply and buys
back devices on Android 8 and 9. Move it only on evidence about the owner's actual install base,
which lives in the Play Console under Reach and devices; that figure is no longer published on a
public dashboard and should not be guessed at from third-party version-share articles.

## Install verification

Download the release and manifest into one empty directory, then run the platform's SHA-256 tool:

```bash
sha256sum --check SHA256SUMS
```

On macOS use `shasum -a 256 -c SHA256SUMS`. Windows users can compare
`Get-FileHash -Algorithm SHA256` output to the manifest.
