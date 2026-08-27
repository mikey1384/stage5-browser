import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

import { STAGE5_BROWSER_VERSION } from '../src/runtime-info.js';

let server: Server | undefined;
let client: Client | undefined;
let temporaryRoot: string | undefined;

async function listen(candidate: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    candidate.once('error', onError);
    candidate.listen(0, '127.0.0.1', () => {
      candidate.off('error', onError);
      resolve();
    });
  });
  const address = candidate.address();
  if (address === null || typeof address === 'string') throw new Error('MCP form fixture did not bind.');
  return address.port;
}

afterEach(async () => {
  await client?.callTool({ name: 'browser_stop', arguments: {} }).catch(() => undefined);
  await client?.close().catch(() => undefined);
  client = undefined;
  if (server?.listening === true) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }
  server = undefined;
  if (temporaryRoot !== undefined) await rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = undefined;
});

function structured(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

describe('MCP form fast paths and telemetry', () => {
  it('records atomic searchable selection and undispatched field rebinding through the built worker', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><body>
        <label for="country">Country</label>
        <input id="country" role="combobox" aria-autocomplete="list" aria-expanded="false">
        <div id="country-options" role="listbox" hidden></div>
        <label for="state">State</label><input id="state">
        <label for="zip">ZIP code</label><input id="zip">
        <output id="counts">country:0 enters:0 state:0 zip:0 replacements:0</output>
        <script>
          const stateCounts = { country: 0, enters: 0, state: 0, zip: 0, replacements: 0 };
          const render = () => {
            counts.value = Object.entries(stateCounts).map(([key, value]) => key + ':' + value).join(' ');
          };
          country.addEventListener('input', () => {
            stateCounts.country += 1;
            country.setAttribute('aria-expanded', 'true');
            country.setAttribute('aria-controls', 'country-options');
            country.setAttribute('aria-activedescendant', 'country-us');
            const options = document.querySelector('#country-options');
            options.hidden = false;
            options.innerHTML = '<div id="country-us" role="option">United States</div>';
            render();
          });
          country.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            stateCounts.enters += 1;
            country.setAttribute('aria-expanded', 'false');
            country.removeAttribute('aria-activedescendant');
            document.querySelector('#country-options').hidden = true;
            render();
          });
          const wireZip = (field) => field.addEventListener('input', () => {
            stateCounts.zip += 1;
            render();
          });
          wireZip(zip);
          state.addEventListener('input', () => {
            stateCounts.state += 1;
            if (stateCounts.replacements === 0) {
              const replacement = zip.cloneNode(true);
              zip.replaceWith(replacement);
              wireZip(replacement);
              stateCounts.replacements += 1;
            }
            render();
          });
        </script>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-mcp-form-fast-path-'));
    const projectRoot = path.resolve('.');
    client = new Client({ name: 'mcp-form-fast-path-test', version: STAGE5_BROWSER_VERSION });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [path.join(projectRoot, 'dist', 'launcher.js')],
      cwd: projectRoot,
      stderr: 'pipe',
      env: {
        ...getDefaultEnvironment(),
        PLAYWRIGHT_BROWSERS_PATH: path.join(projectRoot, '.playwright-browsers'),
        STAGE5_BROWSER_PROFILES_DIR: path.join(temporaryRoot, 'profiles'),
        STAGE5_BROWSER_PROFILE_DIR: path.join(temporaryRoot, 'profile'),
        STAGE5_BROWSER_ARTIFACTS_DIR: path.join(temporaryRoot, 'artifacts'),
        STAGE5_LOUNGE_DIR: path.join(temporaryRoot, 'lounge'),
        STAGE5_BROWSER_HEADLESS: '1',
        STAGE5_BROWSER_OPERATION_TIMEOUT_MS: '10000',
        STAGE5_BROWSER_NAVIGATION_TIMEOUT_MS: '10000',
      },
    }));
    await client.callTool({
      name: 'lounge_join',
      arguments: {
        agentId: 'mcp-form-fast-path-test',
        displayName: 'MCP Form Fast Path Test',
        provider: 'test',
        room: 'stage5-lounge',
      },
    });
    await client.callTool({ name: 'browser_start', arguments: { browser: 'chromium' } });
    await client.callTool({
      name: 'browser_open',
      arguments: { url: `http://127.0.0.1:${port}/form`, newTab: false, stabilizationMs: 0, timeoutMs: 10_000 },
    });

    const selected = await client.callTool({
      name: 'browser_select_option',
      arguments: {
        control: { role: 'combobox', name: 'Country', exact: true },
        option: { name: 'United States', exact: true },
        interaction: 'auto',
        frameId: null,
        timeoutMs: 10_000,
      },
    });
    expect(selected.isError).not.toBe(true);
    expect(selected.structuredContent).toMatchObject({
      result: {
        selectionSucceeded: true,
        interactionUsed: 'searchable_keyboard',
        selectedName: 'United States',
        popupOpen: false,
        nextAction: 'continue',
      },
    });
    expect((selected.structuredContent as { result?: Record<string, unknown> }).result)
      .not.toHaveProperty('evidence');
    const selectionOperationId = structured(selected).operationId;
    if (typeof selectionOperationId !== 'string') throw new Error('Selection omitted its operationId.');
    const selectionTelemetry = await client.callTool({
      name: 'browser_execution_traces',
      arguments: { operationId: selectionOperationId, limit: 5, detail: 'full' },
    });
    expect(selectionTelemetry.structuredContent).toMatchObject({
      traces: [{
        command: 'selectOption',
        agentId: 'mcp-form-fast-path-test',
        actions: expect.arrayContaining([
          expect.objectContaining({ action: 'fill_by_role', dispatchState: 'dispatched' }),
          expect.objectContaining({ action: 'press', dispatchState: 'dispatched' }),
        ]),
        conclusion: {
          selectionInteraction: 'searchable_keyboard',
          searchableSelection: {
            activeOptionProof: 'aria_activedescendant',
            queryActionDispatched: true,
            commitActionDispatched: true,
            selectionProof: 'value_and_popup_closed',
          },
        },
      }],
    });

    const summary = await client.callTool({
      name: 'browser_form_summary',
      arguments: { frameId: null, maxFields: 20, maxActions: 20, timeoutMs: 10_000 },
    });
    const form = (structured(summary).result as { formId: string; fields: Array<{ fieldId: string; name: string }> });
    const fieldId = (name: string) => form.fields.find((field) => field.name === name)?.fieldId;
    const stateId = fieldId('State');
    const zipId = fieldId('ZIP code');
    if (stateId === undefined || zipId === undefined) throw new Error('Form summary omitted the state/ZIP fixture.');
    const applied = await client.callTool({
      name: 'browser_apply_form_plan',
      arguments: {
        formId: form.formId,
        frameId: null,
        steps: [
          { kind: 'fill', fieldId: stateId, value: 'Wyoming' },
          { kind: 'fill', fieldId: zipId, value: '82001' },
        ],
        timeoutMs: 10_000,
      },
    });
    expect(applied.isError).not.toBe(true);
    expect(applied.structuredContent).toMatchObject({
      result: {
        fieldRebinding: { attempted: true, reboundSteps: 1, failed: false },
        completedSteps: [
          { fieldResolution: { resolution: 'retained_exact' } },
          { fieldResolution: { resolution: 'rebound_exact' } },
        ],
      },
    });
    const planOperationId = structured(applied).operationId;
    if (typeof planOperationId !== 'string') throw new Error('Form plan omitted its operationId.');
    const planTelemetry = await client.callTool({
      name: 'browser_execution_traces',
      arguments: { operationId: planOperationId, limit: 5, detail: 'full' },
    });
    expect(planTelemetry.structuredContent).toMatchObject({
      traces: [{
        command: 'applyFormPlan',
        conclusion: { formFieldRebinding: { attempted: true, reboundSteps: 1, failed: false } },
      }],
    });
  });
});
