import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  activeProject,
  encodeToolResult,
  getFileAiHistory,
  getRecentSessions,
  openReadonly,
  searchDevMemory,
  type MemoryDb,
} from "@devtrace/daemon";
import { z } from "zod";

export function createMcpServer(db: MemoryDb): McpServer {
  const server = new McpServer({ name: "devtrace", version: "0.1.0" });
  server.tool(
    "search_dev_memory",
    "Search agent history for the current workspace. Each hit includes host cursor or qoder. Pass project only to override the open folder.",
    {
      query: z.string().describe("Keywords, including Chinese words such as 支付"),
      project: z.string().optional().describe("Workspace path, project uri, or project name"),
      limit: z.number().int().positive().max(20).optional(),
    },
    async ({ query, project, limit }) => ({
      content: [
        {
          type: "text",
          text: encodeToolResult(searchDevMemory(db, { query, project: activeProject(project), limit })),
        },
      ],
    }),
  );
  server.tool(
    "get_file_ai_history",
    "List AI file changes for a path, newest first, with the session that made the change.",
    {
      filePath: z.string(),
      project: z.string().optional(),
      limit: z.number().int().positive().max(20).optional(),
    },
    async ({ filePath, project, limit }) => ({
      content: [
        {
          type: "text",
          text: encodeToolResult(getFileAiHistory(db, { filePath, project: activeProject(project), limit })),
        },
      ],
    }),
  );
  server.tool(
    "get_recent_sessions",
    "Summarize the newest coding sessions: title, time range, files, and the first user turn plus the last assistant turn.",
    {
      count: z.number().int().positive().max(20).optional(),
      project: z.string().optional(),
    },
    async ({ count, project }) => ({
      content: [
        {
          type: "text",
          text: encodeToolResult(getRecentSessions(db, { count, project: activeProject(project) })),
        },
      ],
    }),
  );
  return server;
}

export async function serveMcp(dbFile: string): Promise<void> {
  const db = openReadonly(dbFile);
  const server = createMcpServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
