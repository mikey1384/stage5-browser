import type { SerializedStage5BrowserError } from '../errors.js';
import type { BrowserCommandInput, BrowserCommandName } from './commands.js';

export type BrowserWorkerRequest<Name extends BrowserCommandName = BrowserCommandName> = {
  [Command in Name]: {
    kind: 'request';
    id: string;
    command: Command;
    payload: BrowserCommandInput<Command>;
  };
}[Name];

export type BrowserWorkerResponse =
  | {
      kind: 'response';
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      kind: 'response';
      id: string;
      ok: false;
      error: SerializedStage5BrowserError;
    };
