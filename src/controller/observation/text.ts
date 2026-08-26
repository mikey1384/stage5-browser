import { type BrowserCommandInput, type BrowserCommandOutput } from '../dependencies.js';
import { MAX_SEARCHABLE_TEXT_CHARACTERS, type SearchableTextLine, TEXT_SNIPPET_CONTEXT, TEXT_SNIPPET_CONTEXT_LINE_CHARACTERS, TEXT_SNIPPET_CONTEXT_SCAN_LINES, TEXT_SNIPPET_SURROUNDING_LINES } from '../model.js';
import type { BrowserControllerContext } from '../runtime.js';

export const observationTextOperations = {
  async findText(input: BrowserCommandInput<'findText'>): Promise<BrowserCommandOutput<'findText'>> {
    const page = await this.ensureActivePage(this.requireContext());
    const frame = this.resolveFrame(page, input.frameId);
    const body = frame.locator('body');
    const rawText = await body.innerText({ timeout: input.timeoutMs });
    const textTruncated = rawText.length > MAX_SEARCHABLE_TEXT_CHARACTERS;
    const text = rawText.slice(0, MAX_SEARCHABLE_TEXT_CHARACTERS);
    const lines: SearchableTextLine[] = text
      .split(/\r?\n/)
      .map((line, index) => ({ line: index + 1, text: line.replace(/\s+/g, ' ').trim() }))
      .filter(({ text: line }) => line.length > 0);
    const needle = input.caseSensitive ? input.query : input.query.toLocaleLowerCase();
    const matches: Array<{ line: number; snippet: string }> = [];
    let matchCount = 0;

    for (const [index, renderedLine] of lines.entries()) {
      const candidate = input.caseSensitive
        ? renderedLine.text
        : renderedLine.text.toLocaleLowerCase();
      const matched = input.mode === 'exact_line' ? candidate === needle : candidate.includes(needle);
      if (!matched) {
        continue;
      }
      matchCount += 1;
      if (matches.length < input.maxResults) {
        matches.push({
          line: renderedLine.line,
          snippet: this.contextualTextSnippet(
            lines,
            index,
            needle,
            input.query.length,
            input.caseSensitive,
            input.mode,
          ),
        });
      }
    }

    this.lastKnownUrl = page.url();
    return {
      page: await this.pageSummary(page),
      frame: this.frameSummary(frame, page),
      query: input.query,
      matchCount,
      returnedCount: matches.length,
      truncated: matchCount > matches.length,
      textTruncated,
      matches,
    };
  },

  contextualTextSnippet(
    lines: SearchableTextLine[],
    matchIndex: number,
    needle: string,
    queryLength: number,
    caseSensitive: boolean,
    mode: 'contains' | 'exact_line',
  ): string {
    const matchedLine = lines[matchIndex];
    if (matchedLine === undefined) {
      return '';
    }
    const seen = new Set([matchedLine.text.toLocaleLowerCase()]);
    const collect = (direction: -1 | 1): SearchableTextLine[] => {
      const selected: SearchableTextLine[] = [];
      let scanned = 0;
      let index = matchIndex + direction;
      while (
        index >= 0 &&
        index < lines.length &&
        selected.length < TEXT_SNIPPET_SURROUNDING_LINES &&
        scanned < TEXT_SNIPPET_CONTEXT_SCAN_LINES
      ) {
        const candidate = lines[index];
        index += direction;
        scanned += 1;
        if (candidate === undefined) {
          continue;
        }
        const duplicateKey = candidate.text.toLocaleLowerCase();
        if (seen.has(duplicateKey)) {
          continue;
        }
        seen.add(duplicateKey);
        selected.push(candidate);
      }
      return direction === -1 ? selected.reverse() : selected;
    };
    const contextualLines = [...collect(-1), matchedLine, ...collect(1)];
    return contextualLines.map((line) => {
      const isMatch = line === matchedLine;
      const boundedText = isMatch
        ? this.boundedMatchingText(line.text, needle, queryLength, caseSensitive, mode)
        : line.text.length <= TEXT_SNIPPET_CONTEXT_LINE_CHARACTERS
          ? line.text
          : `${line.text.slice(0, TEXT_SNIPPET_CONTEXT_LINE_CHARACTERS - 1)}…`;
      return `${isMatch ? '>' : ' '} ${line.line}: ${boundedText}`;
    }).join('\n');
  },

  boundedMatchingText(
    line: string,
    needle: string,
    queryLength: number,
    caseSensitive: boolean,
    mode: 'contains' | 'exact_line',
  ): string {
    const candidate = caseSensitive ? line : line.toLocaleLowerCase();
    const position = mode === 'exact_line' ? 0 : Math.max(0, candidate.indexOf(needle));
    const start = Math.max(0, position - TEXT_SNIPPET_CONTEXT);
    const end = Math.min(line.length, position + queryLength + TEXT_SNIPPET_CONTEXT);
    return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type ObservationTextOperations = typeof observationTextOperations;
