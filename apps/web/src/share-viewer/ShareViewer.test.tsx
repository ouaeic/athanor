/**
 * What an opened artifact becomes on the page, read back from the markup as the Timeline tests
 * read theirs: `renderToStaticMarkup` runs no effect and fetches nothing, and what comes back is
 * the element the reader gets.
 *
 * The one that matters is HTML. A saved page is agent-authored, and the agent takes instructions
 * from what it reads; on the owner's own app the same file is served as bytes to download for that
 * reason. Here it may render, because it renders inside a frame whose sandbox allows scripts and
 * nothing else - no same-origin, so no cookie, no storage and no reach into this page - from a blob
 * URL this page minted. An `<iframe>` without that attribute, or an `<object>`, or the file as a
 * document, would each be the incident the owner's route records.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArtifactView } from './ShareViewer.js';
import { artifactPresentation, snapshotMarkdown } from './share-render.js';

describe('an opened artifact', () => {
  it('renders HTML only inside a frame sandboxed to scripts alone', () => {
    const markup = renderToStaticMarkup(
      <ArtifactView
        artifact={{ url: 'blob:https://box.example/abc', name: 'page.html', mimeType: 'text/html' }}
      />
    );
    expect(markup).toContain('<iframe');
    expect(markup).toContain('sandbox="allow-scripts"');
    expect(markup).not.toContain('allow-same-origin');
    expect(markup).not.toContain('allow-top-navigation');
    expect(markup).toContain('src="blob:https://box.example/abc"');
  });

  it('draws the inline-safe types inline and everything else as a file to save', () => {
    expect(artifactPresentation('image/png')).toBe('image');
    expect(artifactPresentation('IMAGE/JPEG; charset=binary')).toBe('image');
    expect(artifactPresentation('text/plain')).toBe('text');
    expect(artifactPresentation('application/pdf')).toBe('pdf');
    expect(artifactPresentation('text/html')).toBe('frame');
    expect(artifactPresentation('image/svg+xml')).toBe('download');
    expect(artifactPresentation('application/javascript')).toBe('download');
    expect(artifactPresentation('')).toBe('download');
    const saved = renderToStaticMarkup(
      <ArtifactView
        artifact={{ url: 'blob:https://box.example/svg', name: 'a.svg', mimeType: 'image/svg+xml' }}
      />
    );
    expect(saved).toContain('download="a.svg"');
    expect(saved).not.toContain('<img');
    expect(saved).not.toContain('<iframe');
  });

  it('exports the snapshot as the markdown the owner would have copied', () => {
    expect(
      snapshotMarkdown({
        v: 1,
        title: 'Quarterly numbers',
        createdAt: '2026-09-03T10:00:00.000Z',
        events: [
          { kind: 'user_message', at: '2026-09-03T09:59:00.000Z', text: 'Summarise **this**' },
          { kind: 'tool_started', at: '2026-09-03T09:59:30.000Z', text: 'Running read_file' },
          { kind: 'assistant_message', at: '2026-09-03T10:00:00.000Z', text: 'Done.' }
        ],
        artifacts: [{ n: 0, name: 'a.txt', mimeType: 'text/plain', sizeBytes: 2048, sha256: 'x' }]
      })
    ).toBe(
      [
        '# Quarterly numbers',
        '',
        '## You',
        '',
        'Summarise **this**',
        '',
        '- Step: Running read_file',
        '',
        '## athanor',
        '',
        'Done.',
        '',
        '## Files',
        '',
        '- a.txt (text/plain, 2.0 kB)',
        ''
      ].join('\n')
    );
  });
});
