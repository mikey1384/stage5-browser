import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

import { type BrowserLaunchTarget, type BrowserProduct } from './browser-provider.js';
import { Stage5BrowserError } from './errors.js';
import {
  executablePathForTarget,
  launchIdentityForTarget,
  type BrowserLaunchIdentity,
} from './profile-binding.js';
import {
  nativeControlEndpoint,
  processIsRunning,
  type NativeControlRecord,
  writeNativeControlRecord,
} from './native-control-channel.js';

export {
  compareProfileExitMarker,
  inspectProfileShutdown,
  profileLocks,
  waitForProfileUnlock,
  type ProfileExitMarkerComparison,
  type ProfileShutdownDecision,
  type ProfileShutdownInspection,
  type ProfileShutdownState,
} from './human-auth-profile.js';

export interface HumanBrowserProcessState {
  running: boolean;
  processId: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  launchedAt: string;
}

export interface HumanBrowserSession {
  state(): HumanBrowserProcessState;
  identity(): BrowserLaunchIdentity;
  controlChannel?(): HumanBrowserControlChannel | null;
  waitForExit(timeoutMs: number): Promise<boolean>;
}

export interface HumanBrowserControlChannel {
  kind: 'chromium_cdp';
  endpointUrl: string;
}

export interface HumanBrowserLaunchInput {
  target: BrowserLaunchTarget;
  profileDir: string;
  handoffLabel: string;
  url: string;
}

export interface HumanBrowserLauncher {
  launch(input: HumanBrowserLaunchInput): Promise<HumanBrowserSession>;
}

export interface HumanBrowserLaunchPolicy {
  supported: boolean;
  browser: BrowserProduct;
  engine: BrowserLaunchTarget['engine'];
  controlledByPlaywright: false;
  automationFlagsPresent: false;
  argumentKinds: Array<
    | 'identity_marker'
    | 'loopback_debugging'
    | 'new_window'
    | 'profile_directory'
    | 'profile_partition'
  >;
}

const HANDOFF_MARKER_PREFIX = 'data:text/html;charset=utf-8,';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function stage5HandoffMarkerUrl(label: string): string {
  const safeLabel = escapeHtml(label.slice(0, 200));
  const document = `<!doctype html><html><head><meta charset="utf-8"><meta name="stage5-browser-handoff" content="true"><title>${safeLabel}</title><style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;margin:0;display:grid;place-items:center;min-height:100vh}main{max-width:42rem;padding:3rem}h1{font-size:2rem}p{color:#cbd5e1;line-height:1.5}</style></head><body><main><h1>${safeLabel}</h1><p>This marker identifies the dedicated Stage5 private-interaction window. Complete only the private step in the adjacent tab, then follow the agent’s backend-specific resume instruction.</p></main></body></html>`;
  return `${HANDOFF_MARKER_PREFIX}${encodeURIComponent(document)}`;
}

export function isStage5HandoffMarkerUrl(value: string): boolean {
  if (!value.startsWith(HANDOFF_MARKER_PREFIX)) {
    return false;
  }
  try {
    return decodeURIComponent(value.slice(HANDOFF_MARKER_PREFIX.length))
      .includes('<meta name="stage5-browser-handoff" content="true">');
  } catch {
    return false;
  }
}

export function humanBrowserLaunchPolicy(target: BrowserLaunchTarget): HumanBrowserLaunchPolicy {
  return {
    supported: target.engine === 'chromium' || target.engine === 'firefox',
    browser: target.browser,
    engine: target.engine,
    controlledByPlaywright: false,
    automationFlagsPresent: false,
    argumentKinds: target.engine === 'chromium'
      ? ['profile_directory', 'profile_partition', 'loopback_debugging', 'identity_marker', 'new_window']
      : ['profile_directory', 'identity_marker', 'new_window'],
  };
}

export function humanBrowserArguments(
  input: HumanBrowserLaunchInput,
  chromiumDebuggingPort: number | null = null,
): string[] {
  const identity = launchIdentityForTarget(input.target, input.profileDir);
  const markerUrl = stage5HandoffMarkerUrl(input.handoffLabel);
  if (input.target.engine === 'chromium') {
    return [
      `--user-data-dir=${identity.profile.userDataDir}`,
      `--profile-directory=${identity.profile.profileDirectory}`,
      ...(chromiumDebuggingPort === null
        ? []
        : [
            '--remote-debugging-address=127.0.0.1',
            `--remote-debugging-port=${chromiumDebuggingPort}`,
          ]),
      '--new-window',
      markerUrl,
      input.url,
    ];
  }
  if (input.target.engine === 'firefox') {
    return [
      '-no-remote',
      '-wait-for-browser',
      '-foreground',
      '-profile',
      input.profileDir,
      '-new-window',
      markerUrl,
      '-new-tab',
      input.url,
    ];
  }
  throw new Stage5BrowserError(
    'AUTH_HANDOFF_UNAVAILABLE',
    'Human authentication bootstrap is not available for the selected browser engine.',
    {
      recoverable: true,
      details: {
        reason: 'human_bootstrap_engine_unsupported',
        browser: input.target.browser,
        engine: input.target.engine,
        suggestedAction: 'Select Brave, Chrome, Edge, Chromium, or Firefox for the human authentication bootstrap.',
      },
    },
  );
}

