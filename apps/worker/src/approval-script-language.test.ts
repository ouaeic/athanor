import { describe, expect, it } from 'vitest';
import { approvalRequirement } from './approval-policy.js';
import { isDestructiveScript } from './command-classification.js';

describe('interpreter syntax and shell redirects', () => {
  const code =
    "const s=require('fs').readFileSync('site/index.html','utf8');const m=s.match(/<script>([\\s\\S]*)<\\/script>/);new Function(m[1]);console.log('JS OK');";
  it('permits ordinary syntax validation in autonomous mode, directly and inside a shell', () => {
    for (const args of [
      { executable: 'node', args: ['-e', code] },
      { executable: 'bash', args: ['-c', `node -e "${code}"`] },
      { executable: 'node', stdin: code }
    ])
      expect(approvalRequirement('shell', args, 'autonomous')).toBeNull();
  });
  it('keeps actual escaping writes and runtime deletions consequential', () => {
    const destructive = [
      { executable: 'bash', args: ['-c', 'printf x > /etc/config'] },
      { executable: 'bash', args: ['-c', 'echo "$(printf x > /etc/config)"'] },
      { executable: 'bash', args: ['-c', 'echo "`printf x > /etc/config`"'] },
      { executable: 'node', args: ['-e', "require('fs').rmSync('/outside/data')"] }
    ];
    expect(destructive.length).toBeGreaterThan(0);
    for (const args of destructive)
      expect(approvalRequirement('shell', args, 'autonomous')?.sideEffect).toBe(
        'external_consequential'
      );
    expect(isDestructiveScript("printf '%s' '>/etc/config'", 'bash')).toBe(false);
    expect(isDestructiveScript('echo ">/etc/config"', 'bash')).toBe(false);
  });
});
