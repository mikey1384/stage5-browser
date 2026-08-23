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
