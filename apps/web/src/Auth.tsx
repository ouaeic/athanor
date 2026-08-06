import { useEffect, useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { ArrowRight, Copy, Download, KeyRound, ShieldCheck } from 'lucide-react';
import { api } from './api.js';
import { authActionLabel, authHeading, canSubmitAuth, type AuthMode } from './auth-form.js';
import { deviceEnrollmentToken, grantInPairingFragment, isPairingFragment } from './device-link.js';
import { recoveryFile } from './account-recovery.js';
import { BrandMark } from './BrandMark.js';
import { ServerInstall } from './ServerInstall.js';

export function Auth({ onReady }: { onReady: () => void }) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [name, setName] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  /** What was actually typed or pasted, which for a second device is a whole `athanor://pair` link. */
  const [deviceLink, setDeviceLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recovery, setRecovery] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [legal, setLegal] = useState<Awaited<ReturnType<typeof api.legal>>>();
  const [serverInstall, setServerInstall] = useState(false);
  const [nativeInstallerUrl, setNativeInstallerUrl] = useState('');

  /*
   * Both answers are needed before the screen can choose what it is for, so they are awaited
   * together. A box with no owner yet wants claiming. A box that has an owner and has just been
   * handed a code wants that code redeemed — it can be nothing else, because registration is
   * closed and signing in needs a passkey this device does not have yet.
   */
  useEffect(() => {
    let active = true;
    // A scanned QR code arrives here: the address opens this page with the ticket in its fragment,
    // and the grant comes straight out of it, so pairing a phone is scan, tap, done — with nothing
    // typed, pasted, or read off another screen.
    const scanned = grantInPairingFragment(window.location.hash);
    if (scanned) {
      setPairingCode(scanned);
      setDeviceLink(scanned);
    }
    // Replaced rather than pushed, and done whether or not the grant parsed: a one-time code should
    // not sit in the address bar, land in history, or come back with the Back button.
    if (isPairingFragment(window.location.hash))
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    void Promise.all([
      api.nativeBootstrap().catch(() => null),
      api.legal().catch(() => undefined)
    ]).then(([native, server]) => {
      if (!active) return;
      if (native) {
        setNativeInstallerUrl(native.installerUrl);
        if (native.pairingCode) {
          setPairingCode(native.pairingCode);
          setDeviceLink(native.pairingCode);
        }
      }
      setLegal(server);
      if (server?.registrationAvailable && !scanned) setMode('register');
      else if (server && (scanned || native?.pairingCode)) setMode('enroll');
    });
    return () => {
      active = false;
    };
  }, []);

  const ready = canSubmitAuth({
    mode,
    name,
    pairingCode,
    recoveryCode,
    busy,
    passkeysUsable: legal?.passkeysUsable !== false,
    serverKnown: Boolean(legal),
    singleOwner: legal?.singleOwner === true
  });

  // Enter submits from any field, not only from the last one. It used to be wired to the recovery
  // code alone, so the two fields on the screen that claims the server ignored it.
  const submitOnEnter = (event: { key: string }) => {
    if (event.key === 'Enter' && ready) void submit();
  };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      if (mode === 'register') {
        const pending = await api.registerOptions(name, pairingCode);
        const response = await startRegistration({ optionsJSON: pending.options });
        const result = await api.registerVerify({
          displayName: name,
          pairingCode,
          challengeId: pending.challengeId,
          response
        });
        setRecovery(result.recoveryCode);
      } else if (mode === 'enroll') {
        const pending = await api.enrollOptions(pairingCode);
        const response = await startRegistration({ optionsJSON: pending.options });
        // The link is sent again because the box now spends it here rather than when it handed out
        // the options, so a dismissed or timed-out biometric prompt leaves it usable for a retry.
        await api.enrollVerify({ challengeId: pending.challengeId, token: pairingCode, response });
        // The ceremony proved a fresh authenticator, so the box signs this device in as it verifies:
        // there is no recovery code to show, because the account already has one.
        onReady();
      } else if (mode === 'recover') {
        const pending = await api.recoverOptions(name, recoveryCode);
        const response = await startRegistration({ optionsJSON: pending.options });
        const result = await api.recoverVerify({
          challengeId: pending.challengeId,
          recoveryCode,
          response
        });
        setRecovery(result.recoveryCode);
      } else {
        const pending = await api.loginOptions();
        const response = await startAuthentication({ optionsJSON: pending.options });
        await api.loginVerify({ challengeId: pending.challengeId, response });
        onReady();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Authentication failed');
    } finally {
      setBusy(false);
    }
  };

  if (recovery)
    return (
      <main className="auth-page">
        <section className="recovery-card">
          <div className="success-icon">
            <ShieldCheck />
          </div>
          <p className="eyebrow">Account protected</p>
          <h1>Save your recovery code</h1>
          {/* It said "it cannot be reissued", which Settings has an Issue-a-new-code button
              directly contradicting. What is true is that this copy is shown once. */}
          <p>
            This is the only time this code is shown. Without it, losing your device means losing
            the account. Using it replaces every passkey, signs out other devices, and issues a new
            code — and you can issue a fresh one from Settings at any time, which retires this one
            immediately.
          </p>
          <code className="recovery-code">{recovery}</code>
          {/*
            The clipboard write is awaited and its failure reported: a rejected promise in a
            non-secure context or under stricter gesture rules used to drop the one string that
            cannot be recovered, silently, on the same tick as leaving the screen.
          */}
          <div className="recovery-actions">
            <button
              className="secondary"
              onClick={() => {
                setSaveError('');
                navigator.clipboard
                  ?.writeText(recovery)
                  .then(() => {
                    setCopied(true);
                    setSaved(true);
                  })
                  .catch(() =>
                    setSaveError(
                      'This browser refused the clipboard. Download the file, or select the code above and copy it by hand.'
                    )
                  );
              }}
            >
              <Copy size={16} /> {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              className="secondary"
              onClick={() => {
                setSaveError('');
                const file = recoveryFile(recovery);
                const href = URL.createObjectURL(new Blob([file.text], { type: file.type }));
                const anchor = document.createElement('a');
                anchor.href = href;
                anchor.download = file.name;
                anchor.click();
                URL.revokeObjectURL(href);
                setSaved(true);
              }}
            >
              <Download size={16} /> Download
            </button>
          </div>
          {saveError && (
            <div className="form-error" role="alert">
              {saveError}
            </div>
          )}
          <label className="recovery-confirm">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            I have saved this code somewhere I can get to it
          </label>
          <button className="primary wide" disabled={!acknowledged} onClick={onReady}>
            Continue <ArrowRight size={17} />
          </button>
          {!saved && <p className="subtle">Copy or download it first — it is not shown again.</p>}
        </section>
      </main>
    );

  return (
    <main className="auth-page">
      {/*
        This screen is only ever seen by the person who installed the box, so it sells them
        nothing. The panel carries the mark and the one fact worth knowing at sign-in: whose
        machine this is.
      */}
      <section className="auth-story">
        <div className="brand brand-logo light">
          <span className="brand-mark">
            <BrandMark />
          </span>
        </div>
        <div className="auth-hero-copy">
          <h1>Your agent computer</h1>
          <p>{window.location.host}</p>
        </div>
      </section>
      <section className="auth-form-wrap">
        <div className="auth-form">
          <div className="mobile-brand brand brand-logo">
            <span className="brand-mark">
              <BrandMark />
            </span>
          </div>
          <h2>{authHeading(mode)}</h2>
          {mode === 'register' && (
            <>
              <label>
                Your name
                <input
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={submitOnEnter}
                  placeholder="Ada"
                />
              </label>
              <label>
                One-time pairing code
                <input
                  autoComplete="one-time-code"
                  value={pairingCode}
                  onChange={(event) => setPairingCode(event.target.value.trim())}
                  onKeyDown={submitOnEnter}
                  placeholder="Printed when athanor was installed"
                />
              </label>
            </>
          )}
          {mode === 'enroll' && (
            <label>
              Device link
              {/* One field, because the account already exists and is already named. The link is
                  what the owner was actually given — the QR, or the string under it — and the code
                  inside it is taken out here rather than asked for separately. */}
              <input
                autoComplete="one-time-code"
                value={deviceLink}
                onChange={(event) => {
                  setDeviceLink(event.target.value);
                  setPairingCode(deviceEnrollmentToken(event.target.value));
                }}
                onKeyDown={submitOnEnter}
                placeholder="athanor://pair/…"
              />
            </label>
          )}
          {mode === 'recover' && (
            <>
              {/*
                Asked only where it could matter. A box with one account has nothing to
                disambiguate, and this field was a display name typed once during setup - wanted
                back months later, on the day every passkey is already gone, where guessing it
                wrong reported the recovery code as invalid.
              */}
              {!legal?.singleOwner && (
                <label>
                  Name used during setup
                  <input
                    autoComplete="name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    onKeyDown={submitOnEnter}
                    placeholder="Ada"
                  />
                </label>
              )}
              <label>
                Recovery code
                <input
                  autoComplete="off"
                  value={recoveryCode}
                  onChange={(event) => setRecoveryCode(event.target.value)}
                  placeholder="Stored in your password manager"
                  onKeyDown={submitOnEnter}
                />
              </label>
            </>
          )}
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          {legal && !legal.passkeysUsable && (
            /*
              A passkey cannot be created against an IP address: the WebAuthn spec requires the
              relying-party id to be a registrable domain. Presenting the button anyway produces a
              browser error with no explanation, so the condition is stated with the fix instead.
            */
            <div className="form-error" role="alert">
              This server is reached by IP address, and a passkey has to be bound to a domain name —
              the standard does not allow an address. If the server&rsquo;s address is fixed, which
              is the usual case for a rented one, point a domain at it and run{' '}
              <code>sudo athanor set-hostname your.domain</code>. Only if its address changes, as on
              a home connection, does it need <code>sudo athanor ddns configure</code>.
            </div>
          )}
          <button className="primary wide" disabled={!ready} onClick={() => void submit()}>
            <KeyRound size={17} /> {authActionLabel(mode, busy)}
          </button>
          {import.meta.env.DEV && (
            <button
              className="ghost wide"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await api.devLogin(name || 'local');
                  onReady();
                } catch (cause) {
                  setError(cause instanceof Error ? cause.message : 'Development sign-in failed');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Development sign-in
            </button>
          )}
          {(legal?.registrationAvailable || mode === 'register') && (
            <p className="switch-auth">
              {mode === 'login' ? 'Setting up this server?' : 'Already claimed this server?'}{' '}
              <button onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
                {mode === 'login' ? 'Create the owner account' : 'Sign in'}
              </button>
            </p>
          )}
          {/*
            The way in for every device after the first. Without it the only paths on a claimed box
            were a passkey this device does not have and a recovery that replaces every passkey the
            owner already has — so the device link the settings screen mints, and draws as a QR
            code, had nothing anywhere that could redeem it.

            Offered whenever this screen is signing in, rather than only when registration is
            closed: a box that accepts registrations still cannot tell the difference between one
            with an owner and one without, and on the box that has one, registering is how a second
            device ends up as a second account instead of the same one.
          */}
          {mode === 'login' && (
            <p className="switch-auth">
              Adding a new device?{' '}
              <button onClick={() => setMode('enroll')}>Use a device link</button>
            </p>
          )}
          {mode === 'enroll' && (
            <p className="switch-auth">
              Create the link from a device that is already signed in, under Settings.{' '}
              <button onClick={() => setMode('login')}>Sign in instead</button>
            </p>
          )}
          {mode === 'login' && (
            <p className="switch-auth">
              <button onClick={() => setMode('recover')}>Lost access to your passkey?</button>
            </p>
          )}
          {legal && (
            <p className="auth-legal-links">
              {legal.sourceUrl && (
                <a href={legal.sourceUrl} target="_blank" rel="noreferrer">
                  Source (AGPL-3.0)
                </a>
              )}
              {legal.privacyUrl && (
                <a href={legal.privacyUrl} target="_blank" rel="noreferrer">
                  Privacy
                </a>
              )}
            </p>
          )}
          <button
            className="server-install-link"
            onClick={() => {
              if (nativeInstallerUrl) window.location.assign(nativeInstallerUrl);
              else setServerInstall(true);
            }}
          >
            Install athanor on a cloud server
          </button>
        </div>
      </section>
      {serverInstall && <ServerInstall onClose={() => setServerInstall(false)} />}
    </main>
  );
}
