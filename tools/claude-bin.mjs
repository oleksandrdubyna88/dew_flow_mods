#!/usr/bin/env node
/**
 * Prints the path of the Claude Code native binary that `npm ci --ignore-scripts` leaves in node_modules.
 *
 * Usage: node tools/claude-bin.mjs [--root <repository>]
 *
 * The npm package's own bin is a stub that prints "claude native binary not installed" unless its postinstall ran,
 * and no install script is allowed here. The binary is in the optional dependency of the platform
 * (node_modules/@anthropic-ai/claude-code-<platform>-<arch>/claude) and the lockfile's integrity hash pins it. This
 * tool is the one place that says where it is and that it is what package.json pins: it prints the path on stdout and
 * exits 0, or exits 1 with the reason on stderr when the file is absent, is a stub, or does not report exactly the
 * version package.json names for @anthropic-ai/claude-code. Only node: builtins.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const PACKAGE = '@anthropic-ai/claude-code';
// The stub is a few hundred bytes; the binary is megabytes.
const STUB_BYTES = 4096;

function fail(message) {
  console.error(`claude-bin: ${message}`);
  process.exitCode = 1;
}

function main(argv) {
  let root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (argv[0] === '--root') {
    if (!argv[1]) return fail('--root needs a folder');
    root = argv[1];
  } else if (argv.length > 0) {
    return fail(`unknown argument ${argv[0]}`);
  }
  root = path.resolve(root);

  let pinned;
  try {
    pinned = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies?.[PACKAGE];
  } catch (error) {
    return fail(`package.json cannot be read in ${root}: ${error.message}`);
  }
  if (typeof pinned !== 'string' || !/^\d+\.\d+\.\d+$/.test(pinned)) {
    return fail(`package.json has no exact devDependency ${PACKAGE} (found ${JSON.stringify(pinned)})`);
  }

  const packageName = `claude-code-${process.platform}-${process.arch}`;
  const binary = path.join(root, 'node_modules', '@anthropic-ai', packageName, process.platform === 'win32' ? 'claude.exe' : 'claude');
  let size;
  try {
    size = fs.statSync(binary).size;
  } catch {
    return fail(`the native binary is absent: ${binary} (run npm ci --ignore-scripts; the optional dependency ${PACKAGE}-${process.platform}-${process.arch} must install)`);
  }
  if (size < STUB_BYTES) return fail(`${binary} is a stub (${size} bytes), not the native binary`);

  const run = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH ?? '' } });
  if (run.error) return fail(`${binary} does not run: ${run.error.message}`);
  const reported = String(run.stdout).trim();
  const wanted = `${pinned} (Claude Code)`;
  if (run.status !== 0 || reported !== wanted) {
    return fail(`${binary} reports ${JSON.stringify(reported)} (exit ${run.status}), package.json pins ${JSON.stringify(wanted)}`);
  }
  console.log(binary);
  return undefined;
}

main(process.argv.slice(2));
