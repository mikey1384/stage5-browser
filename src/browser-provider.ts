import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { chromium, firefox, webkit, type BrowserType } from 'playwright';

import { Stage5BrowserError } from './errors.js';

export const SUPPORTED_BROWSER_PRODUCTS = [
  'chromium',
  'chrome',
  'brave',
  'edge',
  'firefox',
  'webkit',
] as const;

export type BrowserProduct = (typeof SUPPORTED_BROWSER_PRODUCTS)[number];
export type InstalledChromiumProduct = 'chrome' | 'brave' | 'edge';
export type BrowserEngine = 'chromium' | 'firefox' | 'webkit';
export type BrowserExecutableSource = 'bundled' | 'configured' | 'discovered';

export interface BrowserLaunchTarget {
  browser: BrowserProduct;
  engine: BrowserEngine;
  executablePath: string | null;
  source: BrowserExecutableSource;
}

export interface BrowserAvailability {
  browser: BrowserProduct;
  engine: BrowserEngine;
  available: boolean;
  source: BrowserExecutableSource | null;
  reason: string | null;
}

export interface BrowserSelection {
  browser: BrowserProduct;
  executablePath: string | null;
}

export interface BrowserDiscoveryContext {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

const DISPLAY_NAMES: Record<BrowserProduct, string> = {
  chromium: 'bundled Chromium',
  chrome: 'Google Chrome',
  brave: 'Brave',
  edge: 'Microsoft Edge',
  firefox: 'bundled Firefox',
  webkit: 'bundled WebKit',
};

export const BROWSER_ENGINES: Record<BrowserProduct, BrowserEngine> = {
  chromium: 'chromium',
  chrome: 'chromium',
  brave: 'chromium',
  edge: 'chromium',
  firefox: 'firefox',
  webkit: 'webkit',
};

const PLAYWRIGHT_BROWSER_TYPES: Record<BrowserEngine, BrowserType> = {
  chromium,
  firefox,
  webkit,
};

export function playwrightBrowserType(engine: BrowserEngine): BrowserType {
  return PLAYWRIGHT_BROWSER_TYPES[engine];
}

export function browserExecutableCandidates(
  browser: InstalledChromiumProduct,
  context: BrowserDiscoveryContext = {},
): string[] {
  const platform = context.platform ?? process.platform;
  const env = context.env ?? process.env;
  const homeDir = context.homeDir ?? os.homedir();
  let candidates: string[];

  if (platform === 'darwin') {
    const applications = ['/Applications', path.posix.join(homeDir, 'Applications')];
    const relativeExecutable = {
      chrome: 'Google Chrome.app/Contents/MacOS/Google Chrome',
      brave: 'Brave Browser.app/Contents/MacOS/Brave Browser',
      edge: 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    }[browser];
    candidates = applications.map((directory) => path.posix.join(directory, relativeExecutable));
  } else if (platform === 'win32') {
    const roots = [env.LOCALAPPDATA, env.PROGRAMFILES, env['PROGRAMFILES(X86)']].filter(
      (value): value is string => value !== undefined && value.length > 0,
    );
    const relativeExecutables: Record<InstalledChromiumProduct, string[]> = {
      chrome: ['Google\\Chrome\\Application\\chrome.exe'],
      brave: ['BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
      edge: ['Microsoft\\Edge\\Application\\msedge.exe'],
    };
    candidates = roots.flatMap((root) =>
      relativeExecutables[browser].map((relativeExecutable) => path.win32.join(root, relativeExecutable)),
    );
  } else {
    const executableNames: Record<InstalledChromiumProduct, string[]> = {
      chrome: ['google-chrome-stable', 'google-chrome'],
      brave: ['brave-browser', 'brave-browser-stable'],
      edge: ['microsoft-edge-stable', 'microsoft-edge'],
    };
    const standardDirectories = ['/usr/local/bin', '/usr/bin', '/snap/bin'];
    candidates = standardDirectories.flatMap((directory) =>
      executableNames[browser].map((executableName) => path.posix.join(directory, executableName)),
    );
    if (browser === 'chrome') {
      candidates.push('/opt/google/chrome/google-chrome');
    } else if (browser === 'brave') {
      candidates.push('/opt/brave.com/brave/brave-browser');
    } else {
      candidates.push('/opt/microsoft/msedge/msedge');
    }
  }

  return [...new Set(candidates)];
}

async function executableFile(candidate: string, platform: NodeJS.Platform): Promise<string | null> {
  try {
    await access(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
    const metadata = await stat(candidate);
    return metadata.isFile() ? await realpath(candidate) : null;
  } catch {
    return null;
  }
}

export async function resolveBrowserLaunchTarget(
  selection: BrowserSelection,
  context: BrowserDiscoveryContext = {},
): Promise<BrowserLaunchTarget> {
  const platform = context.platform ?? process.platform;
  const engine = BROWSER_ENGINES[selection.browser];

  if (selection.executablePath !== null) {
    if (!path.isAbsolute(selection.executablePath)) {
      throw new Stage5BrowserError(
        'BROWSER_NOT_READY',
        'STAGE5_BROWSER_EXECUTABLE_PATH must be an absolute path to a trusted browser executable.',
        { details: { browser: selection.browser, reason: 'path_not_absolute' } },
      );
    }

    const executablePath = await executableFile(selection.executablePath, platform);
    if (executablePath === null) {
      throw new Stage5BrowserError(
        'BROWSER_NOT_READY',
        'STAGE5_BROWSER_EXECUTABLE_PATH does not point to an executable file.',
        { details: { browser: selection.browser, reason: 'path_not_executable' } },
      );
    }

    return { browser: selection.browser, engine, executablePath, source: 'configured' };
  }

  if (selection.browser === 'chromium' || selection.browser === 'firefox' || selection.browser === 'webkit') {
    const bundledExecutable = playwrightBrowserType(engine).executablePath();
    if ((await executableFile(bundledExecutable, platform)) === null) {
      throw new Stage5BrowserError(
        'BROWSER_NOT_READY',
        `${DISPLAY_NAMES[selection.browser]} is not installed. Run npm run browser:install from Stage5 Browser.`,
        { recoverable: true, details: { browser: selection.browser, reason: 'bundled_browser_missing' } },
      );
    }
    return { browser: selection.browser, engine, executablePath: null, source: 'bundled' };
  }

  for (const candidate of browserExecutableCandidates(selection.browser, context)) {
    const executablePath = await executableFile(candidate, platform);
    if (executablePath !== null) {
      return { browser: selection.browser, engine, executablePath, source: 'discovered' };
    }
  }

  throw new Stage5BrowserError(
    'BROWSER_NOT_READY',
    `${DISPLAY_NAMES[selection.browser]} is selected, but Stage5 Browser could not find an installed executable. Install it or set STAGE5_BROWSER_EXECUTABLE_PATH.`,
    { recoverable: true, details: { browser: selection.browser, reason: 'installation_not_found' } },
  );
}

export async function browserAvailability(
  selection: BrowserSelection,
  context: BrowserDiscoveryContext = {},
): Promise<BrowserAvailability> {
  try {
    const target = await resolveBrowserLaunchTarget(selection, context);
    return {
      browser: target.browser,
      engine: target.engine,
      available: true,
      source: target.source,
      reason: null,
    };
  } catch (error) {
    if (!(error instanceof Stage5BrowserError)) {
      throw error;
    }
    const reason = typeof error.details?.reason === 'string' ? error.details.reason : 'unavailable';
    return {
      browser: selection.browser,
      engine: BROWSER_ENGINES[selection.browser],
      available: false,
      source: null,
      reason,
    };
  }
}
