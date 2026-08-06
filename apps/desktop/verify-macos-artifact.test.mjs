import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoMacSensitiveContent, validateMacInfo } from './verify-macos-artifact.mjs';

function validInfo() {
  return {
    CFBundleIdentifier: 'org.athanor.ai',
    CFBundleName: 'athanor',
    CFBundleShortVersionString: '0.1.0',
    CFBundleVersion: '1',
    CFBundleExecutable: 'athanor-desktop',
    LSMinimumSystemVersion: '10.13',
    CFBundleURLTypes: [{ CFBundleURLSchemes: ['athanor'] }],
    NSAppTransportSecurity: {
      NSExceptionDomains: {
        localhost: {
          NSExceptionAllowsInsecureHTTPLoads: true,
          NSIncludesSubdomains: false
        }
      }
    },
    NSBonjourServices: ['_athanor._tcp'],
    NSCameraUsageDescription: 'Used only when the person attaches a camera photo.',
    NSLocalNetworkUsageDescription: 'Used only to rediscover the paired remote computer.',
    NSMicrophoneUsageDescription: 'Used only when the person records a voice note.',
    NSPhotoLibraryUsageDescription: 'Used only for photos the person explicitly chooses.'
  };
}

test('requires exact macOS identity, pairing, transport, discovery, and privacy policy', () => {
  assert.doesNotThrow(() => validateMacInfo(validInfo(), '0.1.0'));
  const broadTransport = validInfo();
  broadTransport.NSAppTransportSecurity.NSAllowsArbitraryLoads = true;
  assert.throws(() => validateMacInfo(broadTransport, '0.1.0'));
  const broadDomain = validInfo();
  broadDomain.NSAppTransportSecurity.NSExceptionDomains['example.com'] = {};
  assert.throws(() => validateMacInfo(broadDomain, '0.1.0'));
});

test('distinguishes parser labels from complete private keys in macOS artifacts', () => {
  assert.doesNotThrow(() =>
    assertNoMacSensitiveContent(
      'parser',
      Buffer.from('-----BEGIN OPENSSH PRIVATE KEY----------BEGIN PRIVATE KEY-----')
    )
  );
  const body = Buffer.from('private key material must never ship').toString('base64').repeat(4);
  assert.throws(() =>
    assertNoMacSensitiveContent(
      'fixture',
      Buffer.from(`-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`)
    )
  );
});
