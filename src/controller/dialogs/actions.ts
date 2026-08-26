import { type BrowserCommandName, type BrowserDialogExpectation, type BrowserDialogStatus } from '../dependencies.js';
import type { BrowserControllerContext } from '../runtime.js';

export const dialogOperations = {
  async withDialogHandling<Result>(
    command: BrowserCommandName,
    expectation: BrowserDialogExpectation | null,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return this.dialogManager.run(command, expectation, operation);
  },

  async dialogStatus(input: { limit: number }): Promise<BrowserDialogStatus> {
    return this.dialogManager.status(input.limit);
  },
} satisfies Record<string, unknown> & ThisType<BrowserControllerContext>;

export type DialogOperations = typeof dialogOperations;
