import {
  BROWSER_COMMAND_CONTRACTS,
  type BrowserActionManager,
  type BrowserCommandName,
} from '../protocol.js';
import { MCP_TOOL_NAMES as TOOL, type McpToolName } from './tool-names.js';

export type PublicToolManager = BrowserActionManager | 'coordination_manager' | 'telemetry_manager';

export interface PublicToolContract {
  manager: PublicToolManager;
  boundary: 'browser_worker' | 'host_supervisor' | 'lounge_store';
  workerCommand: BrowserCommandName | null;
}

function worker(workerCommand: BrowserCommandName): PublicToolContract {
  return {
    manager: BROWSER_COMMAND_CONTRACTS[workerCommand].manager,
    boundary: 'browser_worker',
    workerCommand,
  };
}

function host(manager: PublicToolManager, boundary: PublicToolContract['boundary']): PublicToolContract {
  return { manager, boundary, workerCommand: null };
}

const lounge = () => host('coordination_manager', 'lounge_store');
const recovery = () => host('recovery_manager', 'host_supervisor');

export const MCP_TOOL_CONTRACTS = {
  [TOOL.loungeJoin]: lounge(),
  [TOOL.loungeSend]: lounge(),
  [TOOL.loungeWait]: lounge(),
  [TOOL.loungeAck]: lounge(),
  [TOOL.loungeStatus]: lounge(),
  [TOOL.loungePin]: lounge(),
  [TOOL.loungeSetWorkNote]: lounge(),
  [TOOL.loungeHistory]: lounge(),
  [TOOL.browserOperationStatus]: recovery(),
  [TOOL.browserExecutionTraces]: host('telemetry_manager', 'host_supervisor'),
  [TOOL.browserPageEvents]: worker('pageEvents'),
  [TOOL.browserStatus]: worker('status'),
  [TOOL.browserAvailable]: worker('availableBrowsers'),
  [TOOL.browserAvailableMoves]: worker('availableMoves'),
  [TOOL.browserDiagnostics]: worker('diagnostics'),
  [TOOL.browserStart]: worker('start'),
  [TOOL.browserSwitch]: worker('switchBrowser'),
  [TOOL.browserOpen]: worker('open'),
  [TOOL.browserTabs]: worker('tabs'),
  [TOOL.browserDownloads]: worker('downloads'),
  [TOOL.browserDialogStatus]: worker('dialogStatus'),
  [TOOL.browserWaitForDownload]: worker('waitForDownload'),
  [TOOL.browserSelectTab]: worker('selectTab'),
  [TOOL.browserActivateSelectedPage]: worker('activateSelectedPage'),
  [TOOL.browserInspectTab]: worker('inspectTab'),
  [TOOL.browserFrames]: worker('frames'),
  [TOOL.browserSnapshot]: worker('snapshot'),
  [TOOL.browserScreenshot]: worker('screenshot'),
  [TOOL.browserReserveOperation]: recovery(),
  [TOOL.browserClickByRole]: worker('clickByRole'),
  [TOOL.browserClickRef]: worker('clickRef'),
  [TOOL.browserSetInputFiles]: worker('setInputFiles'),
  [TOOL.browserFillByRole]: worker('fillByRole'),
  [TOOL.browserFillRef]: worker('fillRef'),
  [TOOL.browserFormSummary]: worker('formSummary'),
  [TOOL.browserApplyFormPlan]: worker('applyFormPlan'),
  [TOOL.browserSetChecked]: worker('setChecked'),
  [TOOL.browserInspectControl]: worker('inspectControl'),
  [TOOL.browserSelectOption]: worker('selectOption'),
  [TOOL.browserSelectOptions]: worker('selectOptions'),
  [TOOL.browserNavigateHistory]: worker('navigateHistory'),
  [TOOL.browserCloseTab]: worker('closeTab'),
  [TOOL.browserMotion]: worker('motion'),
  [TOOL.browserScroll]: worker('scroll'),
  [TOOL.browserFindText]: worker('findText'),
  [TOOL.browserWaitForUrl]: worker('waitForUrl'),
  [TOOL.browserPolicyStatus]: worker('policyStatus'),
  [TOOL.browserSetPolicy]: worker('setPolicy'),
  [TOOL.browserAuthStatus]: worker('authStatus'),
  [TOOL.browserPrivateFieldStatus]: worker('privateFieldStatus'),
  [TOOL.browserRequestPrivateFieldHandoff]: worker('requestPrivateFieldHandoff'),
  [TOOL.browserResumePrivateFieldHandoff]: worker('resumePrivateFieldHandoff'),
  [TOOL.browserRequestLoginHandoff]: worker('requestLoginHandoff'),
  [TOOL.browserResumeAfterLogin]: worker('resumeAfterLogin'),
  [TOOL.browserRecover]: recovery(),
  [TOOL.browserStop]: worker('stop'),
} as const satisfies Record<McpToolName, PublicToolContract>;
