import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const testRoot = path.resolve("tests");

function collectTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return collectTestFiles(fullPath);
    }

    return /\.test\.tsx?$/.test(entry.name) ? [fullPath] : [];
  });
}

const files = collectTestFiles(testRoot).sort();

if (!files.length) {
  console.error("No test files found under tests/**/*.test.ts(x).");
  process.exit(1);
}

const result = spawnSync("node", ["--import", "tsx", "--test", ...files], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
