#!/usr/bin/env -S npx tsx
// SmartSpec MCP server over stdio (for a client that cannot reach the remote endpoint).
// Env: SMARTSPEC_URL (default http://localhost:8000), SMARTSPEC_TOKEN (ssp_…, from SmartSpec → Kết nối Claude)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SmartSpecClient, buildSmartSpecServer } from "./smartspec-mcp.js";

const client = new SmartSpecClient(process.env.SMARTSPEC_URL ?? "http://localhost:8000", process.env.SMARTSPEC_TOKEN ?? "");
await buildSmartSpecServer(client).connect(new StdioServerTransport());
