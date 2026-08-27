import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BrowserController } from '../../../src/browser-controller.js';
import { browserConfig, cleanBrowserControllerTestState, listen } from '../../browser-controller-fixture.js';

describe('BrowserController available moves', () => {
  let controller: BrowserController | undefined;
  let server: Server | undefined;
  let temporaryRoot: string | undefined;

  afterEach(async () => {
    await cleanBrowserControllerTestState({ controller, server, temporaryRoot });
    controller = undefined;
    server = undefined;
    temporaryRoot = undefined;
  });

  it('reports current disposable capabilities without page semantics or implicit startup', async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-available-moves-'));
    controller = new BrowserController(browserConfig(temporaryRoot));

    const stopped = await controller.availableMoves({ includeBlocked: true, maxMoves: 100 });
    expect(stopped.context).toMatchObject({
      lifecycleState: 'stopped',
      browserConnected: false,
      livePageCount: 0,
      selectedPage: false,
      controlMode: 'agent',
      capabilityCounts: {
        semanticSnapshots: 0,
        controlInspections: 0,
        popupOwnerCandidates: 0,
        formInspections: 0,
      },
    });
    expect(stopped.moves.find(({ moveId }) => moveId === 'start:start_profile')?.availability).toBe('available');
    await expect(controller.status()).resolves.toMatchObject({ state: 'stopped', browserConnected: false });

    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><body>
        <form>
          <label for="query">Query</label><input id="query">
          <label for="upload">Attachment</label><input id="upload" type="file">
          <button id="choices" type="button" aria-controls="options" aria-expanded="true">Choices</button>
          <div id="options" role="listbox"><div role="option">Alpha</div></div>
        </form>
        <div style="height:40px;overflow-y:auto"><div style="height:200px">Scrollable</div></div>
      </body></html>`);
    });
    const port = await listen(server);
    await controller.start({ browser: 'chromium' });
    await controller.open({
      url: `http://127.0.0.1:${port}/form`,
      newTab: false,
      stabilizationMs: 0,
      timeoutMs: 5_000,
    });

    const beforeObservation = await controller.availableMoves({ includeBlocked: true, maxMoves: 100 });
    expect(beforeObservation.moves.find(({ moveId }) => moveId === 'clickByRole:click')?.availability).toBe('available');
    expect(beforeObservation.moves.find(({ moveId }) => moveId === 'clickRef:click')?.availability).toBe('needs_preparation');

    await controller.tabs();
    await controller.snapshot({ depth: 8, boxes: false, frameId: null, timeoutMs: 5_000 });
    await controller.formSummary({ frameId: null, maxFields: 20, maxActions: 20, timeoutMs: 5_000 });
    await controller.inspectControl({
      control: { role: 'button', name: 'Choices', exact: true },
      frameId: null,
      revealOptions: false,
      maxOptions: 20,
      timeoutMs: 5_000,
    });

    const observed = await controller.availableMoves({ includeBlocked: true, maxMoves: 100 });
    expect(observed.context.capabilityCounts).toMatchObject({
      observedTabs: 1,
      semanticSnapshots: 1,
      snapshotRefs: expect.any(Number),
      fileInputRefs: 1,
      scrollContainerRefs: 1,
      controlInspections: 1,
      controlOptions: 1,
      popupOwnerCandidates: 0,
      formInspections: 1,
    });
    expect(observed.context.capabilityCounts.snapshotRefs).toBeGreaterThan(0);
    for (const moveId of [
      'clickRef:click',
      'setInputFiles:set_observed_file_input',
      'scroll:scroll_observed_container',
      'selectTab:select_tab',
      'applyFormPlan:apply_staged_plan',
    ]) {
      expect(observed.moves.find((move) => move.moveId === moveId)?.availability).toBe('available');
    }
    expect(JSON.stringify(observed)).not.toContain('127.0.0.1');
    expect(JSON.stringify(observed)).not.toContain('Choices');
  });
});
