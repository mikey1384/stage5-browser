import { realpath } from 'node:fs/promises';
import path from 'node:path';

import type { BrowserContext, Page } from 'playwright';

import type { BrowserEngine, BrowserLaunchTarget, BrowserProduct } from '../browser-provider.js';
import { playwrightBrowserType } from '../browser-provider.js';
import type { BrowserLaunchIdentity, BrowserProfileBinding, RuntimeProfileObservation } from './types.js';

const CHROMIUM_PROFILE_DIRECTORY = 'Default';

export function profileBindingForBrowser(profileRoot: string, engine: BrowserEngine): BrowserProfileBinding {
  if (engine === 'chromium') {
    return {
      storageKind: 'chromium_user_data',
      userDataDir: profileRoot,
      profileDirectory: CHROMIUM_PROFILE_DIRECTORY,
      profilePath: path.join(profileRoot, CHROMIUM_PROFILE_DIRECTORY),
    };
  }

  return {
    storageKind: engine === 'firefox' ? 'firefox_profile' : 'webkit_profile',
    userDataDir: null,
    profileDirectory: null,
    profilePath: profileRoot,
  };
}

export function executablePathForTarget(target: BrowserLaunchTarget): string {
  return target.executablePath ?? playwrightBrowserType(target.engine).executablePath();
}

export function applicationNameForTarget(target: BrowserLaunchTarget): string {
  const executablePath = executablePathForTarget(target);
  const appBundle = executablePath
    .split(path.sep)
    .find((segment) => segment.toLocaleLowerCase().endsWith('.app'));
  if (appBundle !== undefined) {
    return appBundle.slice(0, -4);
  }

  const fallback: Record<BrowserProduct, string> = {
    brave: 'Brave Browser',
    chrome: 'Google Chrome',
    chromium: 'Chromium',
    edge: 'Microsoft Edge',
    firefox: 'Firefox',
    webkit: 'WebKit',
  };
  return fallback[target.browser] ?? target.browser;
}

export function launchIdentityForTarget(
  target: BrowserLaunchTarget,
  profileRoot: string,
): BrowserLaunchIdentity {
  return {
    browser: target.browser,
    engine: target.engine,
    applicationName: applicationNameForTarget(target),
    executablePath: executablePathForTarget(target),
    executableSource: target.source,
    profile: profileBindingForBrowser(profileRoot, target.engine),
  };
}

export function sameLaunchIdentity(left: BrowserLaunchIdentity, right: BrowserLaunchIdentity): boolean {
  return left.browser === right.browser
    && left.engine === right.engine
    && left.executablePath === right.executablePath
    && left.profile.userDataDir === right.profile.userDataDir
    && left.profile.profileDirectory === right.profile.profileDirectory
    && left.profile.profilePath === right.profile.profilePath;
}

export function controlledProfileArguments(binding: BrowserProfileBinding): string[] {
  return binding.profileDirectory === null
    ? []
    : [`--profile-directory=${binding.profileDirectory}`];
}

function commandLineSwitchValue(arguments_: readonly string[], switchName: string): string | null {
  const prefix = `${switchName}=`;
  const inline = arguments_.find((argument) => argument.startsWith(prefix));
  if (inline !== undefined) {
    return inline.slice(prefix.length);
  }
  const index = arguments_.indexOf(switchName);
  return index >= 0 ? arguments_[index + 1] ?? null : null;
}

function safeRuntimeProfileDirectory(value: string | null): string | null {
  return value !== null
    && /^[A-Za-z0-9 _.-]{1,80}$/.test(value)
    && value !== '.'
    && value !== '..'
    ? value
    : null;
}

