import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';

import { BrowserController } from '../../../src/browser-controller.js';
import { browserConfig, cleanBrowserControllerTestState, listen } from '../../browser-controller-fixture.js';

describe('BrowserController popup-owner agent judgment capabilities', () => {
  const fundingControl = { role: 'textbox' as const, name: 'Funding sources', exact: true };
  let controller: BrowserController | undefined;
  let server: Server | undefined;
  let temporaryRoot: string | undefined;

  afterEach(async () => {
    await cleanBrowserControllerTestState({ controller, server, temporaryRoot });
    controller = undefined;
    server = undefined;
    temporaryRoot = undefined;
  });

  async function openFixture(): Promise<Page> {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><style>
        body { margin: 0; min-height: 320px; }
        input, button, #options { position: absolute; box-sizing: border-box; }
        #field { left: 20px; top: 20px; width: 200px; height: 40px; }
        #owner { left: 220px; top: 20px; width: 40px; height: 40px; }
        #options { left: 20px; top: 60px; width: 240px; height: 160px; border: 1px solid black; }
        #other { left: 20px; top: 220px; width: 240px; height: 40px; }
        #covered-a { left: 20px; top: 80px; width: 240px; height: 40px; }
        #covered-b { left: 20px; top: 120px; width: 240px; height: 40px; }
        #uncovered { left: 20px; top: 160px; width: 240px; height: 40px; z-index: 3; }
      </style></head><body tabindex="-1">
        <input id="field" role="textbox" aria-label="Funding sources" aria-multiselectable="true">
        <button id="owner" aria-label="Funding sources">Open</button>
        <div id="options" role="listbox" aria-multiselectable="true">
          <div id="choice" role="option" aria-selected="false">Company capital</div>
        </div>
        <button id="other">Other exterior field</button>
        <button id="covered-a">Covered field A</button>
        <button id="covered-b">Covered field B</button>
        <button id="uncovered">Uncovered field</button>
        <output id="inputs">0</output>
        <script>
          for (const target of [...document.querySelectorAll('button'), choice]) {
            target.addEventListener('click', () => { inputs.value = String(Number(inputs.value) + 1); });
            target.addEventListener('keydown', () => { inputs.value = String(Number(inputs.value) + 1); });
          }
          document.body.focus();
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-popup-agent-judgment-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({
      url: `http://127.0.0.1:${port}/form`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });
    return (controller as unknown as { activePage: Page }).activePage;
  }

  async function observeOwnerCandidateId(): Promise<string> {
    let failure: unknown;
    try {
      await controller?.inspectControl({
        control: fundingControl,
        frameId: null,
        revealOptions: false,
        maxOptions: 20,
        timeoutMs: 5_000,
      });
    } catch (error) {
      failure = error;
    }
    const candidates = (failure as {
      details: { ownerCandidates: Array<{ role: string; name: string; ownerCandidateId?: string }> };
    }).details.ownerCandidates;
    const candidateId = candidates.find(({ role, name }) =>
      role === 'button' && name === fundingControl.name)?.ownerCandidateId;
    expect(candidateId).toBeDefined();
    return candidateId!;
  }

  it('revalidates the chosen owner before selection and consumes its capability once', async () => {
    const page = await openFixture();
    const ownerCandidateId = await observeOwnerCandidateId();
    const decisionMoves = await controller?.availableMoves({ includeBlocked: true, maxMoves: 100 });
    expect(decisionMoves?.context.capabilityCounts.popupOwnerCandidates).toBeGreaterThan(0);
    expect(decisionMoves?.moves.find(({ moveId }) =>
      moveId === 'inspectControl:declare_popup_owner_from_observed_candidates')?.availability)
      .toBe('available');

    const inspected = await controller?.inspectControl({
      control: fundingControl,
      popupAssociation: {
        owner: 'observed_candidate',
        ownerCandidateId: ownerCandidateId!,
        basis: 'agent_semantic_judgment',
      },
      frameId: null,
      revealOptions: false,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    const consumedMoves = await controller?.availableMoves({ includeBlocked: true, maxMoves: 100 });
    expect(consumedMoves?.context.capabilityCounts.popupOwnerCandidates).toBe(0);
    const optionId = inspected?.inspection.options[0]?.optionId;
    await page.locator('#owner').evaluate((owner) => owner.setAttribute('aria-label', 'Changed owner'));

    let selectionFailure: unknown;
    try {
      await controller?.selectOption({
        inspectionId: inspected!.inspection.inspectionId,
        optionId: optionId!,
        control: null,
        option: null,
        selected: true,
        frameId: null,
        timeoutMs: 5_000,
      });
    } catch (error) {
      selectionFailure = error;
    }
    expect(selectionFailure).toMatchObject({ details: { actionDispatched: false } });
    expect(['AMBIGUOUS_TARGET', 'TARGET_NOT_FOUND']).toContain(
      (selectionFailure as { code: string }).code,
    );
    expect(['ambiguous_control_popup_after_rebind', 'control_popup_changed']).toContain(
      (selectionFailure as { details: { reason: string } }).details.reason,
    );
    await expect(page.locator('#inputs').textContent()).resolves.toBe('0');

    await expect(controller?.inspectControl({
      control: fundingControl,
      popupAssociation: {
        owner: 'observed_candidate',
        ownerCandidateId: ownerCandidateId!,
        basis: 'agent_semantic_judgment',
      },
      frameId: null,
      revealOptions: false,
      maxOptions: 20,
      timeoutMs: 5_000,
    })).rejects.toMatchObject({
      code: 'TARGET_NOT_FOUND',
      details: { reason: 'stale_popup_owner_candidate', actionDispatched: false },
    });
    await expect(page.locator('#inputs').textContent()).resolves.toBe('0');
  });

  it('binds a candidate capability to the exact requested control', async () => {
    const page = await openFixture();
    const ownerCandidateId = await observeOwnerCandidateId();

    await expect(controller?.inspectControl({
      control: { role: 'button', name: 'Other exterior field', exact: true },
      popupAssociation: {
        owner: 'observed_candidate',
        ownerCandidateId,
        basis: 'agent_semantic_judgment',
      },
      frameId: null,
      revealOptions: false,
      maxOptions: 20,
      timeoutMs: 5_000,
    })).rejects.toMatchObject({
      code: 'OPERATION_FAILED',
      details: { reason: 'popup_owner_candidate_control_mismatch', actionDispatched: false },
    });

    await expect(controller?.inspectControl({
      control: fundingControl,
      popupAssociation: {
        owner: 'observed_candidate',
        ownerCandidateId,
        basis: 'agent_semantic_judgment',
      },
      frameId: null,
      revealOptions: false,
      maxOptions: 20,
      timeoutMs: 5_000,
    })).rejects.toMatchObject({
      code: 'TARGET_NOT_FOUND',
      details: { reason: 'stale_popup_owner_candidate', actionDispatched: false },
    });
    await expect(page.locator('#inputs').textContent()).resolves.toBe('0');
  });
});
