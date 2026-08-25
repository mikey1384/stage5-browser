import { describe, expect, it } from 'vitest';

import { Stage5BrowserError } from '../src/errors.js';
import {
  authenticationRouteMatches,
  sanitizeUrlForJournal,
  validateNavigationUrl,
} from '../src/url-policy.js';

describe('navigation URL policy', () => {
  it('accepts absolute HTTP(S) URLs and about:blank', () => {
    expect(validateNavigationUrl('https://translator.tools/watch/example')).toBe(
      'https://translator.tools/watch/example',
    );
    expect(validateNavigationUrl('about:blank')).toBe('about:blank');
  });

  it('rejects embedded credentials and non-web protocols', () => {
    expect(() => validateNavigationUrl('https://user:secret@example.com/')).toThrow(Stage5BrowserError);
    expect(() => validateNavigationUrl('file:///etc/passwd')).toThrow(Stage5BrowserError);
    expect(() => validateNavigationUrl('javascript:alert(1)')).toThrow(Stage5BrowserError);
  });

  it('removes credentials, query strings, and fragments from journal URLs', () => {
    expect(sanitizeUrlForJournal('https://example.com/path?token=secret#private')).toBe(
      'https://example.com/path',
    );
  });

  it('matches an exact authentication route with an incidental site query', () => {
    expect(authenticationRouteMatches(
      'https://www.facebook.com/personal-profile?checkpoint_src=any',
      'https://www.facebook.com/personal-profile',
    )).toBe(true);
    expect(authenticationRouteMatches(
      'https://www.facebook.com/personal-profile?checkpoint_src=any',
      'https://www.facebook.com/other-profile',
    )).toBe(false);
    expect(authenticationRouteMatches(
      'https://m.facebook.com/personal-profile?checkpoint_src=any',
      'https://www.facebook.com/personal-profile',
    )).toBe(false);
  });

  it('keeps explicitly expected queries and fragments strict', () => {
    expect(authenticationRouteMatches(
      'https://example.com/account?view=personal&source=checkpoint',
      'https://example.com/account?view=personal',
    )).toBe(false);
    expect(authenticationRouteMatches(
      'https://example.com/account?source=checkpoint#security',
      'https://example.com/account',
    )).toBe(false);
    expect(authenticationRouteMatches(
      'https://example.com/account?source=checkpoint',
      'https://user:secret@example.com/account',
    )).toBe(false);
  });
});
