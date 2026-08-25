import { Stage5BrowserError } from './errors.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function validateNavigationUrl(value: string): string {
  if (value === 'about:blank') {
    return value;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Stage5BrowserError('INVALID_URL', 'Navigation requires an absolute HTTP or HTTPS URL.', {
      cause: error,
    });
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Stage5BrowserError('INVALID_URL', 'Only HTTP, HTTPS, and about:blank navigation are allowed.');
  }

  if (parsed.username !== '' || parsed.password !== '') {
    throw new Stage5BrowserError('INVALID_URL', 'Credentials must not be embedded in navigation URLs.');
  }

  return parsed.toString();
}

export function sanitizeUrlForJournal(value: string | undefined): string | undefined {
  if (value === undefined || value === '' || value === 'about:blank') {
    return value;
  }

  try {
    const parsed = new URL(value);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      return undefined;
    }
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/**
 * Authentication expectations prove the post-login route, not incidental query
 * metadata appended by the site. When the caller omits a query, an exact route
 * may therefore carry additional query parameters. Explicit queries, fragments,
 * origins, and pathnames remain strict.
 */
export function authenticationRouteMatches(actual: string, expected: string): boolean {
  try {
    const actualUrl = new URL(actual);
    const expectedUrl = new URL(expected);
    if (!ALLOWED_PROTOCOLS.has(actualUrl.protocol) || !ALLOWED_PROTOCOLS.has(expectedUrl.protocol)) {
      return actual === expected;
    }
    if (
      actualUrl.username !== ''
      || actualUrl.password !== ''
      || expectedUrl.username !== ''
      || expectedUrl.password !== ''
    ) {
      return actual === expected;
    }
    if (expectedUrl.search !== '') {
      return actualUrl.href === expectedUrl.href;
    }
    return actualUrl.origin === expectedUrl.origin
      && actualUrl.pathname === expectedUrl.pathname
      && actualUrl.hash === expectedUrl.hash;
  } catch {
    return actual === expected;
  }
}
