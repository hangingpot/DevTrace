#!/usr/bin/env node
import { serve } from "./runtime.js";

const command = process.argv[2] ?? "serve";
if (command === "serve") {
  serve().catch((error: Error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(1);
  });
} else {
  process.stderr.write("Usage: devtrace serve\n");
  process.exit(1);
}
