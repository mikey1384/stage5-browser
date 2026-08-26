import { type ScrollContentObservation } from '../dependencies.js';
import { type ScrollContentSample } from '../model.js';

export function observeScrollContentForRoot(rootElement: HTMLElement | null): ScrollContentSample {
  if (rootElement !== null && !rootElement.isConnected) {
    throw new Error('The pinned scroll observation root is detached.');
  }
  const MAX_ARTICLES = 500;
  const MAX_LOADERS = 1_000;
  const MAX_STATUSES = 1_000;
  const MAX_ANIMATION_CANDIDATES = 5_000;
  const MAX_GENERIC_LOADING_TEXT_NODES = 5_000;
  const MAX_TEXT_NODES_PER_ARTICLE = 2_000;
  const MAX_SEMANTIC_ELEMENTS_PER_ARTICLE = 500;
  let semanticObservationIncomplete = false;
  let animationObservationComplete = true;
  const observationRoot: Document | HTMLElement = rootElement ?? document;
  const surfaceRect = rootElement === null
    ? { top: 0, right: window.innerWidth, bottom: window.innerHeight, left: 0 }
    : rootElement.getBoundingClientRect();
  const clip = {
    top: Math.max(0, surfaceRect.top),
    right: Math.min(window.innerWidth, surfaceRect.right),
    bottom: Math.min(window.innerHeight, surfaceRect.bottom),
    left: Math.max(0, surfaceRect.left),
  };
  const visible = (candidate: Element): boolean => {
    const rect = candidate.getBoundingClientRect();
    const style = getComputedStyle(candidate);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none'
      && style.visibility !== 'hidden' && style.opacity !== '0'
      && rect.bottom > clip.top && rect.right > clip.left
      && rect.top < clip.bottom && rect.left < clip.right;
  };
  const withRootMatch = (
    selector: string,
    limit: number,
    evidence: 'semantic' | 'animation' = 'semantic',
  ): Element[] => {
    const candidates = observationRoot.querySelectorAll(selector);
    const rootMatches = rootElement?.matches(selector) === true;
    if (candidates.length + (rootMatches ? 1 : 0) > limit) {
      if (evidence === 'semantic') {
        semanticObservationIncomplete = true;
      } else {
        animationObservationComplete = false;
      }
    }
    const matches: Element[] = [];
    for (let index = 0; index < candidates.length && matches.length < limit; index += 1) {
      const candidate = candidates.item(index);
      if (candidate !== null) {
        matches.push(candidate);
      }
    }
    if (rootMatches) {
      if (matches.length >= limit) {
        matches.pop();
      }
      matches.unshift(rootElement);
    }
    return matches;
  };
  const rawArticleCandidates = withRootMatch(
    'article, [role="article"], blockquote',
    MAX_ARTICLES,
  );
  const rawArticleSet = new Set(rawArticleCandidates);
  const articleCandidates = rawArticleCandidates.filter((candidate) => {
    let ancestor = candidate.parentElement;
    while (ancestor !== null) {
      if (rawArticleSet.has(ancestor)) return false;
      ancestor = ancestor.parentElement;
    }
    return true;
  });
  const articleSet = new Set(articleCandidates);
  const loaderCandidates = new Set<Element>(withRootMatch(
    '[aria-busy="true"], [role="progressbar"], progress, [class*="skeleton" i], [class*="placeholder" i], [class*="shimmer" i], [class*="loading" i]',
    MAX_LOADERS,
  ));
  const statusCandidates = withRootMatch('[role="status"]', MAX_STATUSES);
  const isExcludedBy = (node: Node, excluded: Set<Element>): boolean => {
    for (const candidate of excluded) {
      if (candidate === node || candidate.contains(node)) {
        return true;
      }
    }
    return false;
  };
  const renderedWithin = (candidate: Element, container: Element): boolean => {
    let current: Element | null = candidate;
    while (current !== null) {
      const style = getComputedStyle(current);
      if (
        current.hasAttribute('hidden') ||
        current.getAttribute('aria-hidden') === 'true' ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.opacity === '0'
      ) {
        return false;
      }
      if (current === container) {
        break;
      }
      current = current.parentElement;
    }
    if (current !== container) {
      return false;
    }
    const rect = candidate.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const hasSubstantiveContentOutside = (
    container: Element,
    excluded: Set<Element>,
  ): boolean => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    let textNodesObserved = 0;
    while (current !== null && textNodesObserved < MAX_TEXT_NODES_PER_ARTICLE) {
      textNodesObserved += 1;
      const parent = current.parentElement;
      let renderedText = false;
      if (parent !== null && renderedWithin(parent, container)) {
        const range = document.createRange();
        range.selectNodeContents(current);
        const rect = range.getBoundingClientRect();
        renderedText = rect.width > 0 && rect.height > 0;
      }
      if (
        (current.textContent ?? '').replaceAll(/\s+/g, ' ').trim().length > 0 &&
        !isExcludedBy(parent ?? current, excluded) &&
        renderedText
      ) {
        return true;
      }
      current = walker.nextNode();
    }
    if (current !== null) {
      semanticObservationIncomplete = true;
    }
    const semanticCandidates = container.querySelectorAll(
      'a[href], button, input, select, textarea, img, picture, video, audio, canvas, iframe, [role="button"], [role="link"], [role="heading"], [role="textbox"], [role="img"]',
    );
    for (
      let index = 0;
      index < semanticCandidates.length && index < MAX_SEMANTIC_ELEMENTS_PER_ARTICLE;
      index += 1
    ) {
      const candidate = semanticCandidates.item(index);
      if (
        candidate !== null &&
        !isExcludedBy(candidate, excluded) &&
        renderedWithin(candidate, container)
      ) {
        return true;
      }
    }
    if (semanticCandidates.length > MAX_SEMANTIC_ELEMENTS_PER_ARTICLE) {
      semanticObservationIncomplete = true;
    }
    return false;
  };

  const closestObservedArticle = (candidate: Element): Element | null => {
    let current: Element | null = candidate;
    while (current !== null) {
      if (articleSet.has(current)) return current;
      current = current.parentElement;
    }
    return null;
  };
  const baseLoadersByArticle = new Map<Element, Set<Element>>();
  for (const loader of loaderCandidates) {
    const article = closestObservedArticle(loader);
    if (article === null) continue;
    const contained = baseLoadersByArticle.get(article) ?? new Set<Element>();
    contained.add(loader);
    baseLoadersByArticle.set(article, contained);
  }
  const statusesByArticle = new Map<Element, Set<Element>>();

  for (const status of statusCandidates) {
    const descriptor = [
      status.getAttribute('aria-label'),
      status.getAttribute('title'),
      status.textContent,
    ].filter((value): value is string => value !== null)
      .join(' ')
      .replaceAll(/\s+/g, ' ')
      .trim()
      .toLocaleLowerCase();
    const namedAsLoading = /\b(?:loading|fetching|please\s+wait|waiting)\b/u.test(descriptor);
    const article = closestObservedArticle(status);
    if (article === null) {
      if (namedAsLoading) {
        loaderCandidates.add(status);
      }
      continue;
    }
    const statuses = statusesByArticle.get(article) ?? new Set<Element>();
    statuses.add(status);
    statusesByArticle.set(article, statuses);
  }
  for (const [article, statuses] of statusesByArticle) {
    const excluded = new Set<Element>([
      ...(baseLoadersByArticle.get(article) ?? []),
      ...statuses,
    ]);
    if (!hasSubstantiveContentOutside(article, excluded)) {
      for (const status of statuses) {
        loaderCandidates.add(status);
      }
    }
  }

  const semanticLoadingIndicatorCount = [...loaderCandidates].filter(visible).length;
  const genericTextLoaderCandidates = new Set<Element>();
  const genericTextContainer = rootElement ?? document.documentElement;
  let genericTextLoadingObservationComplete = true;
  if (semanticLoadingIndicatorCount === 0) {
    const genericTextWalker = document.createTreeWalker(
      genericTextContainer,
      NodeFilter.SHOW_TEXT,
    );
    let genericTextNode = genericTextWalker.nextNode();
    let genericTextNodesObserved = 0;
    while (
      genericTextNode !== null &&
      genericTextNodesObserved < MAX_GENERIC_LOADING_TEXT_NODES
    ) {
      genericTextNodesObserved += 1;
      const parent = genericTextNode.parentElement;
      const text = (genericTextNode.textContent ?? '')
        .replaceAll(/\s+/gu, ' ')
        .trim()
        .toLocaleLowerCase();
      const parentText = (parent?.textContent ?? '')
        .replaceAll(/\s+/gu, ' ')
        .trim()
        .toLocaleLowerCase();
      if (
        parent !== null &&
        parentText === text &&
        /^(?:loading|fetching|please\s+wait|waiting)(?:[.!…]+)?$/u.test(text) &&
        renderedWithin(parent, genericTextContainer)
      ) {
        genericTextLoaderCandidates.add(parent);
      }
      genericTextNode = genericTextWalker.nextNode();
    }
    genericTextLoadingObservationComplete = genericTextNode === null;
  }
  const genericTextLoaders = [...genericTextLoaderCandidates]
    .filter((loader) => !loaderCandidates.has(loader));
  for (const loader of genericTextLoaders) {
    loaderCandidates.add(loader);
  }
  const genericTextLoadingIndicatorCount = genericTextLoaders
    .filter((candidate) => visible(candidate))
    .length;
  const animationLoaderCandidates = new Set<Element>();
  if (semanticLoadingIndicatorCount === 0 && genericTextLoadingIndicatorCount === 0) {
    for (const candidate of withRootMatch('*', MAX_ANIMATION_CANDIDATES, 'animation')) {
      if (!visible(candidate) || (candidate.textContent ?? '').trim().length > 0) {
        continue;
      }
      const style = getComputedStyle(candidate);
      const rect = candidate.getBoundingClientRect();
      if (
        style.animationName !== 'none' &&
        style.animationDuration !== '0s' &&
        rect.width >= 8 &&
        rect.height >= 8
      ) {
        loaderCandidates.add(candidate);
        animationLoaderCandidates.add(candidate);
      }
    }
  }
  const animationLoadingIndicatorCount = [...animationLoaderCandidates].filter(visible).length;
  const loadingIndicatorCount = semanticLoadingIndicatorCount +
    genericTextLoadingIndicatorCount +
    animationLoadingIndicatorCount;

  const loadersByArticle = new Map<Element, Set<Element>>();
  for (const loader of loaderCandidates) {
    const article = closestObservedArticle(loader);
    if (article === null) continue;
    const contained = loadersByArticle.get(article) ?? new Set<Element>();
    contained.add(loader);
    loadersByArticle.set(article, contained);
  }
  const articleCount = articleCandidates.filter((article) => {
    const containedLoaders = loadersByArticle.get(article) ?? new Set<Element>();
    return hasSubstantiveContentOutside(article, containedLoaders);
  }).length;

  if (semanticObservationIncomplete) {
    throw new Error('scroll_content_observation_incomplete');
  }

  return {
    articleCount,
    loadingIndicatorCount,
    semanticLoadingIndicatorCount,
    genericTextLoadingIndicatorCount,
    genericTextLoadingObservationComplete,
    animationLoadingIndicatorCount,
    animationObservationComplete,
  };
}

export function publicScrollContentObservation(sample: ScrollContentSample): ScrollContentObservation {
  return {
    articleCount: sample.articleCount,
    loadingIndicatorCount: sample.loadingIndicatorCount,
  };
}