export function runtimeProfileFromChromiumArguments(
  arguments_: readonly string[],
  configured: BrowserProfileBinding,
  observedAt = new Date().toISOString(),
): RuntimeProfileObservation {
  const rawUserDataDir = commandLineSwitchValue(arguments_, '--user-data-dir');
  const rawProfileDirectory = commandLineSwitchValue(arguments_, '--profile-directory')
    ?? configured.profileDirectory
    ?? CHROMIUM_PROFILE_DIRECTORY;
  const userDataDir = rawUserDataDir !== null && path.isAbsolute(rawUserDataDir)
    ? path.normalize(rawUserDataDir)
    : null;
  const profileDirectory = safeRuntimeProfileDirectory(rawProfileDirectory);
  const profilePath = userDataDir === null || profileDirectory === null
    ? null
    : path.join(userDataDir, profileDirectory);
  return {
    observedAt,
    source: profilePath === null ? 'unavailable' : 'chromium_command_line',
    userDataDir,
    profileDirectory,
    profilePath,
    configuredProfilePath: configured.profilePath,
    matchesConfigured: profilePath === null
      ? null
      : path.resolve(profilePath) === path.resolve(configured.profilePath),
  };
}

export function runtimeProfileFromChromiumVersionPath(
  rawProfilePath: string,
  configured: BrowserProfileBinding,
  observedAt = new Date().toISOString(),
): RuntimeProfileObservation {
  const trimmedProfilePath = rawProfilePath.trim();
  const profilePath = path.isAbsolute(trimmedProfilePath)
    ? path.normalize(trimmedProfilePath)
    : null;
  const profileDirectory = profilePath === null
    ? null
    : safeRuntimeProfileDirectory(path.basename(profilePath));
  const userDataDir = profilePath === null || profileDirectory === null
    ? null
    : path.dirname(profilePath);
  return {
    observedAt,
    source: userDataDir === null ? 'unavailable' : 'chromium_version_page',
    userDataDir,
    profileDirectory,
    profilePath: userDataDir === null ? null : profilePath,
    configuredProfilePath: configured.profilePath,
    matchesConfigured: userDataDir === null || profilePath === null
      ? null
      : path.resolve(profilePath) === path.resolve(configured.profilePath),
  };
}

async function verifyRuntimeProfileMatch(
  observation: RuntimeProfileObservation,
): Promise<RuntimeProfileObservation> {
  if (observation.profilePath === null) {
    return observation;
  }
  try {
    const [runtimePath, configuredPath] = await Promise.all([
      realpath(observation.profilePath),
      realpath(observation.configuredProfilePath),
    ]);
    return {
      ...observation,
      matchesConfigured: runtimePath === configuredPath,
    };
  } catch {
    return observation;
  }
}

export async function inspectRuntimeProfile(
  context: BrowserContext,
  configured: BrowserProfileBinding,
  engine: BrowserEngine,
): Promise<RuntimeProfileObservation> {
  const unavailable = (): RuntimeProfileObservation => ({
    observedAt: new Date().toISOString(),
    source: 'unavailable',
    userDataDir: null,
    profileDirectory: null,
    profilePath: null,
    configuredProfilePath: configured.profilePath,
    matchesConfigured: null,
  });
  if (engine !== 'chromium') {
    return unavailable();
  }
  const page = context.pages().find((candidate) => !candidate.isClosed());
  if (page === undefined) {
    return unavailable();
  }
  try {
    const session = await context.newCDPSession(page);
    try {
      const response = await session.send('Browser.getBrowserCommandLine') as { arguments?: unknown };
      if (Array.isArray(response.arguments) && response.arguments.every((value) => typeof value === 'string')) {
        return verifyRuntimeProfileMatch(
          runtimeProfileFromChromiumArguments(response.arguments, configured),
        );
      }
    } finally {
      await session.detach().catch(() => undefined);
    }
  } catch {
    // Some Chromium products do not expose Browser.getBrowserCommandLine even
    // when controlled over CDP. chrome://version is Chromium's own source of
    // truth for the live Profile Path, so use a short-lived internal page as a
    // bounded fallback and return only that allowlisted field.
  }

  let versionPage: Page | undefined;
  try {
    versionPage = await context.newPage();
    await versionPage.goto('chrome://version', {
      waitUntil: 'domcontentloaded',
      timeout: 2_000,
    });
    const profilePath = await versionPage.locator('#profile_path').textContent({ timeout: 1_000 });
    return profilePath === null
      ? unavailable()
      : verifyRuntimeProfileMatch(
          runtimeProfileFromChromiumVersionPath(profilePath, configured),
        );
  } catch {
    return unavailable();
  } finally {
    await versionPage?.close().catch(() => undefined);
  }
}
