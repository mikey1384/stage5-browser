import {
  type BrowserCommandInput,
  type BrowserCommandOutput,
  type Page,
  type PageLifecycleEvent,
  path,
  randomUUID,
  sanitizeUrlForJournal,
} from '../dependencies.js';
import { DurableJsonFile } from '../../persistence/durable-json.js';
import type { BrowserControllerContext } from '../runtime.js';

const MANIFEST_VERSION = 1;
const MAX_RETAINED_EVENTS = 200;

interface PageLifecycleManifest {
  version: typeof MANIFEST_VERSION;
  sequence: number;
  events: PageLifecycleEvent[];
}

function isEvent(value: unknown): value is PageLifecycleEvent {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PageLifecycleEvent>;
  return typeof candidate.eventId === 'string'
    && Number.isSafeInteger(candidate.sequence)
    && (candidate.kind === 'document_replaced' || candidate.kind === 'page_closed' || candidate.kind === 'page_observed')
    && typeof candidate.occurredAt === 'string'
    && (candidate.sanitizedUrl === null || typeof candidate.sanitizedUrl === 'string')
    && (candidate.stateRisk === 'all_unsaved_form_state_may_be_lost' || candidate.stateRisk === 'none');
}

function isManifest(value: unknown): value is PageLifecycleManifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PageLifecycleManifest>;
  return candidate.version === MANIFEST_VERSION
    && Number.isSafeInteger(candidate.sequence)
    && Array.isArray(candidate.events)
    && candidate.events.every(isEvent);
}

function copyEvent(event: PageLifecycleEvent): PageLifecycleEvent {
  return { ...event };
}

export class BrowserPageLifecycleManager {
  private sequence = 0;
  private readonly events: PageLifecycleEvent[] = [];
  private readonly manifest: DurableJsonFile<PageLifecycleManifest>;
  private readonly ready: Promise<void>;
  private persistTail: Promise<void> = Promise.resolve();
  private readonly boundPages = new WeakSet<Page>();
  private readonly pageTails = new WeakMap<Page, Promise<void>>();
  private readonly pending = new Set<Promise<void>>();
  private readonly timeOrigins = new WeakMap<Page, number | null>();

  constructor(artifactsDir: string) {
    this.manifest = new DurableJsonFile(path.join(artifactsDir, 'page-lifecycle', 'manifest.json'), isManifest);
    this.ready = this.restore();
  }

  bind(page: Page): void {
    if (this.boundPages.has(page)) return;
    this.boundPages.add(page);
    this.enqueue(page, async () => {
      this.timeOrigins.set(page, await this.timeOrigin(page));
      await this.record('page_observed', page.url(), 'none');
    });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      this.enqueue(page, async () => {
        const before = this.timeOrigins.get(page) ?? null;
        const after = await this.timeOrigin(page);
        this.timeOrigins.set(page, after);
        if (before !== null && after !== null && before === after) return;
        await this.record('document_replaced', page.url(), 'all_unsaved_form_state_may_be_lost');
      });
    });
    page.on('close', () => {
      this.enqueue(page, () => this.record('page_closed', page.url(), 'all_unsaved_form_state_may_be_lost'));
    });
  }

  async list(input: BrowserCommandInput<'pageEvents'>): Promise<BrowserCommandOutput<'pageEvents'>> {
    await this.ready;
    await this.settlePending();
    await this.persistTail;
    const afterSequence = input.afterSequence ?? 0;
    return {
      cursor: this.sequence,
      events: this.events
        .filter((event) => event.sequence > afterSequence)
        .slice(-Math.max(1, Math.min(MAX_RETAINED_EVENTS, input.limit)))
        .map(copyEvent),
      persistence: 'durable_sanitized_manifest',
      privacy: 'no_titles_content_values_queries_fragments_or_document_identifiers',
    };
  }

  async recordReattachedDocumentReplacement(page: Page): Promise<void> {
    await this.record('document_replaced', page.url(), 'all_unsaved_form_state_may_be_lost');
  }

  private enqueue(page: Page, operation: () => Promise<void>): void {
    const pending = (this.pageTails.get(page) ?? Promise.resolve())
      .then(operation)
      .catch(() => undefined);
    this.pageTails.set(page, pending);
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending));
  }

  private async timeOrigin(page: Page): Promise<number | null> {
    if (page.isClosed()) return null;
    return page.evaluate(() => performance.timeOrigin).catch(() => null);
  }

  private async record(
    kind: PageLifecycleEvent['kind'],
    rawUrl: string,
    stateRisk: PageLifecycleEvent['stateRisk'],
  ): Promise<void> {
    await this.ready;
    const event: PageLifecycleEvent = {
      eventId: `page-event-${randomUUID()}`,
      sequence: ++this.sequence,
      kind,
      occurredAt: new Date().toISOString(),
      sanitizedUrl: sanitizeUrlForJournal(rawUrl) ?? null,
      stateRisk,
    };
    this.events.push(event);
    if (this.events.length > MAX_RETAINED_EVENTS) {
      this.events.splice(0, this.events.length - MAX_RETAINED_EVENTS);
    }
    this.persistTail = this.persistTail.then(() => this.manifest.write({
      version: MANIFEST_VERSION,
      sequence: this.sequence,
      events: this.events,
    }));
    await this.persistTail;
  }

  private async settlePending(): Promise<void> {
    if (this.pending.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.pending]),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
  }

  private async restore(): Promise<void> {
    const manifest = await this.manifest.read();
    if (manifest === null) return;
    this.sequence = manifest.sequence;
    this.events.push(...manifest.events.map(copyEvent));
  }
}

export const pageLifecycleOperations = {
  async pageEvents(input: BrowserCommandInput<'pageEvents'>): Promise<BrowserCommandOutput<'pageEvents'>> {
    return this.pageLifecycleManager.list(input);
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type PageLifecycleOperations = typeof pageLifecycleOperations;
