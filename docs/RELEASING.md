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

## Install verification

Download the release and manifest into one empty directory, then run the platform's SHA-256 tool:

```bash
sha256sum --check SHA256SUMS
```

On macOS use `shasum -a 256 -c SHA256SUMS`. Windows users can compare
`Get-FileHash -Algorithm SHA256` output to the manifest.
