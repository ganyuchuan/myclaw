#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printHelp() {
  console.log(`alimbo CLI\n\nUsage:\n  alimbo start\n  alimbo bridge:feishu\n  alimbo cloud\n  alimbo --help\n  alimbo --version`);
}

function runDistEntry(entryFile, args = []) {
  const target = path.resolve(__dirname, entryFile);
  const child = spawn(process.execPath, [target, ...args], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    console.error(`[alimbo] failed to launch ${entryFile}: ${String(error?.message ?? error)}`);
    process.exit(1);
  });
}

const [, , command = "--help", ...rest] = process.argv;

if (command === "--help" || command === "-h" || command === "help") {
  printHelp();
  process.exit(0);
}

if (command === "--version" || command === "-v" || command === "version") {
  try {
    const pkgPath = path.resolve(__dirname, "../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    console.log(String(pkg?.version ?? "0.0.0"));
    process.exit(0);
  } catch {
    console.log("0.0.0");
    process.exit(0);
  }
}

if (command === "start") {
  runDistEntry("index.js", rest);
} else if (command === "bridge:feishu") {
  runDistEntry("bridge/feishu.js", rest);
} else if (command === "cloud") {
  runDistEntry("cloud/intercept-server.js", rest);
} else {
  console.error(`[alimbo] unknown command: ${command}`);
  printHelp();
  process.exit(1);
}
