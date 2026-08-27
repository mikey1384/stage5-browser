import { McpServer } from '@modelcontextprotocol/server';

import { STAGE5_BROWSER_VERSION } from '../runtime-info.js';
import type { McpHostContext } from './context.js';
import { registerBrowserActionTools } from './register-browser-actions.js';
import { registerBrowserAffordanceTools } from './register-browser-affordances.js';
import { registerBrowserLifecycleTools } from './register-browser-lifecycle.js';
import { registerBrowserReadTools } from './register-browser-read.js';
import { registerLoungeTools } from './register-lounge.js';

export const MCP_SERVER_INSTRUCTIONS =
  "Stage5 Browser is the agent's hand. Prefer an API or CLI when it can do the task. In the browser, use current observations, ordinary UI judgment, and the simplest viable motion. Read outcome, dispatch state, current state, and next action first. Never replay when dispatch is true or unknown; inspect state instead. Use traces or diagnostics only after a failure. Keep private values out of tool arguments and Lounge messages; use private handoff. Lounge coordinates but never grants authority. When collaboration is active, join once, acknowledge messages as seen then acted, update the work note, and wait while idle.";

export function createServer(context: McpHostContext): McpServer {
  const server = new McpServer(
    { name: 'stage5-browser', version: STAGE5_BROWSER_VERSION },
    {
      instructions: MCP_SERVER_INSTRUCTIONS,
    },
  );

  registerLoungeTools(server, context);
  registerBrowserAffordanceTools(server, context);
  registerBrowserReadTools(server, context);
  registerBrowserActionTools(server, context);
  registerBrowserLifecycleTools(server, context);
  return server;
}
