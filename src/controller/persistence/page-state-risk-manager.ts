import {
  type BrowserActionIntent,
  type Page,
  type PageStateRisk,
  Stage5BrowserError,
} from '../dependencies.js';

interface RetainedPageStateRisk {
  fileCount: number;
  revision: number;
  acknowledgedRevision: number | null;
}

type NavigationDispatch = 'click' | 'navigation' | 'tab_close';

export class BrowserPageStateRiskManager {
  private readonly retained = new WeakMap<Page, RetainedPageStateRisk>();

  noteFileSelection(page: Page, fileCount: number): PageStateRisk {
    const prior = this.retained.get(page);
    this.retained.set(page, {
      fileCount: Math.min(100, Math.max(1, fileCount) + (prior?.fileCount ?? 0)),
      revision: (prior?.revision ?? 0) + 1,
      acknowledgedRevision: null,
    });
    return this.current(page)!;
  }

  current(page: Page): PageStateRisk | null {
    const retained = this.retained.get(page);
    return retained === undefined ? null : {
      kind: 'possible_unsaved_file_selections',
      fileCount: retained.fileCount,
      acknowledgementRequired: retained.acknowledgedRevision !== retained.revision,
    };
  }

  preflightAction(
    page: Page,
    intent: BrowserActionIntent | undefined,
    acknowledged: boolean,
  ): PageStateRisk | null {
    return intent === 'navigate'
      ? this.preflightNavigation(page, acknowledged, 'click')
      : this.current(page);
  }

  preflightNavigation(
    page: Page,
    acknowledged: boolean,
    dispatch: NavigationDispatch,
  ): PageStateRisk | null {
    const retained = this.retained.get(page);
    if (retained === undefined) return null;
    if (retained.acknowledgedRevision === retained.revision) return this.current(page);
    if (acknowledged) {
      retained.acknowledgedRevision = retained.revision;
      return this.current(page);
    }
    const stateRisk = this.current(page)!;
    throw new Stage5BrowserError(
      'OPERATION_FAILED',
      'This page has file selections whose workflow persistence is not proven.',
      {
        recoverable: true,
        details: {
          reason: 'unsaved_file_selection_navigation_requires_acknowledgement',
          actionDispatched: false,
          ...(dispatch === 'click' ? { clickDispatched: false } : {}),
          stateRisk,
          suggestedAction: 'Save first, or repeat once with acknowledgeStateRisk=true.',
        },
      },
    );
  }

  restore(page: Page, stateRisk: PageStateRisk): void {
    this.retained.set(page, {
      fileCount: stateRisk.fileCount,
      revision: 1,
      acknowledgedRevision: stateRisk.acknowledgementRequired ? null : 1,
    });
  }

  clear(page: Page): void {
    this.retained.delete(page);
  }
}
