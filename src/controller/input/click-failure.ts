import { actionDiagnosticForFailure, type ElementHandle, type Page, privacyFingerprint, type SafeTargetState, type SanitizedActionDiagnostic, type SanitizedClickDispatchEvidence } from '../dependencies.js';
import { CLICK_REF_OWNER_SELECTOR, CLICK_REF_OWNER_TEXT_CHARACTERS, type ClickDispatchConclusion, type ClickTargetSemanticIdentity } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const inputClickFailureOperations = {
  canUseForcedClickFallback(
    evidence: SanitizedClickDispatchEvidence | null,
    targetState: SafeTargetState | null,
    normalError: unknown,
  ): boolean {
    const errorDescriptor = normalError instanceof Error
      ? `${normalError.name} ${normalError.message}`.toLocaleLowerCase()
      : '';
    const stabilityAttemptTimedOut = errorDescriptor.includes('timeout') || errorDescriptor.includes('timed out');
    return stabilityAttemptTimedOut &&
      evidence !== null &&
      !evidence.guardExpired &&
      !evidence.trustedEventObserved &&
      !evidence.keyDownOnTarget &&
      !evidence.keyUpOnTarget &&
      !evidence.pointerDownOnTarget &&
      !evidence.mouseDownOnTarget &&
      !evidence.pointerUpOnTarget &&
      !evidence.mouseUpOnTarget &&
      !evidence.clickOnTarget &&
      !evidence.misdirectedEventBlocked &&
      !evidence.targetStateChangeBlocked &&
      targetState !== null &&
      targetState.visible &&
      targetState.enabled &&
      targetState.inViewport &&
      targetState.receivesPointerEvents === true;
  },

  canUsePageMouseFallback(
    evidence: SanitizedClickDispatchEvidence | null,
    targetState: SafeTargetState | null,
  ): boolean {
    return evidence !== null &&
      !evidence.guardExpired &&
      !evidence.trustedEventObserved &&
      !evidence.keyDownOnTarget &&
      !evidence.keyUpOnTarget &&
      !evidence.pointerDownOnTarget &&
      !evidence.mouseDownOnTarget &&
      !evidence.pointerUpOnTarget &&
      !evidence.mouseUpOnTarget &&
      !evidence.clickOnTarget &&
      !evidence.misdirectedEventBlocked &&
      !evidence.targetStateChangeBlocked &&
      targetState !== null &&
      targetState.visible &&
      targetState.enabled &&
      targetState.inViewport &&
      targetState.receivesPointerEvents === true;
  },

  throwObservedClickDispatchFailure(
    page: Page,
    error: unknown,
    targetState: SafeTargetState | null,
    startedAt: string,
    evidence: SanitizedClickDispatchEvidence | null,
    action: SanitizedActionDiagnostic['action'],
    conclusion: ClickDispatchConclusion | null = null,
  ): never {
    const diagnostic = this.observedClickDispatchFailureDiagnostic(
      page,
      error,
      targetState,
      startedAt,
      evidence,
      action,
      conclusion,
    );
    this.pageDiagnostics.recordAction(page, diagnostic);
    throw this.clickFailureError(diagnostic, error);
  },

  observedClickDispatchFailureDiagnostic(
    page: Page,
    error: unknown,
    targetState: SafeTargetState | null,
    startedAt: string,
    evidence: SanitizedClickDispatchEvidence | null,
    action: SanitizedActionDiagnostic['action'],
    conclusion: ClickDispatchConclusion | null = null,
  ): SanitizedActionDiagnostic {
    const fallback = actionDiagnosticForFailure(
      action,
      page,
      error,
      targetState,
      startedAt,
    );
    if (evidence === null) {
      if (conclusion === null) return fallback;
      return {
        ...fallback,
        outcome: conclusion.actionDispatched === false ? 'blocked' : 'failed',
        actionDispatched: conclusion.actionDispatched,
        clickDispatched: conclusion.clickDispatched,
      };
    }
    const exactTargetActivity = evidence.keyDownOnTarget ||
      evidence.keyUpOnTarget ||
      evidence.pointerDownOnTarget ||
      evidence.mouseDownOnTarget ||
      evidence.pointerUpOnTarget ||
      evidence.mouseUpOnTarget ||
      evidence.clickOnTarget;
    const dispatchUnknown = evidence.guardExpired && !evidence.trustedEventObserved;
    const actionDispatched = conclusion?.actionDispatched
      ?? (dispatchUnknown ? 'unknown' : exactTargetActivity);
    const clickDispatched = conclusion?.clickDispatched
      ?? (dispatchUnknown ? 'unknown' : evidence.clickOnTarget);
    const reason = !this.pageIsActivatedForInput(evidence.pageActivation)
      ? 'page_not_active'
      : !evidence.targetConnectedAfter || (evidence.targetStateChangeBlocked && targetState === null)
        ? 'detached'
        : evidence.misdirectedEventBlocked
          ? 'pointer_intercepted'
          : fallback.reason;
    return {
      ...fallback,
      outcome: actionDispatched === false ? 'blocked' : 'failed',
      reason,
      actionDispatched,
      clickDispatched,
      dispatchEvidence: evidence,
    };
  },

  async observeClickTargetIdentity(
    handle: ElementHandle<HTMLElement | SVGElement>,
  ): Promise<ClickTargetSemanticIdentity | null> {
    try {
      const observed = await handle.evaluate((element, args) => {
        if (!element.isConnected) {
          throw new Error('Target element is detached.');
        }
        const normalize = (value: string | null | undefined): string =>
          (value ?? '').replaceAll(/\s+/g, ' ').trim();
        const semanticRole = (candidate: Element): string | null => {
          const explicit = normalize(candidate.getAttribute('role')).split(' ')[0] ?? '';
          if (explicit !== '') {
            return explicit.toLocaleLowerCase();
          }
          const tagName = candidate.tagName.toLocaleLowerCase();
          if (tagName === 'button') return 'button';
          if (tagName === 'a' && candidate.hasAttribute('href')) return 'link';
          if (tagName === 'article') return 'article';
          if (tagName === 'tr') return 'row';
          if (tagName === 'li') return 'listitem';
          if (tagName === 'img') return 'img';
          if (tagName === 'textarea') return 'textbox';
          if (tagName === 'select') return 'combobox';
          if (tagName === 'input') {
            const type = (candidate.getAttribute('type') ?? 'text').toLocaleLowerCase();
            if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            if (type !== 'hidden') return 'textbox';
          }
          return null;
        };
        const renderedText = (candidate: Element): string =>
          candidate instanceof HTMLElement
            ? normalize(candidate.innerText || candidate.textContent)
            : normalize(candidate.textContent);
        const semanticName = (candidate: Element): string => {
          const ariaLabel = normalize(candidate.getAttribute('aria-label'));
          if (ariaLabel !== '') return ariaLabel.slice(0, 500);
          const labelledBy = normalize(candidate.getAttribute('aria-labelledby'));
          if (labelledBy !== '') {
            const labels = labelledBy.split(' ')
              .map((id) => document.getElementById(id))
              .filter((label): label is HTMLElement => label !== null)
              .map((label) => normalize(label.innerText || label.textContent))
              .filter((label) => label !== '')
              .join(' ');
            if (labels !== '') return labels.slice(0, 500);
          }
          const alt = normalize(candidate.getAttribute('alt'));
          if (alt !== '') return alt.slice(0, 500);
          const rendered = renderedText(candidate);
          if (rendered !== '') return rendered.slice(0, 500);
          const value = normalize(candidate.getAttribute('value'));
          if (value !== '') return value.slice(0, 500);
          const placeholder = normalize(candidate.getAttribute('placeholder'));
          if (placeholder !== '') return placeholder.slice(0, 500);
          return normalize(candidate.getAttribute('title')).slice(0, 500);
        };
        const owner = element.closest(args.ownerSelector);
        let nestingDepth = 0;
        for (let ancestor: Element | null = owner; ancestor !== null; ancestor = ancestor.parentElement) {
          if (ancestor.matches(args.ownerSelector)) {
            nestingDepth += 1;
          }
        }
        return {
          tagName: element.tagName.toLocaleLowerCase(),
          role: semanticRole(element),
          name: semanticName(element),
          url: element.getAttribute('href'),
          owner: owner === null
            ? null
            : {
                text: renderedText(owner).slice(0, args.ownerTextCharacters),
                tagName: owner.tagName.toLocaleLowerCase(),
                role: semanticRole(owner),
                nestingDepth,
              },
        };
      }, {
        ownerSelector: CLICK_REF_OWNER_SELECTOR,
        ownerTextCharacters: CLICK_REF_OWNER_TEXT_CHARACTERS,
      });
      return {
        tagName: observed.tagName,
        role: observed.role,
        name: observed.name,
        url: observed.url,
        owner: observed.owner === null
          ? null
          : {
              fingerprint: privacyFingerprint(observed.owner.text),
              tagName: observed.owner.tagName,
              role: observed.owner.role,
              nestingDepth: observed.owner.nestingDepth,
            },
      };
    } catch {
      return null;
    }
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type InputClickFailureOperations = typeof inputClickFailureOperations;
