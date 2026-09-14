#!/usr/bin/env node
/**
 * Print the Keep-a-Changelog body for version X.Y.Z (heading omitted).
 * Usage: node changelog-section.mjs <version> [changelog]
 */
import { readFileSync } from "node:fs";

const version = process.argv[2];
const changelogPath = process.argv[3] ?? "packages/core/CHANGELOG.md";
if (!version) {
  console.error("usage: changelog-section.mjs <version> [changelog]");
  process.exit(1);
}

const text = readFileSync(changelogPath, "utf8");
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const start = text.search(new RegExp(`^## \\[${escaped}\\]`, "m"));
if (start === -1) {
  console.error(`no ## [${version}] section in ${changelogPath}`);
  process.exit(1);
}

const fromHeading = text.slice(start);
const nl = fromHeading.indexOf("\n");
const rest = nl === -1 ? "" : fromHeading.slice(nl + 1);
const next = rest.search(/^## \[/m);
const body = (next === -1 ? rest : rest.slice(0, next)).trim();
if (!body) {
  console.error(`empty ## [${version}] section in ${changelogPath}`);
  process.exit(1);
}

process.stdout.write(`${body}\n`);
