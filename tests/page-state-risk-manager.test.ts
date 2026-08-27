import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import { BrowserPageStateRiskManager } from '../src/controller/persistence/page-state-risk-manager.js';
import { Stage5BrowserError } from '../src/errors.js';

describe('page state risk manager', () => {
  it('delegates known navigation risk once per file-selection revision', () => {
    const manager = new BrowserPageStateRiskManager();
    const page = {} as Page;

    expect(manager.current(page)).toBeNull();
    expect(manager.noteFileSelection(page, 2)).toEqual({
      kind: 'possible_unsaved_file_selections',
      fileCount: 2,
      acknowledgementRequired: true,
    });
    expect(manager.preflightAction(page, 'form_edit', false)).toMatchObject({
      acknowledgementRequired: true,
    });

    let blocked: unknown;
    try {
      manager.preflightAction(page, 'navigate', false);
    } catch (error) {
      blocked = error;
    }
    expect(blocked).toBeInstanceOf(Stage5BrowserError);
    expect(blocked).toMatchObject({
      details: {
        reason: 'unsaved_file_selection_navigation_requires_acknowledgement',
        actionDispatched: false,
        clickDispatched: false,
      },
    });

    expect(manager.preflightAction(page, 'navigate', true)).toMatchObject({
      fileCount: 2,
      acknowledgementRequired: false,
    });
    expect(manager.preflightAction(page, 'navigate', false)).toMatchObject({
      acknowledgementRequired: false,
    });

    expect(manager.noteFileSelection(page, 1)).toEqual({
      kind: 'possible_unsaved_file_selections',
      fileCount: 3,
      acknowledgementRequired: true,
    });
  });

  it('restores only categorical state and clears it at a document boundary', () => {
    const manager = new BrowserPageStateRiskManager();
    const page = {} as Page;
    manager.restore(page, {
      kind: 'possible_unsaved_file_selections',
      fileCount: 2,
      acknowledgementRequired: false,
    });
    expect(manager.preflightNavigation(page, false, 'navigation')).toMatchObject({
      fileCount: 2,
      acknowledgementRequired: false,
    });
    manager.clear(page);
    expect(manager.current(page)).toBeNull();
  });
});
