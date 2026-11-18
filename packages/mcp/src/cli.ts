#!/usr/bin/env node
import os from "node:os";
import { memoryDbPath } from "@devtrace/daemon";
import { serveMcp } from "./server.js";

const file = process.env.DEVTRACE_MEMORY_DB || memoryDbPath(process.env.DEVTRACE_HOME || os.homedir());
serveMcp(file).catch((error: Error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exit(1);
});
