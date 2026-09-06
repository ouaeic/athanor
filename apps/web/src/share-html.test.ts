import { describe, expect, it } from 'vitest';
import { shareArtifactDocument } from './share-html.js';

describe('decrypted static HTML isolation', () => {
  it('applies a restrictive policy before untrusted markup while preserving its styles', () => {
    const artifact =
      '<style>h1{color:green}</style><h1>Result</h1><script>fetch("https://external.example")</script>';
    const document = shareArtifactDocument(artifact);
    const firstMeta =
      /^<!doctype html><meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(
        document
      );
    expect(firstMeta).not.toBeNull();
    const directives = Object.fromEntries<string[]>(
      firstMeta![1]!.split(';').map((directive) => {
        const [name, ...sources] = directive.trim().split(/\s+/);
        return [name ?? '', sources];
      })
    );
    expect(directives).toEqual({
      'default-src': ["'none'"],
      'style-src': ["'unsafe-inline'"],
      'img-src': ['blob:', 'data:'],
      'media-src': ['blob:', 'data:'],
      'font-src': ['data:'],
      'form-action': ["'none'"],
      'base-uri': ["'none'"]
    });
    expect(document.endsWith(artifact)).toBe(true);
  });
});
