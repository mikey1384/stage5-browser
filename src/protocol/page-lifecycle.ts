export const PAGE_LIFECYCLE_EVENT_KINDS = [
  'document_replaced',
  'page_closed',
  'page_observed',
] as const;

export type PageLifecycleEventKind = (typeof PAGE_LIFECYCLE_EVENT_KINDS)[number];

export interface PageLifecycleEvent {
  eventId: string;
  sequence: number;
  kind: PageLifecycleEventKind;
  occurredAt: string;
  sanitizedUrl: string | null;
  stateRisk: 'all_unsaved_form_state_may_be_lost' | 'none';
}

export interface PageLifecycleStatus {
  cursor: number;
  events: PageLifecycleEvent[];
  persistence: 'durable_sanitized_manifest';
  privacy: 'no_titles_content_values_queries_fragments_or_document_identifiers';
}
