import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BrowserController } from '../../../src/browser-controller.js';
import { Stage5BrowserError } from '../../../src/errors.js';
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

describe('BrowserController field-scoped private handoff', () => {
  it('preserves unsaved form state, blocks agent control, and resumes with redacted evidence', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><body>
        <label for="public">Legal name</label><input id="public">
        <label for="private">Tax identifier</label><input id="private" type="password" required pattern="[0-9]{4}">
        <button>Save</button>
      </body></html>`);
    });
    const port = await listen(server);
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'stage5-browser-private-field-'));
    controller = new BrowserController(browserConfig(temporaryRoot));
    await controller.open({ url: `http://127.0.0.1:${port}/form`, newTab: false, stabilizationMs: 0, timeoutMs: 5_000 });
    await controller.fillByRole({
      role: 'textbox', name: 'Legal name', exact: true, frameId: null, value: 'Stage Five Labs', timeoutMs: 5_000,
    });
    const summary = await controller.formSummary({ frameId: null, maxFields: 20, maxActions: 20, timeoutMs: 5_000 });
    const privateField = summary.fields.find(({ name }) => name === 'Tax identifier');
    if (privateField === undefined) throw new Error('Private fixture field unavailable.');

    const requested = await controller.requestPrivateFieldHandoff({
      target: { kind: 'form_field', formId: summary.formId, fieldId: privateField.fieldId },
      valueType: 'tax_identifier',
      frameId: null,
      timeoutMs: 5_000,
    });
    expect(requested).toMatchObject({
      controlMode: 'private_field',
      state: 'awaiting_user',
      fieldLabel: 'Tax identifier',
      valueType: 'tax_identifier',
    });
    expect(JSON.stringify(requested)).not.toContain('1234');
    expect(controller.privateFieldStatus()).toMatchObject({ state: 'awaiting_user', handoffId: requested.handoffId });
    await expect(controller.snapshot({ depth: 8, boxes: false, frameId: null, timeoutMs: 5_000 }))
      .rejects.toMatchObject<Partial<Stage5BrowserError>>({
        code: 'AUTH_HANDOFF_REQUIRED',
        details: { reason: 'private_field_handoff_in_progress' },
      });
    await expect(controller.stop()).rejects.toMatchObject<Partial<Stage5BrowserError>>({
      details: { reason: 'private_field_handoff_in_progress' },
    });

    const page = (controller as unknown as { activePage: { locator: (selector: string) => {
      fill: (value: string) => Promise<void>;
      inputValue: () => Promise<string>;
      evaluate: <T>(callback: (element: HTMLElement) => T) => Promise<T>;
    } } }).activePage;
    await page.locator('#private').fill('1234');
    const resumed = await controller.resumePrivateFieldHandoff({ handoffId: requested.handoffId, timeoutMs: 5_000 });
    expect(resumed).toMatchObject({
      controlMode: 'agent',
      state: 'inactive',
      outcome: 'completed',
      before: { valuePresence: 'empty' },
      after: { valuePresence: 'present', valid: true },
      validationMessagePresent: false,
    });
    expect(JSON.stringify(resumed)).not.toContain('1234');
    expect(await page.locator('#public').inputValue()).toBe('Stage Five Labs');
    expect(await page.locator('#private').evaluate((element) => element.style.outline)).toBe('');
  });
});
