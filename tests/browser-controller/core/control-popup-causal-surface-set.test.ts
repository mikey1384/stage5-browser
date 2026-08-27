import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

import { BrowserController } from '../../../src/browser-controller.js';
import { browserConfig, cleanBrowserControllerTestState, listen } from '../../browser-controller-fixture.js';

let server: Server | undefined;
let controller: BrowserController | undefined;
let temporaryRoot: string | undefined;

afterEach(async () => {
  await cleanBrowserControllerTestState({ controller, server, temporaryRoot });
  controller = undefined;
  server = undefined;
  temporaryRoot = undefined;
});

async function openFixture(html: string): Promise<{ controller: BrowserController; page: Page }> {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  const port = await listen(server);
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-causal-surface-set-'));
  controller = new BrowserController(browserConfig(temporaryRoot));
  await controller.open({
    url: `http://127.0.0.1:${port}/form`,
    newTab: false,
    stabilizationMs: 0,
    timeoutMs: 5_000,
  });
  return {
    controller,
    page: (controller as unknown as { activePage: Page }).activePage,
  };
}

describe('BrowserController causal popup surface sets', () => {
  it('composes sibling semantic groups inside one newly rendered positioned portal', async () => {
    const { controller: activeController, page } = await openFixture(`<!doctype html><html><head><style>
      body { margin: 0; min-height: 600px; position: relative; }
      #target { position: absolute; left: 20px; top: 20px; width: 180px; height: 40px; }
      #portal { position: absolute; left: 500px; top: 100px; width: 260px; padding: 8px; }
      [role=listbox] { height: 44px; }
    </style></head><body tabindex="-1">
      <button id="target" type="button">Ordinary field</button>
      <div id="portal" hidden>
        <div role="listbox"><div role="option">Choice 1</div></div>
        <div role="listbox"><div role="option">Choice 2</div></div>
        <div role="listbox"><div role="option">Choice 3</div></div>
        <div role="listbox"><div role="option">Choice 4</div></div>
        <div role="listbox"><div role="option">Choice 5</div></div>
        <div role="listbox"><div role="option">Choice 6</div></div>
        <div role="listbox"><div role="option">Choice 7</div></div>
      </div>
      <output id="opens">0</output>
      <script>
        const target = document.getElementById('target');
        const portal = document.getElementById('portal');
        const opens = document.getElementById('opens');
        target.addEventListener('click', () => {
          opens.value = String(Number(opens.value) + 1);
          portal.hidden = false;
          document.body.focus();
        });
      </script>
    </body></html>`);

    const inspected = await activeController.inspectControl({
      control: { role: 'button', name: 'Ordinary field', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    });

    expect(inspected.inspection).toMatchObject({
      optionsComplete: true,
      reveal: {
        openerActionDispatched: true,
        popupOpened: true,
        associationProof: 'post_dispatch_unique',
        surfaceProof: 'semantic_role',
        renderedPopupCount: 7,
      },
    });
    expect(inspected.inspection.options.map(({ name }) => name)).toEqual(['Choice 1', 'Choice 2', 'Choice 3', 'Choice 4', 'Choice 5', 'Choice 6', 'Choice 7']);
    await expect(page.locator('#opens').textContent()).resolves.toBe('1');
  });

  it('offers bounded agent judgment for an already-open logical surface set', async () => {
    const { controller: activeController, page } = await openFixture(`<!doctype html><html><head><style>
      body { margin: 0; min-height: 600px; position: relative; }
      #field, button { position: absolute; top: 20px; height: 40px; box-sizing: border-box; }
      #field { left: 20px; width: 180px; }
      #owner { left: 200px; width: 40px; }
      #competitor { left: 240px; width: 40px; }
      #portal { position: absolute; left: 20px; top: 60px; width: 260px; padding: 8px; }
      [role=listbox] { height: 44px; }
    </style></head><body tabindex="-1">
      <input id="field" role="textbox" aria-label="Ordinary field">
      <button id="owner" type="button" aria-label="Ordinary field">Open</button>
      <button id="competitor" type="button">Other field</button>
      <div id="portal">
        <div role="listbox"><div role="option">Choice 1</div></div>
        <div role="listbox"><div role="option">Choice 2</div></div>
        <div role="listbox"><div role="option">Choice 3</div></div>
        <div role="listbox"><div role="option">Choice 4</div></div>
        <div role="listbox"><div role="option">Choice 5</div></div>
        <div role="listbox"><div role="option">Choice 6</div></div>
        <div role="listbox"><div role="option">Choice 7</div></div>
      </div>
      <output id="inputs">0</output>
      <script>
        for (const button of document.querySelectorAll('button')) {
          button.addEventListener('click', () => {
            inputs.value = String(Number(inputs.value) + 1);
          });
          button.addEventListener('keydown', () => {
            inputs.value = String(Number(inputs.value) + 1);
          });
        }
        document.body.focus();
      </script>
    </body></html>`);

    let failure: unknown;
    try {
      await activeController.inspectControl({
        control: { role: 'textbox', name: 'Ordinary field', exact: true },
        frameId: null,
        revealOptions: false,
        maxOptions: 20,
        timeoutMs: 5_000,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'AMBIGUOUS_TARGET',
      details: {
        actionDispatched: false,
        renderedPopupCount: 7,
        requestedControlIsCandidate: false,
        agentJudgmentAvailable: true,
      },
    });
    const ownerCandidates = (
      failure as {
        details: {
          ownerCandidates: Array<{
            role: string;
            name: string;
            ownerCandidateId?: string;
          }>;
        };
      }
    ).details.ownerCandidates;
    const owner = ownerCandidates.find(({ role, name }) => role === 'button' && name === 'Ordinary field');
    expect(owner?.ownerCandidateId).toMatch(/^popup-owner-candidate-[0-9a-f-]{36}$/u);

    const inspected = await activeController.inspectControl({
      control: { role: 'textbox', name: 'Ordinary field', exact: true },
      popupAssociation: {
        owner: 'observed_candidate',
        ownerCandidateId: owner!.ownerCandidateId!,
        basis: 'agent_semantic_judgment',
      },
      frameId: null,
      revealOptions: false,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    expect(inspected.inspection).toMatchObject({
      optionsComplete: true,
      reveal: {
        openerActionDispatched: false,
        associationProof: 'agent_declared',
        surfaceProof: 'semantic_role',
        renderedPopupCount: 7,
      },
    });
    expect(inspected.inspection.options.map(({ name }) => name)).toEqual(['Choice 1', 'Choice 2', 'Choice 3', 'Choice 4', 'Choice 5', 'Choice 6', 'Choice 7']);
    await expect(page.locator('#inputs').textContent()).resolves.toBe('0');
  });

  it('recovers an already-open logical popup when its requested composite node disappeared', async () => {
    const { controller: activeController, page } = await openFixture(`<!doctype html><html><head><style>
      body { margin: 0; min-height: 600px; position: relative; }
      button, #portal { position: absolute; left: 20px; width: 240px; box-sizing: border-box; }
      button { height: 40px; }
      #exterior-before { top: 0; }
      #owner { top: 80px; }
      #covered-competitor { top: 120px; }
      #uncovered-competitor { top: 160px; z-index: 3; }
      #exterior-after { top: 380px; }
      #portal { top: 60px; height: 300px; z-index: 2; border: 1px solid black; }
      [role=listbox] { height: 40px; }
    </style></head><body tabindex="-1">
      <button id="exterior-before" type="button">Earlier field</button>
      <button id="owner" type="button" aria-label="Ordinary field">Open</button>
      <button id="covered-competitor" type="button">Covered field</button>
      <button id="uncovered-competitor" type="button">Different field</button>
      <button id="exterior-after" type="button">Later field</button>
      <div id="portal">
        <div role="listbox"><div role="option">Choice 1</div></div>
        <div role="listbox"><div role="option">Choice 2</div></div>
        <div role="listbox"><div role="option">Choice 3</div></div>
        <div role="listbox"><div role="option">Choice 4</div></div>
        <div role="listbox"><div role="option">Choice 5</div></div>
        <div role="listbox"><div role="option">Choice 6</div></div>
        <div role="listbox"><div role="option">Choice 7</div></div>
      </div>
      <output id="inputs">0</output>
      <script>
        for (const button of document.querySelectorAll('button')) {
          button.addEventListener('click', () => {
            inputs.value = String(Number(inputs.value) + 1);
          });
          button.addEventListener('keydown', () => {
            inputs.value = String(Number(inputs.value) + 1);
          });
        }
        document.body.focus();
      </script>
    </body></html>`);

    const missingCompositeControl = {
      role: 'textbox' as const,
      name: 'Ordinary field',
      exact: true,
    };
    let failure: unknown;
    try {
      await activeController.inspectControl({
        control: missingCompositeControl,
        frameId: null,
        revealOptions: true,
        maxOptions: 20,
        timeoutMs: 5_000,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'AMBIGUOUS_TARGET',
      details: {
        reason: 'control_missing_with_open_popup',
        actionDispatched: false,
        renderedPopupCount: 7,
        requestedControlIsCandidate: false,
        agentJudgmentAvailable: true,
        ownerCandidatesTruncated: false,
        popupOwnership: {
          proofTier: 'spatial',
          candidateCount: 5,
          exteriorCandidateCount: 2,
          overlappingCandidateCount: 3,
          surfaceCoveredCandidateCount: 2,
          decision: 'covered_siblings_excluded',
        },
        controlRecovery: {
          requestedControlResolution: 'missing',
          popupOwnerDecision: 'required',
          activeCandidateCount: 5,
          exposedCandidateCount: 5,
          issuedCapabilityCount: 5,
          candidatesTruncated: false,
          requestedControlIsCandidate: false,
          agentJudgmentAvailable: true,
        },
      },
    });
    const ownerCandidates = (
      failure as {
        details: {
          ownerCandidates: Array<{
            role: string;
            name: string;
            ownerCandidateId?: string;
          }>;
        };
      }
    ).details.ownerCandidates;
    expect(ownerCandidates).toHaveLength(5);
    expect(ownerCandidates.every(({ ownerCandidateId }) => typeof ownerCandidateId === 'string')).toBe(true);
    const owner = ownerCandidates.find(({ role, name }) => role === 'button' && name === 'Ordinary field');
    expect(owner?.ownerCandidateId).toMatch(/^popup-owner-candidate-[0-9a-f-]{36}$/u);

    const inspected = await activeController.inspectControl({
      control: missingCompositeControl,
      popupAssociation: {
        owner: 'observed_candidate',
        ownerCandidateId: owner!.ownerCandidateId!,
        basis: 'agent_semantic_judgment',
      },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    expect(inspected.inspection).toMatchObject({
      optionsComplete: true,
      reveal: {
        openerActionDispatched: false,
        associationProof: 'agent_declared',
        renderedPopupCount: 7,
        popupOwnership: {
          proofTier: 'spatial',
          candidateCount: 5,
          exteriorCandidateCount: 2,
          overlappingCandidateCount: 3,
          surfaceCoveredCandidateCount: 2,
          decision: 'covered_siblings_excluded',
        },
        controlRecovery: {
          requestedControlResolution: 'recovered_observed_owner',
          popupOwnerDecision: 'consumed',
          activeCandidateCount: 5,
          exposedCandidateCount: null,
          issuedCapabilityCount: null,
          candidatesTruncated: null,
          requestedControlIsCandidate: false,
          agentJudgmentAvailable: true,
        },
      },
    });
    expect(inspected.inspection.options.map(({ name }) => name)).toEqual(['Choice 1', 'Choice 2', 'Choice 3', 'Choice 4', 'Choice 5', 'Choice 6', 'Choice 7']);
    await expect(page.locator('#inputs').textContent()).resolves.toBe('0');
  });

  it('does not reopen a vanished popup through a missing-control owner decision', async () => {
    const { controller: activeController, page } = await openFixture(`<!doctype html><html><head><style>
      body { margin: 0; min-height: 400px; position: relative; }
      #owner { position: absolute; left: 20px; top: 20px; width: 200px; height: 40px; }
      #portal { position: absolute; left: 20px; top: 60px; width: 200px; height: 80px; }
    </style></head><body>
      <button id="owner" aria-label="Ordinary field" aria-expanded="true">Open</button>
      <div id="portal" role="listbox"><div role="option">Choice 1</div></div>
      <output id="inputs">0</output>
      <script>
        owner.addEventListener('click', () => {
          inputs.value = String(Number(inputs.value) + 1);
          portal.hidden = false;
        });
      </script>
    </body></html>`);
    const control = {
      role: 'textbox' as const,
      name: 'Ordinary field',
      exact: true,
    };
    let failure: unknown;
    try {
      await activeController.inspectControl({
        control,
        frameId: null,
        revealOptions: false,
        maxOptions: 20,
        timeoutMs: 5_000,
      });
    } catch (error) {
      failure = error;
    }
    const ownerCandidates = (
      failure as {
        details: {
          ownerCandidates: Array<{
            role: string;
            name: string;
            ownerCandidateId?: string;
          }>;
        };
      }
    ).details.ownerCandidates;
    const ownerCandidateId = ownerCandidates.find(({ role, name }) => role === 'button' && name === control.name)?.ownerCandidateId;
    expect(ownerCandidateId).toBeDefined();
    await page.locator('#portal').evaluate((portal) => {
      portal.hidden = true;
    });

    await expect(
      activeController.inspectControl({
        control,
        popupAssociation: {
          owner: 'observed_candidate',
          ownerCandidateId: ownerCandidateId!,
          basis: 'agent_semantic_judgment',
        },
        frameId: null,
        revealOptions: true,
        maxOptions: 20,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({
      code: 'TARGET_NOT_FOUND',
      details: {
        reason: 'popup_owner_candidate_surface_changed',
        actionDispatched: false,
      },
    });
    await expect(page.locator('#inputs').textContent()).resolves.toBe('0');
  });

  it('does not compose newly rendered surfaces from independent positioned portals', async () => {
    const { controller: activeController, page } = await openFixture(`<!doctype html><html><head><style>
      body { margin: 0; min-height: 600px; position: relative; }
      #target { position: absolute; left: 20px; top: 20px; width: 180px; height: 40px; }
      #overlay { position: fixed; inset: 0; }
      .portal { position: absolute; top: 120px; width: 220px; }
      #portal-a { left: 320px; }
      #portal-b { left: 700px; }
    </style></head><body tabindex="-1">
      <button id="target" type="button">Ordinary field</button>
      <div id="overlay" hidden>
        <div id="portal-a" class="portal">
          <div role="listbox"><div role="option">First independent choice</div></div>
        </div>
        <div id="portal-b" class="portal">
          <div role="listbox"><div role="option">Second independent choice</div></div>
        </div>
      </div>
      <output id="opens">0</output>
      <script>
        const target = document.getElementById('target');
        const opens = document.getElementById('opens');
        target.addEventListener('click', () => {
          opens.value = String(Number(opens.value) + 1);
          document.getElementById('overlay').hidden = false;
          document.body.focus();
        });
      </script>
    </body></html>`);

    await expect(
      activeController.inspectControl({
        control: { role: 'button', name: 'Ordinary field', exact: true },
        frameId: null,
        revealOptions: true,
        maxOptions: 20,
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({
      details: {
        actionDispatched: true,
        renderedPopupCount: 2,
      },
    });
    await expect(page.locator('#opens').textContent()).resolves.toBe('1');
  });
});
