import { describe, expect, it } from 'vitest';

import { MCP_TOOL_CONTRACTS } from '../src/mcp/tool-contracts.js';
import { MCP_TOOL_NAMES } from '../src/mcp/tool-names.js';
import { BROWSER_ACTION_LOOP, BROWSER_ACTION_MANAGERS, BROWSER_COMMAND_CONTRACTS, BROWSER_COMMAND_POLICY, BROWSER_CONTEXT_LAYERS, BROWSER_MANAGER_CAPABILITIES } from '../src/protocol.js';

describe('browser command manager contract', () => {
  it('assigns every command to exactly one bounded action-family owner', () => {
    const contracts = Object.values(BROWSER_COMMAND_CONTRACTS);
    expect(contracts).toHaveLength(Object.keys(BROWSER_COMMAND_POLICY).length);
    expect(new Set(Object.keys(BROWSER_COMMAND_CONTRACTS)).size).toBe(contracts.length);
    for (const manager of BROWSER_ACTION_MANAGERS) {
      expect(contracts.some((contract) => contract.manager === manager)).toBe(true);
    }
  });

  it('assigns every public tool to a browser, recovery, or coordination owner', () => {
    expect(Object.keys(MCP_TOOL_CONTRACTS).sort()).toEqual(Object.values(MCP_TOOL_NAMES).sort());
    for (const contract of Object.values(MCP_TOOL_CONTRACTS)) {
      if (contract.boundary === 'browser_worker') {
        expect(contract.workerCommand).not.toBeNull();
        expect(contract.manager).toBe(
          BROWSER_COMMAND_CONTRACTS[contract.workerCommand!].manager,
        );
      } else {
        expect(contract.workerCommand).toBeNull();
      }
    }
  });

  it('publishes one non-overlapping generic technique vocabulary for every manager', () => {
    expect(Object.keys(BROWSER_MANAGER_CAPABILITIES).sort()).toEqual([...BROWSER_ACTION_MANAGERS].sort());
    const techniques = Object.values(BROWSER_MANAGER_CAPABILITIES).flatMap((manager) => manager.techniques);
    expect(new Set(techniques).size).toBe(techniques.length);
    expect(BROWSER_ACTION_LOOP).toEqual([
      'observe',
      'plan',
      'preflight',
      'prepare',
      'dispatch_once',
      'reconcile',
      'finalize',
    ]);
  });

  it('makes durable, session, document, action, and private context boundaries explicit', () => {
    const entries = Object.values(BROWSER_CONTEXT_LAYERS).flat();
    expect(new Set(entries).size).toBe(entries.length);
    expect(BROWSER_CONTEXT_LAYERS.private_ephemeral).toContain('authentication_secret');
    expect(BROWSER_CONTEXT_LAYERS.durable).not.toContain('authentication_secret');
  });

  it('requires possible element or file input to use the no-replay phase engine', () => {
    for (const contract of Object.values(BROWSER_COMMAND_CONTRACTS)) {
      if (contract.dispatch !== 'element_input' && contract.dispatch !== 'file_transfer') continue;
      expect(['action_phases', 'form_workflow']).toContain(contract.phaseSystem);
      expect(contract.replay).toBe('never_after_possible_dispatch');
    }
  });

  it('keeps navigation, private handoff, reversible movement, and recovery under their state owners', () => {
    expect(BROWSER_COMMAND_CONTRACTS.open).toMatchObject({
      manager: 'navigation_manager',
      phaseSystem: 'navigation_state_machine',
      replay: 'never_after_possible_dispatch',
    });
    expect(BROWSER_COMMAND_CONTRACTS.requestLoginHandoff.phaseSystem).toBe('handoff_state_machine');
    expect(BROWSER_COMMAND_CONTRACTS.scroll.phaseSystem).toBe('bounded_reversible_loop');
    expect(BROWSER_COMMAND_CONTRACTS.setInputFiles.manager).toBe('transfer_manager');
    expect(BROWSER_COMMAND_CONTRACTS.dialogStatus.manager).toBe('dialog_manager');
    expect(BROWSER_COMMAND_CONTRACTS.testHang.phaseSystem).toBe('supervisor_recovery');
  });
});
