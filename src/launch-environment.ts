import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function configurePlaywrightBrowsersPath(
  env: NodeJS.ProcessEnv = process.env,
  launcherUrl: string | URL = import.meta.url,
): string {
  const packageRoot = fileURLToPath(new URL('../', launcherUrl));
  const configured = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  const resolved =
    configured === undefined || configured.length === 0
      ? path.join(packageRoot, '.playwright-browsers')
      : path.isAbsolute(configured)
        ? configured
        : path.resolve(packageRoot, configured);
  env.PLAYWRIGHT_BROWSERS_PATH = resolved;
  return resolved;
}
