import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { BROWSER_ACTION_MANAGERS, BROWSER_MOVE_AVAILABILITIES, type BrowserCommandName } from '../protocol.js';
import { safelyCurrent as safelyCurrentOperation, type McpHostContext } from './context.js';
import { MCP_TOOL_CONTRACTS } from './tool-contracts.js';
import { MCP_TOOL_NAMES as TOOL, type McpToolName } from './tool-names.js';

export function registerBrowserAffordanceTools(server: McpServer, context: McpHostContext): void {
  const safelyCurrent = <T>(operation: () => Promise<T>) => safelyCurrentOperation(context, operation);
  server.registerTool(
    TOOL.browserAvailableMoves,
    {
      title: 'List currently viable browser moves',
      description:
        'Return several privacy-safe motions the Stage5 hand can currently perform, plus their owning manager, structural prerequisites, enabling tools, expected effect class, cost, authority boundary, and replay consequence. This is a read-only planning observation—not authorization, recommendation, or a dump of page content. Deterministic managers report facts and freshness; the agent uses semantic judgment to choose a tactic among the viable paths. Blocked moves are omitted by default and can be requested for diagnosis.',
      inputSchema: z.object({
        includeBlocked: z.boolean().default(false),
        manager: z.enum(BROWSER_ACTION_MANAGERS).nullable().default(null),
        availability: z.enum(BROWSER_MOVE_AVAILABILITIES).nullable().default(null),
        maxMoves: z.number().int().min(1).max(24).default(20),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => safelyCurrent(async () => {
      const outcome = await context.supervisor.execute('availableMoves', input);
      return {
        ...outcome,
        result: {
          ...outcome.result,
          moves: outcome.result.moves.map(({ command, enablingCommands, ...move }) => ({
            ...move,
            tools: publicToolsForCommand(command),
            enablingTools: [...new Set(enablingCommands.flatMap(publicToolsForCommand))],
          })),
        },
      };
    }),
  );
}

function publicToolsForCommand(command: BrowserCommandName): McpToolName[] {
  return (Object.entries(MCP_TOOL_CONTRACTS) as Array<[McpToolName, (typeof MCP_TOOL_CONTRACTS)[McpToolName]]>)
    .filter(([, contract]) => contract.workerCommand === command)
    .map(([tool]) => tool);
}