class SpawnedHumanBrowserSession implements HumanBrowserSession {
  private running = true;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private readonly launchedAt = new Date().toISOString();

  constructor(
    private readonly child: ChildProcess,
    private readonly launchIdentity: BrowserLaunchIdentity,
    private readonly channel: HumanBrowserControlChannel | null,
  ) {
    child.once('exit', (code, signal) => {
      this.running = false;
      this.exitCode = code;
      this.exitSignal = signal;
    });
  }

  state(): HumanBrowserProcessState {
    return {
      running: this.running && this.child.exitCode === null && this.child.signalCode === null,
      processId: this.child.pid ?? null,
      exitCode: this.exitCode ?? this.child.exitCode,
      exitSignal: this.exitSignal ?? this.child.signalCode,
      launchedAt: this.launchedAt,
    };
  }

  identity(): BrowserLaunchIdentity {
    return this.launchIdentity;
  }

  controlChannel(): HumanBrowserControlChannel | null {
    return this.channel;
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.state().running) {
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.child.off('exit', onExit);
        resolve(false);
      }, timeoutMs);
      this.child.once('exit', onExit);
      if (!this.state().running) {
        this.child.off('exit', onExit);
        clearTimeout(timer);
        resolve(true);
      }
    });
  }
}

class RestoredNativeHumanBrowserSession implements HumanBrowserSession {
  constructor(
    private readonly record: NativeControlRecord,
    private readonly launchIdentity: BrowserLaunchIdentity,
  ) {}

  state(): HumanBrowserProcessState {
    return {
      running: processIsRunning(this.record.processId),
      processId: this.record.processId,
      exitCode: null,
      exitSignal: null,
      launchedAt: this.record.createdAt,
    };
  }

  identity(): BrowserLaunchIdentity {
    return this.launchIdentity;
  }

  controlChannel(): HumanBrowserControlChannel {
    return {
      kind: 'chromium_cdp',
      endpointUrl: nativeControlEndpoint(this.record),
    };
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    const deadlineAt = Date.now() + Math.max(1, timeoutMs);
    while (processIsRunning(this.record.processId) && Date.now() < deadlineAt) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadlineAt - Date.now())));
    }
    return !processIsRunning(this.record.processId);
  }
}

export function restoreNativeHumanBrowserSession(
  record: NativeControlRecord,
  identity: BrowserLaunchIdentity,
): HumanBrowserSession {
  if (record.state !== 'awaiting_user' || record.browser !== identity.browser) {
    throw new Error('Refusing to restore a native human session from a mismatched control record.');
  }
  return new RestoredNativeHumanBrowserSession(record, identity);
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Could not reserve a loopback browser-control port.');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  return address.port;
}

export class NativeHumanBrowserLauncher implements HumanBrowserLauncher {
  constructor(private readonly debuggingPortAllocator: () => Promise<number> = reserveLoopbackPort) {}

  async launch(input: HumanBrowserLaunchInput): Promise<HumanBrowserSession> {
    const policy = humanBrowserLaunchPolicy(input.target);
    if (!policy.supported) {
      humanBrowserArguments(input);
    }

    const identity = launchIdentityForTarget(input.target, input.profileDir);
    const debuggingPort = input.target.engine === 'chromium'
      ? await this.debuggingPortAllocator()
      : null;
    const child = spawn(executablePathForTarget(input.target), humanBrowserArguments(input, debuggingPort), {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
      windowsHide: false,
    });
    await new Promise<void>((resolve, reject) => {
      const onSpawn = (): void => {
        child.off('error', onError);
        resolve();
      };
      const onError = (error: Error): void => {
        child.off('spawn', onSpawn);
        reject(error);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
    if (child.pid === undefined) {
      child.kill('SIGTERM');
      throw new Error('The native browser process did not expose a process ID.');
    }
    const controlRecord = debuggingPort === null
      ? null
      : {
          version: 1 as const,
          kind: 'chromium_cdp' as const,
          browser: input.target.browser,
          state: 'awaiting_user' as const,
          processId: child.pid,
          port: debuggingPort,
          createdAt: new Date().toISOString(),
        };
    const channel: HumanBrowserControlChannel | null = controlRecord === null
      ? null
      : { kind: 'chromium_cdp', endpointUrl: nativeControlEndpoint(controlRecord) };
    if (controlRecord !== null) {
      try {
        await writeNativeControlRecord(input.profileDir, controlRecord);
      } catch (error) {
        child.kill('SIGTERM');
        throw error;
      }
    }
    child.unref();
    return new SpawnedHumanBrowserSession(child, identity, channel);
  }
}
