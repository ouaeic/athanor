import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const original = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, original);
});

const baseEnvironment = () => {
  process.env.RUNNER_SHARED_SECRET = 'runner-secret-of-at-least-thirty-two-characters';
  process.env.WORKSPACE_ROOT = '/home/athanor';
};

describe('runner configuration', () => {
  it('takes the capability signing secret out of the environment once it is read', () => {
    // A command that reaches the runner's process - through /proc, a core file, anything that
    // reads the environment back - would otherwise find the key that mints capability tokens for
    // every workspace, with any scope it likes.
    baseEnvironment();
    const config = loadConfig();
    // Still readable here, where it was loaded, and nowhere a command can reach.
    expect(config.RUNNER_SHARED_SECRET).toBe('runner-secret-of-at-least-thirty-two-characters');
    expect(process.env.RUNNER_SHARED_SECRET).toBeUndefined();
  });

  it('refuses to promise network isolation it cannot deliver', () => {
    // An unprivileged process cannot create a network namespace, so without the helper the
    // setting made every command fail instead of isolating it.
    baseEnvironment();
    process.env.ISOLATE_AGENT_NETWORK = 'true';
    expect(() => loadConfig()).toThrow('AGENT_SANDBOX_HELPER is unset');
  });

  it('isolates the network when the privileged helper is configured', () => {
    baseEnvironment();
    process.env.ISOLATE_AGENT_NETWORK = 'true';
    process.env.AGENT_SANDBOX_HELPER = '/usr/local/lib/athanor/athanor-sandbox';
    expect(loadConfig().ISOLATE_AGENT_NETWORK).toBe(true);
  });

  it('refuses to promise a filesystem boundary it has nowhere to apply', () => {
    // A Landlock ruleset is installed on the privileged side of the drop to the agent account.
    // Without the helper there is no privileged side, so the setting would have described a
    // boundary while every command ran with exactly the reach it had before - a silence rather
    // than a failure, which is the worse of the two.
    baseEnvironment();
    process.env.CONFINE_AGENT_FILESYSTEM = 'true';
    expect(() => loadConfig()).toThrow('AGENT_SANDBOX_HELPER is unset');
  });

  it('confines the filesystem when the privileged helper is configured', () => {
    baseEnvironment();
    process.env.CONFINE_AGENT_FILESYSTEM = 'true';
    process.env.AGENT_SANDBOX_HELPER = '/usr/local/lib/athanor/athanor-sandbox';
    expect(loadConfig().CONFINE_AGENT_FILESYSTEM).toBe(true);
  });

  it('reads a runner.env written before any of this as unmeasured rather than as refused', () => {
    // The upgrade case, and the reason this key is optional where its neighbour is defaulted: a
    // box whose installer has not yet looked has not answered no, and it must start unconfined
    // rather than fail to parse or claim a boundary nobody measured.
    baseEnvironment();
    process.env.AGENT_SANDBOX_HELPER = '/usr/local/lib/athanor/athanor-sandbox';
    expect(loadConfig().CONFINE_AGENT_FILESYSTEM).toBeUndefined();
  });

  it('reads the ports athanor already serves on so a preview cannot publish them', () => {
    baseEnvironment();
    process.env.RESERVED_PREVIEW_PORTS = '4100, 4400,5432, ,not-a-port';
    expect(loadConfig().RESERVED_PREVIEW_PORTS).toEqual([4100, 4400, 5432]);
  });
});
