import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signOut } from '../auth.js';
import { del } from '../client.js';
import { revokeDeviceSession, signOutThisDevice } from './session-actions.js';

vi.mock('../auth.js', () => ({ signOut: vi.fn() }));
vi.mock('../client.js', () => ({ del: vi.fn() }));
vi.mock('../management.js', () => ({ sensitive: (action: () => Promise<unknown>) => action() }));

describe('ending device sessions', () => {
  const reload = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', { location: { reload } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('discards authenticated UI only after the current-device logout succeeds', async () => {
    let complete!: (value: { ok: boolean }) => void;
    vi.mocked(signOut).mockReturnValueOnce(new Promise((resolve) => (complete = resolve)));
    const pending = signOutThisDevice();
    expect(signOut).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    complete({ ok: true });
    await pending;
    expect(reload).toHaveBeenCalledOnce();
  });

  it('keeps a failed or refused logout visible for recovery', async () => {
    const failure = new Error('Connection lost');
    vi.mocked(signOut).mockRejectedValueOnce(failure).mockResolvedValueOnce({ ok: false });
    await expect(signOutThisDevice()).rejects.toBe(failure);
    await expect(signOutThisDevice()).rejects.toThrow('could not be signed out');
    expect(reload).not.toHaveBeenCalled();
  });

  it('discards authenticated UI when the server identifies the revoked session as current', async () => {
    const refresh = vi.fn();
    vi.mocked(del).mockResolvedValueOnce({ current: true });
    await revokeDeviceSession('current-session', refresh);
    expect(del).toHaveBeenCalledWith('/v1/sessions/current-session');
    expect(reload).toHaveBeenCalledOnce();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes device records when another session is revoked and keeps failures visible', async () => {
    const refresh = vi.fn();
    const failure = new Error('Revocation refused');
    vi.mocked(del).mockResolvedValueOnce({ current: false }).mockRejectedValueOnce(failure);
    await revokeDeviceSession('other-session', refresh);
    expect(refresh).toHaveBeenCalledOnce();
    await expect(revokeDeviceSession('other-session', refresh)).rejects.toBe(failure);
    expect(refresh).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
  });
});
