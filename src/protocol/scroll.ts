export const SCROLL_DIRECTIONS = ['down', 'left', 'right', 'up'] as const;
export type ScrollDirection = (typeof SCROLL_DIRECTIONS)[number];

export interface ScrollPosition {
  x: number;
  y: number;
  maxX: number;
  maxY: number;
  viewportWidth: number;
  viewportHeight: number;
  contentWidth: number;
  contentHeight: number;
}

export interface ScrollContainerObservation {
  ref: string;
  label: string | null;
  role: string | null;
  inViewport: boolean;
  position: ScrollPosition;
}

export interface ScrollContentObservation {
  articleCount: number;
  loadingIndicatorCount: number;
}

export type ScrollWaitCondition =
  | 'article_count_growth'
  | 'loading_indicators_disappear'
  | 'either';

export interface ScrollWaitResult {
  requested: boolean;
  condition: ScrollWaitCondition | null;
  satisfied: boolean;
  evidence:
    | 'article_count_growth'
    | 'loading_indicators_disappeared'
    | 'not_requested'
    | 'timeout';
  waitedMs: number;
  before: ScrollContentObservation;
  after: ScrollContentObservation;
}

export type ScrollEndState =
  | 'confirmed_by_marker'
  | 'confirmed_document_start'
  | 'confirmed_container_start'
  | 'dynamic_content_stalled'
  | 'geometric_boundary_unconfirmed'
  | 'not_at_boundary';
