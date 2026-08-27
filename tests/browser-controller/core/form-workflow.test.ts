import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

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

async function openForm(): Promise<void> {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><body>
      <form aria-label="Company profile">
        <label for="legal">Legal name</label><input id="legal" required>
        <label for="address">Business address</label><input id="address" autocomplete="street-address" required>
        <label for="date">Incorporation date</label><input id="date" type="date" required>
        <label for="purpose">Use of account</label><select id="purpose">
          <option>Business operations</option><option>Treasury management</option>
        </select>
        <label><input id="terms" type="checkbox"> Information is accurate</label>
        <label for="secret">Private identifier</label><input id="secret" type="password" value="never-observe-this">
        <button type="submit">Save and continue</button>
      </form>
      <output id="events">0</output>
      <script>
        for (const field of [legal, address, date, purpose, terms, secret]) {
          field.addEventListener('input', () => { events.value = String(Number(events.value) + 1); });
          field.addEventListener('change', () => { events.value = String(Number(events.value) + 1); });
        }
      </script>
    </body></html>`);
  });
  const port = await listen(server);
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-form-workflow-'));
  controller = new BrowserController(browserConfig(temporaryRoot));
  await controller.open({ url: `http://127.0.0.1:${port}/form`, newTab: false, stabilizationMs: 0, timeoutMs: 5_000 });
}

describe('BrowserController form workflow manager', () => {
  it('summarizes redacted state and applies an exact staged plan without exposing private values', async () => {
    await openForm();
    const summary = await controller?.formSummary({ frameId: null, maxFields: 20, maxActions: 20, timeoutMs: 5_000 });
    if (summary === undefined) throw new Error('Form summary unavailable.');
    expect(summary).toMatchObject({ scope: 'document', fieldsComplete: true, actionsComplete: true });
    expect(JSON.stringify(summary)).not.toContain('never-observe-this');
    expect(summary.fields.find(({ name }) => name === 'Private identifier')).toMatchObject({
      kind: 'private',
      valuePresence: 'not_observed_private',
    });
    expect(summary.actions).toContainEqual({ role: 'button', name: 'Save and continue', disabled: false });

    const field = (name: string) => {
      const observed = summary.fields.find((candidate) => candidate.name === name);
      if (observed === undefined) throw new Error(`Missing fixture field ${name}.`);
      return observed.fieldId;
    };
    const result = await controller?.applyFormPlan({
      formId: summary.formId,
      frameId: null,
      steps: [
        { kind: 'fill', fieldId: field('Legal name'), value: 'Stage Five Labs' },
        { kind: 'fill', fieldId: field('Business address'), value: 'Authorized fixture address' },
        { kind: 'fill', fieldId: field('Incorporation date'), value: '2024-05-06' },
        { kind: 'select', fieldId: field('Use of account'), option: { name: 'Treasury management', exact: true } },
        { kind: 'set_checked', fieldId: field('Information is accurate'), checked: true },
        { kind: 'fill', fieldId: field('Private identifier'), value: 'agent-authorized-fixture-value' },
      ],
      timeoutMs: 10_000,
    });
    expect(result?.completedSteps).toHaveLength(6);
    expect(result?.completedSteps.every(({ after }) => after.valid !== false)).toBe(true);
    expect(result?.actionDispatched).toBe(true);
    expect(JSON.stringify(result)).not.toContain('agent-authorized-fixture-value');

    const page = (controller as unknown as { activePage: { locator: (selector: string) => {
      inputValue: () => Promise<string>;
      isChecked: () => Promise<boolean>;
    } } }).activePage;
    expect(await page.locator('#legal').inputValue()).toBe('Stage Five Labs');
    expect(await page.locator('#address').inputValue()).toBe('Authorized fixture address');
    expect(await page.locator('#date').inputValue()).toBe('2024-05-06');
    expect(await page.locator('#purpose').inputValue()).toBe('Treasury management');
    expect(await page.locator('#terms').isChecked()).toBe(true);
    expect(await page.locator('#secret').inputValue()).toBe('agent-authorized-fixture-value');

    const after = await controller?.formSummary({ frameId: null, maxFields: 20, maxActions: 20, timeoutMs: 5_000 });
    expect(after?.fields.find(({ name }) => name === 'Legal name')?.valuePresence).toBe('present');
    expect(after?.fields.find(({ name }) => name === 'Information is accurate')?.selected).toBe(true);
  });

  it('sets checked state idempotently through an exact semantic target', async () => {
    await openForm();
    const first = await controller?.setChecked({
      formId: null,
      fieldId: null,
      control: { role: 'checkbox', name: 'Information is accurate', exact: true },
      checked: true,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(first).toMatchObject({ checked: true, alreadySatisfied: false, actionDispatched: true });

    const second = await controller?.setChecked({
      formId: null,
      fieldId: null,
      control: { role: 'checkbox', name: 'Information is accurate', exact: true },
      checked: true,
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(second).toMatchObject({ checked: true, alreadySatisfied: true, actionDispatched: false });
  });

  it('retires all document-scoped form and control capabilities before context shutdown', async () => {
    await openForm();
    await controller?.formSummary({ frameId: null, maxFields: 20, maxActions: 20, timeoutMs: 5_000 });
    await controller?.inspectControl({
      control: { role: 'combobox', name: 'Use of account', exact: true },
      frameId: null,
      revealOptions: true,
      maxOptions: 20,
      timeoutMs: 5_000,
    });
    const capabilities = controller as unknown as {
      controlInspections: Map<string, unknown>;
      formInspections: Map<string, unknown>;
    };
    expect(capabilities.formInspections.size).toBe(1);
    expect(capabilities.controlInspections.size).toBe(1);

    await controller?.stop();

    expect(capabilities.formInspections.size).toBe(0);
    expect(capabilities.controlInspections.size).toBe(0);
  });
});
