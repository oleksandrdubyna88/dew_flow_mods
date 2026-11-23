#!/usr/bin/env node
/**
 * The type baseline: the `error TS...` findings of `claude plugin validate --json <plugin>`, which can only shrink.
 *
 * Usage: node tools/type-baseline.mjs <report.json> [--baseline <file>] [--write --engine <version>]
 *   --baseline  default: tools/type-baseline.json beside this file's folder
 *   --write     make the baseline from the report; refused when it would add a finding or raise a count
 *
 * Plain `tsc` needs .claude-plugin/types/, which only the host writes, so the type check is the engine's own, and the
 * engine reports it as warnings of the form `error TS2345: ...` with a "line N, column M" path. A finding is keyed by
 * the file (relative to the plugin folder) and the message with a count, never by line, so an edit that moves a line is
 * not a finding. Red on a new finding or a higher count, and red when a baseline entry is no longer found (a lower
 * count): "shrink the baseline". The fix for a new finding is a mod change with a version raise, not a new baseline.
 *
 * Exit 0 with a count on success; exit 1 with every finding named. Only node: builtins.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TS_ERROR = /^error TS\d+:/;

const keyOf = (file, message) => JSON.stringify([file, message]);

/** Findings of a validate report as a Map of key -> { file, message, count }. */
export function findingsOf(report) {
  if (!report || typeof report !== 'object' || typeof report.target !== 'string' || !Array.isArray(report.contents)) {
    throw new Error('the input is not a `claude plugin validate --json` report (no target and contents)');
  }
  // target is <plugin>/.claude-plugin/plugin.json: the plugin folder is two levels up.
  const pluginRoot = path.dirname(path.dirname(report.target));
  const found = new Map();
  for (const item of report.contents) {
    const relative = path.relative(pluginRoot, item.file ?? '').split(path.sep).join('/');
    for (const entry of [...(item.warnings ?? []), ...(item.errors ?? [])]) {
      const message = typeof entry === 'string' ? entry : entry?.message;
      if (typeof message !== 'string' || !TS_ERROR.test(message)) continue;
      const key = keyOf(relative, message);
      const current = found.get(key) ?? { file: relative, message, count: 0 };
      current.count += 1;
      found.set(key, current);
    }
  }
  return found;
}

export function compare(found, baseline) {
  const problems = [];
  const known = new Map(baseline.map((b) => [keyOf(b.file, b.message), b]));
  for (const [key, finding] of found) {
    const base = known.get(key);
    if (!base) problems.push(`new finding in ${finding.file} (x${finding.count}): ${finding.message}`);
    else if (finding.count > base.count) problems.push(`more of a known finding in ${finding.file}: ${finding.count} found, baseline ${base.count}: ${finding.message}`);
  }
  for (const [key, base] of known) {
    const finding = found.get(key);
    if (!finding || finding.count < base.count) {
      problems.push(`shrink the baseline: ${base.file} baseline ${base.count}, found ${finding ? finding.count : 0}: ${base.message}`);
    }
  }
  return problems;
}

const sorted = (list) => [...list].sort((a, b) => (a.file + a.message).localeCompare(b.file + b.message));

function readJson(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`${what} cannot be read (${file}): ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${what} is not valid JSON (${file}): ${error.message}`);
  }
}

function main(argv) {
  const args = [...argv];
  const reportFile = args.shift();
  const options = { baseline: path.join(HERE, 'type-baseline.json'), write: false, engine: undefined };
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === '--write') options.write = true;
    else if (flag === '--baseline' || flag === '--engine') {
      const value = args.shift();
      if (value === undefined) throw new Error(`${flag} needs a value`);
      options[flag.slice(2)] = value;
    } else throw new Error(`unknown argument ${flag}`);
  }
  if (!reportFile) throw new Error('usage: type-baseline.mjs <report.json> [--baseline file] [--write --engine version]');

  const found = findingsOf(readJson(reportFile, 'the validate report'));
  const total = [...found.values()].reduce((n, f) => n + f.count, 0);

  if (options.write) {
    if (!options.engine) throw new Error('--write needs --engine <version>');
    if (fs.existsSync(options.baseline)) {
      const existing = readJson(options.baseline, 'the baseline').findings ?? [];
      const grew = compare(found, existing).filter((p) => !p.startsWith('shrink the baseline'));
      if (grew.length > 0) throw new Error(`the baseline can only shrink; ${grew.join('; ')}`);
    }
    fs.writeFileSync(options.baseline, `${JSON.stringify({ engine: options.engine, findings: sorted(found.values()) }, null, 2)}\n`);
    console.log(`type-baseline: wrote ${total} findings in ${found.size} entries to ${options.baseline}`);
    return 0;
  }

  const baseline = readJson(options.baseline, 'the baseline');
  if (!Array.isArray(baseline.findings)) throw new Error(`the baseline has no findings list (${options.baseline})`);
  const problems = compare(found, baseline.findings);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`type-baseline: ${problem}`);
    return 1;
  }
  console.log(`type-baseline: ${total} findings in ${found.size} entries, equal to the baseline (engine ${baseline.engine ?? 'unknown'})`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`type-baseline: ${error.message}`);
    process.exitCode = 1;
  }
}
