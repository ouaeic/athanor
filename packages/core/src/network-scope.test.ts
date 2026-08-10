import { describe, expect, it } from 'vitest';
import {
  hostMatchesSuffix,
  isPublicHttpUrl,
  isPublicInternetAddress,
  matchingHostSuffix
} from './network-scope.js';

describe('public internet addresses', () => {
  it('accepts routable addresses and refuses everything reserved', () => {
    expect(isPublicInternetAddress('93.184.216.34')).toBe(true);
    expect(isPublicInternetAddress('2606:4700:4700::1111')).toBe(true);
    for (const address of [
      '0.0.0.0',
      '10.0.0.2',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.5',
      '192.0.2.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.51.100.4',
      '203.0.113.8',
      '224.0.0.1',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '2001:db8::1',
      '::ffff:127.0.0.1',
      // Not assigned to anyone. Global unicast is 2000::/3, so this is reachable only through a
      // list of known-bad prefixes that has to be maintained; it is refused by not being allowed.
      '4000::1',
      '0100::1'
    ])
      expect({ address, public: isPublicInternetAddress(address) }).toEqual({
        address,
        public: false
      });
  });
});

describe('IPv6 that is spelled like the internet and is not', () => {
  /*
   * The check used to be `startsWith('2') || startsWith('3')`, which is a test on text rather than
   * on the address. Two ways that is wrong, and one of them is the thing this file exists to stop.
   */
  it('refuses transition addresses that carry an IPv4 address inside them', () => {
    // 2002:a9fe:a9fe:: IS 169.254.169.254 - the cloud metadata service - written as 6to4. A relay
    // that honours it turns the one address every SSRF guard blocks into a reachable one.
    expect(isPublicInternetAddress('2002:a9fe:a9fe::')).toBe(false);
    expect(isPublicInternetAddress('2002:7f00:1::')).toBe(false); // 127.0.0.1
    expect(isPublicInternetAddress('2002:c0a8:1::')).toBe(false); // 192.168.0.1
    // Teredo does the same thing with a different prefix.
    expect(isPublicInternetAddress('2001:0:4136:e378:8000:63bf:3fff:fdd2')).toBe(false);
  });

  it('refuses an address that merely starts with the right digit', () => {
    // 2::1 is 0002:: and nowhere near 2000::/3, but it begins with a 2.
    expect(isPublicInternetAddress('2::1')).toBe(false);
    expect(isPublicInternetAddress('3::1')).toBe(false);
  });

  it('still allows ordinary global unicast, including blocks not yet assigned', () => {
    expect(isPublicInternetAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicInternetAddress('2a00:1450:4009:81f::200e')).toBe(true);
    // Allowed by inclusion, so an unassigned block inside 2000::/3 stays reachable rather than
    // waiting for somebody to remember to add it.
    expect(isPublicInternetAddress('3fff::1')).toBe(true);
  });

  it('still refuses documentation, benchmarking and the non-routable blocks', () => {
    expect(isPublicInternetAddress('2001:db8::1')).toBe(false);
    expect(isPublicInternetAddress('2001:2::1')).toBe(false);
    expect(isPublicInternetAddress('2001:10::1')).toBe(false);
    expect(isPublicInternetAddress('fe80::1')).toBe(false);
    expect(isPublicInternetAddress('::1')).toBe(false);
  });
});

describe('public HTTP URLs', () => {
  it('refuses local schemes, local names and loopback literals', () => {
    expect(isPublicHttpUrl('https://docs.example.com/research')).toBe(true);
    for (const url of [
      'file:///etc/passwd',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'http://localhost:3000/private',
      'http://127.0.0.1:4100/v1/legal',
      'http://[::1]/internal',
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'https://metadata.google.internal/computeMetadata/v1',
      'http://box.local/admin',
      'http://api.internal/keys',
      'http://gateway.home.arpa/',
      'not a url'
    ])
      expect({ url, public: isPublicHttpUrl(url) }).toEqual({ url, public: false });
  });
});

describe('which suffix a host sits under', () => {
  it('answers with the longest match, so nothing is charged for a label twice', () => {
    expect(matchingHostSuffix('docs.example.com', ['example.com', 'docs.example.com'])).toBe(
      'docs.example.com'
    );
    expect(matchingHostSuffix('eu.api.example.com', [' .Example.com ', ''])).toBe('example.com');
    expect(matchingHostSuffix('example.com.evil.invalid', ['example.com'])).toBeNull();
    expect(matchingHostSuffix('anything', [''])).toBeNull();
  });

  it('still answers the yes-or-no question every connector asks', () => {
    expect(hostMatchesSuffix('mail.example.com', ['example.com'])).toBe(true);
    expect(hostMatchesSuffix('notexample.com', ['example.com'])).toBe(false);
  });
});
