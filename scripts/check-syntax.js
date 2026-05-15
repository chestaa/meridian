import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const jsFiles = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      jsFiles.push(path.join(dir, entry.name));
    }
  }
}

walk(ROOT);

let failed = false;
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
