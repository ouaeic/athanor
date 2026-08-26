import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { execute } from './execution.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const workspaceRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'athanor-execution-'));
  temporaryRoots.push(root);
  await mkdir(path.join(root, 'workspace'));
  return root;
};

describe('bounded execution output', () => {
  it('preserves the beginning and end of oversized streams', async () => {
    const root = await workspaceRoot();
    const result = await execute(
      root,
      {
        executable: process.execPath,
        args: ['-e', "process.stdout.write('BEGIN' + 'x'.repeat(12000) + 'END')"],
        maxOutputBytes: 4096
      },
      { maximumSeconds: 30 }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('BEGIN');
    expect(result.stdout).toContain('END');
    expect(result.stdout).toContain('bytes omitted from stdout');
    expect(result.stdout.length).toBeLessThan(5_000);
  });

  it('returns small streams exactly', async () => {
    const root = await workspaceRoot();
    const result = await execute(
      root,
      { executable: process.execPath, args: ['-e', "process.stdout.write('complete')"] },
      { maximumSeconds: 30 }
    );
    expect(result.stdout).toBe('complete');
    expect(result.stderr).toBe('');
  });

  it('routes approved host package installs through the fixed helper', async () => {
    const root = await workspaceRoot();
    const helper = path.join(root, 'package-helper');
    await writeFile(helper, '#!/bin/sh\nprintf "%s" "$*"\n');
    await chmod(helper, 0o700);
    const result = await execute(
      root,
      {
        executable: 'apt-get',
        args: ['install', '-y', 'inkscape'],
        network: true
      },
      { maximumSeconds: 30, allowSystemPackages: true, systemPackageHelper: helper }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('install inkscape');
  });

  /*
   * This computer runs on four distribution families and the reader of a package command knew one
   * of them. `dnf install -y nmap` yielded `install` and was rewritten onto a helper that ran
   * apt-get, so the owner approved a dnf install and got ENOENT; `pacman -S nmap` yielded `nmap`
   * as its operation and was refused one step earlier with a sentence about apt. Two families,
   * two different wrong answers, both after the owner had said yes.
   */
  it("reads each family's own spelling of update and install, not only apt's", async () => {
    const root = await workspaceRoot();
    const helper = path.join(root, 'package-helper');
    await writeFile(helper, '#!/bin/sh\nprintf "%s" "$*"\n');
    await chmod(helper, 0o700);
    const asked = async (executable: string, args: string[]): Promise<string> =>
      (
        await execute(
          root,
          { executable, args, network: true },
          { maximumSeconds: 30, allowSystemPackages: true, systemPackageHelper: helper }
        )
      ).stdout;

    expect(await asked('dnf', ['install', '-y', 'nmap'])).toBe('install nmap');
    expect(await asked('dnf5', ['install', 'nmap', 'jq'])).toBe('install nmap jq');
    expect(await asked('zypper', ['--non-interactive', 'install', 'nmap'])).toBe('install nmap');
    expect(await asked('apk', ['add', 'nmap'])).toBe('install nmap');
    expect(await asked('pacman', ['-S', '--noconfirm', 'nmap'])).toBe('install nmap');
    expect(await asked('pacman', ['-Sy'])).toBe('update');
    expect(await asked('dnf', ['makecache'])).toBe('update');
    expect(await asked('apt-get', ['update'])).toBe('update');
  });

  /*
   * The helper does two things. An operation that is not one of them is refused rather than being
   * quietly rounded down to the nearest one that is: `dnf upgrade` and `pacman -Syu` rewrite every
   * package on the machine, and answering them with an index refresh would report success for
   * something the owner asked for and did not get.
   */
  it('refuses a package operation the approved helper cannot perform, and says so once', async () => {
    const root = await workspaceRoot();
    const refusals = [
      { executable: 'dnf', args: ['upgrade', '-y'] },
      { executable: 'pacman', args: ['-Syu', '--noconfirm'] },
      { executable: 'apt-get', args: ['upgrade'] },
      { executable: 'emerge', args: ['nmap'] },
      { executable: 'rpm', args: ['-i', 'nmap.rpm'] },
      // An install with nothing to install: the helper would refuse it a layer further down, as
      // root, which is the wrong place to discover that an argument list was empty.
      { executable: 'dnf', args: ['install', '-y'] },
      // An index refresh does not take operands; one here means the model meant something else.
      { executable: 'apt-get', args: ['update', 'nmap'] }
    ];
    for (const attempt of refusals)
      await expect(
        execute(root, attempt, {
          maximumSeconds: 30,
          allowSystemPackages: true,
          systemPackageHelper: '/usr/local/sbin/athanor-system-packages'
        })
      ).rejects.toThrow('Host-native package management supports approved update and install only');
  });

  it('rejects escalation spelled with a path or hidden behind a wrapper', async () => {
    const root = await workspaceRoot();
    const attempts = [
      { executable: '/usr/bin/sudo', args: ['id'] },
      { executable: 'env', args: ['sudo', 'id'] },
      { executable: 'sh', args: ['-c', 'sudo id'] },
      { executable: 'xargs', args: ['sudo', 'id'] },
      { executable: 'nohup', args: ['sudo', 'id'] },
      { executable: 'setsid', args: ['sudo', 'id'] },
      { executable: 'nice', args: ['sudo', 'id'] },
      { executable: 'timeout', args: ['5', 'sudo', 'id'] },
      { executable: 'stdbuf', args: ['-o0', 'sudo', 'id'] },
      { executable: 'sh', args: ['-c', 'echo $(/usr/bin/su -c id)'] }
    ];
    for (const attempt of attempts)
      await expect(execute(root, attempt, { maximumSeconds: 30 })).rejects.toThrow(
        'Direct privilege escalation is disabled'
      );
  });

  it('refuses to run apt through a wrapper that would skip the approval gate', async () => {
    const root = await workspaceRoot();
    await expect(
      execute(
        root,
        { executable: 'env', args: ['apt-get', 'install', '-y', 'inkscape'] },
        {
          maximumSeconds: 30,
          allowSystemPackages: true,
          systemPackageHelper: '/usr/local/sbin/athanor-system-packages'
        }
      )
    ).rejects.toThrow('Host-native package management supports approved update and install only');
  });

  it('captures output a grandchild writes after the direct child exits', async () => {
    const root = await workspaceRoot();
    const result = await execute(
      root,
      { executable: '/bin/sh', args: ['-c', '{ sleep 0.2; echo LATE; } & exit 0'] },
      { maximumSeconds: 30 }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('LATE');
  });

  it('kills orphaned grandchildren when the command times out', async () => {
    const root = await workspaceRoot();
    const result = await execute(
      root,
      { executable: '/bin/sh', args: ['-c', 'sleep 30 & echo $!; wait'], timeoutSeconds: 1 },
      { maximumSeconds: 30 }
    );
    expect(result.timedOut).toBe(true);
    const grandchild = Number(result.stdout.trim());
    expect(Number.isInteger(grandchild)).toBe(true);
    await expect
      .poll(
        () => {
          try {
            process.kill(grandchild, 0);
            return true;
          } catch {
            return false;
          }
        },
        { interval: 25, timeout: 3_000 }
      )
      .toBe(false);
  });

  it('rejects unapproved escalation and apt option injection on the host', async () => {
    const root = await workspaceRoot();
    await expect(
      execute(root, { executable: 'sudo', args: ['id'] }, { maximumSeconds: 30 })
    ).rejects.toThrow('Direct privilege escalation is disabled');
    await expect(
      execute(
        root,
        {
          executable: 'apt-get',
          args: ['install', '-y', '-o', 'APT::Update::Pre-Invoke::=id', 'inkscape']
        },
        {
          maximumSeconds: 30,
          allowSystemPackages: true,
          systemPackageHelper: '/usr/local/sbin/athanor-system-packages'
        }
      )
    ).rejects.toThrow('Package names may not contain');
  });
});

describe('command environment', () => {
  it('passes the coding CLI permission policy through and refuses anything else', async () => {
    const root = await workspaceRoot();
    const result = await execute(
      root,
      {
        executable: process.execPath,
        args: ['-e', 'process.stdout.write(process.env.OPENCODE_PERMISSION ?? "absent")'],
        env: { OPENCODE_PERMISSION: '{"bash":{"sudo *":"deny"}}' }
      },
      { maximumSeconds: 30 }
    );
    expect(result.stdout).toBe('{"bash":{"sudo *":"deny"}}');

    await expect(
      execute(
        root,
        { executable: process.execPath, args: ['-e', ''], env: { LD_PRELOAD: '/tmp/evil.so' } },
        { maximumSeconds: 30 }
      )
    ).rejects.toThrow('does not accept LD_PRELOAD');
  });
});

describe('agent sandbox', () => {
  /** Stands in for sudo: records what it was asked to run, then runs it. */
  const recordingElevator = async (root: string, record: string): Promise<string> => {
    const elevate = path.join(root, 'elevate');
    await writeFile(elevate, `#!/bin/sh\nprintf '%s\\n' "$*" >"${record}"\nshift\nexec "$@"\n`);
    await chmod(elevate, 0o700);
    return elevate;
  };

  it('runs an ordinary command through the privileged helper', async () => {
    const root = await workspaceRoot();
    const record = path.join(root, 'elevated');
    const elevate = await recordingElevator(root, record);
    const helper = path.join(root, 'sandbox');
    // Stands in for athanor-sandbox: drops its own two leading arguments the way the real helper
    // consumes `run <network mode>`, then applies the environment and execs, as `env -i` does.
    await writeFile(helper, '#!/bin/sh\nshift 2\nexec /usr/bin/env -i "$@"\n');
    await chmod(helper, 0o700);

    const result = await execute(
      root,
      { executable: '/bin/sh', args: ['-c', 'printf "%s" "$HOME"'] },
      { maximumSeconds: 30, sandbox: { elevate, helper } }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(root);
    const elevated = await readFile(record, 'utf8');
    expect(elevated).toContain(`-n ${helper} run network`);
    expect(elevated).toContain(`HOME=${root}`);
  });

  it('asks for a network namespace when the command did not ask for the network', async () => {
    const root = await workspaceRoot();
    const record = path.join(root, 'elevated');
    const elevate = await recordingElevator(root, record);
    const helper = path.join(root, 'sandbox');
    await writeFile(helper, '#!/bin/sh\nshift 2\nexec /usr/bin/env -i "$@"\n');
    await chmod(helper, 0o700);

    await execute(
      root,
      { executable: '/bin/sh', args: ['-c', 'true'] },
      { maximumSeconds: 30, isolateNetwork: true, sandbox: { elevate, helper } }
    );
    expect(await readFile(record, 'utf8')).toContain(`-n ${helper} run isolated`);
  });

  it('keeps the approved package install on the runner account, which is the only way it works', async () => {
    // The install reaches root through sudo, which the sandbox deliberately makes impossible,
    // so this one command has to keep the runner's own identity.
    const root = await workspaceRoot();
    const record = path.join(root, 'elevated');
    const elevate = await recordingElevator(root, record);
    const packageHelper = path.join(root, 'package-helper');
    await writeFile(packageHelper, '#!/bin/sh\nprintf "%s" "$*"\n');
    await chmod(packageHelper, 0o700);

    const result = await execute(
      root,
      { executable: 'apt-get', args: ['install', '-y', 'inkscape'] },
      {
        maximumSeconds: 30,
        allowSystemPackages: true,
        systemPackageHelper: packageHelper,
        sandbox: { elevate, helper: path.join(root, 'sandbox') }
      }
    );

    expect(result.stdout).toBe('install inkscape');
    await expect(readFile(record, 'utf8')).rejects.toThrow();
  });

  it('refuses a command that names a privileged helper directly', async () => {
    // The package helper reaches root with no capability scope and no approval of its own. It is
    // reached by the runner, after both, or not at all.
    const root = await workspaceRoot();
    const packageHelper = path.join(root, 'package-helper');
    await writeFile(packageHelper, '#!/bin/sh\nexit 0\n');
    await chmod(packageHelper, 0o755);
    const attempts = [
      { executable: packageHelper, args: ['install', 'openssh-server'] },
      { executable: 'sh', args: ['-c', `${packageHelper} install openssh-server`] }
    ];
    for (const attempt of attempts)
      await expect(
        execute(root, attempt, { maximumSeconds: 30, systemPackageHelper: packageHelper })
      ).rejects.toThrow('privileged helpers are reached by the runner');
  });

  it('follows a symbolic link before deciding a command is harmless', async () => {
    const root = await workspaceRoot();
    const impostor = path.join(root, 'workspace', 'sudo');
    await writeFile(impostor, '#!/bin/sh\nexit 0\n');
    await chmod(impostor, 0o755);
    await symlink(impostor, path.join(root, 'workspace', 's'));
    await expect(
      execute(root, { executable: './s', args: ['id'] }, { maximumSeconds: 30 })
    ).rejects.toThrow('Direct privilege escalation is disabled');
  });
});

describe('resource limits', () => {
  it('runs the command under the host limiter with every cap applied', async () => {
    const root = await workspaceRoot();
    const limiter = path.join(root, 'limiter');
    const record = path.join(root, 'limiter-args');
    // Stands in for prlimit: records the limits it was handed, then execs the real command the
    // same way prlimit does, so the wrapping is proven end to end rather than by inspection.
    await writeFile(
      limiter,
      `#!/bin/sh\nargs=""\nwhile [ "$1" != "--" ]; do args="$args $1"; shift; done\nshift\nprintf '%s' "$args" >"${record}"\nexec "$@"\n`
    );
    await chmod(limiter, 0o700);

    const result = await execute(
      root,
      { executable: process.execPath, args: ['-e', "process.stdout.write('ran')"] },
      {
        maximumSeconds: 30,
        guards: {
          limiter,
          limits: {
            memoryBytes: 1024 ** 3,
            fileBytes: 2 * 1024 ** 3,
            processes: 512,
            openFiles: 2048
          }
        }
      }
    );

    expect(result.stdout).toBe('ran');
    const applied = await readFile(record, 'utf8');
    expect(applied).toContain(`--data=${1024 ** 3}`);
    expect(applied).toContain(`--fsize=${2 * 1024 ** 3}`);
    expect(applied).toContain('--nproc=512');
    expect(applied).toContain('--nofile=2048');
    expect(applied).toContain('--core=0');
  });

  it('runs unwrapped when the host has no limiter, rather than failing the command', async () => {
    const root = await workspaceRoot();
    const result = await execute(
      root,
      { executable: process.execPath, args: ['-e', "process.stdout.write('ran')"] },
      {
        maximumSeconds: 30,
        guards: { limits: { memoryBytes: 1, fileBytes: 1, processes: 1, openFiles: 1 } }
      }
    );
    expect(result.stdout).toBe('ran');
  });

  it('stops a command that is consuming the last of the host disk', async () => {
    // The pre-flight check cannot catch this: the disk was healthy when the command started and
    // the command is what fills it. Left alone it takes PostgreSQL and the interface down too.
    const root = await workspaceRoot();
    let reads = 0;
    const result = await execute(
      root,
      { executable: '/bin/sh', args: ['-c', 'sleep 30'], timeoutSeconds: 30 },
      {
        maximumSeconds: 30,
        guards: {
          hostStoragePollMs: 25,
          hostStorage: async () => ({
            hostStorageTotalBytes: 100 * 1024 ** 3,
            // Healthy for the first few polls, then past the floor.
            hostStorageAvailableBytes: ++reads > 2 ? 64 * 1024 ** 2 : 50 * 1024 ** 3
          })
        }
      }
    );

    expect(result.stoppedReason).toBe('host_disk_floor');
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain('last of the host disk');
  });

  it('leaves a healthy disk alone', async () => {
    const root = await workspaceRoot();
    const result = await execute(
      root,
      { executable: process.execPath, args: ['-e', "process.stdout.write('fine')"] },
      {
        maximumSeconds: 30,
        guards: {
          hostStoragePollMs: 25,
          hostStorage: async () => ({
            hostStorageTotalBytes: 100 * 1024 ** 3,
            hostStorageAvailableBytes: 60 * 1024 ** 3
          })
        }
      }
    );
    expect(result.stoppedReason).toBeUndefined();
    expect(result.stdout).toBe('fine');
  });
});

describe('cancellation', () => {
  it('kills a running command when the caller aborts', async () => {
    // Before this, Cancel only stopped the worker waiting for the result. The command itself ran
    // to completion on the box - still writing files, still reaching the network - long after the
    // interface said the task had stopped.
    const root = await workspaceRoot();
    const controller = new AbortController();
    const started = Date.now();
    const running = execute(
      root,
      {
        executable: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        timeoutSeconds: 60
      },
      { maximumSeconds: 120, abortSignal: controller.signal }
    );
    setTimeout(() => controller.abort(), 250);
    const result = await running;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  /*
   * The assertion above only proves the wrapper stopped. What a cancelled turn has to leave behind
   * is nothing at all, and a shell's background job is the ordinary case - `npm run dev &`, a
   * scraper, a `tail -f`. Commands are spawned detached so that the whole group can be signalled;
   * this is the test that says the group, and not only the leader, actually goes.
   */
  it('takes the whole process group with it, not only the command it started', async () => {
    const root = await workspaceRoot();
    const controller = new AbortController();
    const running = execute(
      root,
      {
        executable: '/bin/sh',
        args: ['-c', 'sleep 30 & echo $!; sleep 30'],
        timeoutSeconds: 60
      },
      { maximumSeconds: 120, abortSignal: controller.signal }
    );
    setTimeout(() => controller.abort(), 400);
    const result = await running;
    expect(result.timedOut).toBe(false);
    const grandchild = Number(result.stdout.trim());
    expect(Number.isInteger(grandchild)).toBe(true);
    await expect
      .poll(
        () => {
          try {
            process.kill(grandchild, 0);
            return true;
          } catch {
            return false;
          }
        },
        { interval: 25, timeout: 5_000 }
      )
      .toBe(false);
  });

  it('does not start a command that was already cancelled before it ran', async () => {
    const root = await workspaceRoot();
    const result = await execute(
      root,
      {
        executable: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 60000)'],
        timeoutSeconds: 60
      },
      { maximumSeconds: 120, abortSignal: AbortSignal.abort() }
    );
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
  });
});

describe('a service declared without a background', () => {
  /*
   * `shell(service: 'dev server')` without `background: true` used to run in the foreground for
   * five minutes and return an ordinary exec result. The key was not in the schema, so it was
   * stripped: no error, no service, no record, and a model that believed it had declared one.
   */
  it('is refused rather than run as an ordinary command', async () => {
    const root = await workspaceRoot();
    await expect(
      execute(
        root,
        { executable: process.execPath, args: ['-e', ''], service: 'dev server' },
        { maximumSeconds: 30 }
      )
    ).rejects.toThrow(/background/);
  });
});
