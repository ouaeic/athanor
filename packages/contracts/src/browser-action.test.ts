import { describe, expect, it } from 'vitest';
import { BrowserAction, WebFetchRequest } from './index.js';

describe('browser action contract', () => {
  it('accepts the element-driven actions a real form needs', () => {
    expect(BrowserAction.parse({ type: 'hover', selector: '[data-athanor-ref="oc-0-3"]' })).toEqual(
      {
        type: 'hover',
        selector: '[data-athanor-ref="oc-0-3"]'
      }
    );
    expect(
      BrowserAction.parse({ type: 'double_click', selector: '[data-athanor-ref="oc-0-3"]' })
    ).toEqual({ type: 'double_click', selector: '[data-athanor-ref="oc-0-3"]' });
    expect(
      BrowserAction.parse({
        type: 'select_option',
        selector: '[data-athanor-ref="oc-1-2"]',
        values: ['DE']
      })
    ).toEqual({ type: 'select_option', selector: '[data-athanor-ref="oc-1-2"]', values: ['DE'] });
  });

  it('requires at least one option value and at least one upload path', () => {
    expect(
      BrowserAction.safeParse({ type: 'select_option', selector: '#country', values: [] }).success
    ).toBe(false);
    expect(BrowserAction.safeParse({ type: 'upload', selector: '#cv', paths: [] }).success).toBe(
      false
    );
    expect(
      BrowserAction.safeParse({
        type: 'upload',
        selector: '#cv',
        paths: Array.from({ length: 11 }, (_, index) => `workspace/file-${index}.pdf`)
      }).success
    ).toBe(false);
  });

  it('carries upload paths through as written so the runner can validate them itself', () => {
    // Traversal is rejected by the runner against a concrete workspace root, not by the shape:
    // the contract must not silently normalise a path and hide what the model actually asked for.
    expect(
      BrowserAction.parse({ type: 'upload', selector: '#cv', paths: ['workspace/cv.pdf'] })
    ).toEqual({ type: 'upload', selector: '#cv', paths: ['workspace/cv.pdf'] });
  });

  it('scrolls the page by default and a named container on request', () => {
    expect(BrowserAction.parse({ type: 'scroll', deltaY: 600 })).toEqual({
      type: 'scroll',
      deltaX: 0,
      deltaY: 600
    });
    expect(
      BrowserAction.parse({
        type: 'scroll',
        selector: '[data-athanor-ref="oc-0-9"]',
        deltaY: -200
      })
    ).toEqual({
      type: 'scroll',
      selector: '[data-athanor-ref="oc-0-9"]',
      deltaX: 0,
      deltaY: -200
    });
  });

  it('rejects an unknown action type', () => {
    expect(BrowserAction.safeParse({ type: 'drag', selector: '#a' }).success).toBe(false);
  });
});

describe('web fetch contract', () => {
  /**
   * One capability, called two ways. A provider-side fetch takes a single URL per call; athanor's
   * own route takes a batch. The names have to match in both modes - a model shown two tools for
   * one job picks badly, and a name that changed with the privacy route would change the prompt
   * prefix mid-task - so both shapes arrive at the same request here.
   */
  it('accepts one URL and a batch, and normalises both to a list', () => {
    expect(WebFetchRequest.parse({ url: 'https://example.invalid/a' })).toEqual({
      urls: ['https://example.invalid/a'],
      maxCharactersPerPage: 12_000
    });
    expect(
      WebFetchRequest.parse({
        urls: ['https://example.invalid/a', 'https://example.invalid/b'],
        maxCharactersPerPage: 20_000
      })
    ).toEqual({
      urls: ['https://example.invalid/a', 'https://example.invalid/b'],
      maxCharactersPerPage: 20_000
    });
    expect(
      WebFetchRequest.parse({
        url: 'https://example.invalid/first',
        urls: ['https://example.invalid/b']
      }).urls
    ).toEqual(['https://example.invalid/first', 'https://example.invalid/b']);
  });

  it('needs at least one address, and never more than a turn can afford to open', () => {
    expect(WebFetchRequest.safeParse({}).success).toBe(false);
    expect(WebFetchRequest.safeParse({ urls: [] }).success).toBe(false);
    expect(WebFetchRequest.safeParse({ url: 'not-a-url' }).success).toBe(false);
    expect(
      WebFetchRequest.safeParse({
        urls: Array.from({ length: 13 }, (_, index) => `https://example.invalid/${index}`)
      }).success
    ).toBe(false);
  });
});
