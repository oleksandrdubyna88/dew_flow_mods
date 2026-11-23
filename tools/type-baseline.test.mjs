// T1-T4: the type baseline. The input is the report of `claude plugin validate --json <plugin>`; the findings are
// the `error TS...` messages in it, keyed by file and message with a count, never by line. The baseline can only shrink.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'type-baseline.mjs');
const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });

const PLUGIN = '/work/plugins/agent-models';
const tsWarning = (line, message) => ({ path: `line ${line}, column 3`, message: `error TS2345: ${message}`, code: null });
const entry = (file, warnings) => ({ file: `${PLUGIN}/${file}`, type: 'hooks', errors: [], warnings });

/** A report in the shape the engine prints (read from 2.1.330): the target is the manifest inside the plugin. */
function report(contents) {
  return {
    success: true,
    strict: false,
    target: `${PLUGIN}/.claude-plugin/plugin.json`,
    manifest: { file: `${PLUGIN}/.claude-plugin/plugin.json`, type: 'plugin', errors: [], warnings: [{ path: 'author', message: 'No author information provided.', code: null }], notes: [] },
    contents,
  };
}

const baseReport = () => report([
  entry('hooks/tasks.tsx', [tsWarning(173, 'Argument of type A')]),
  entry('tests/band.test.tsx', [tsWarning(10, 'Missing isCollapsed'), tsWarning(20, 'Missing isCollapsed'), tsWarning(30, 'Other')]),
  entry('hooks/hooks.json', []),
]);
const baseBaseline = () => ({
  engine: '2.1.330',
  findings: [
    { file: 'hooks/tasks.tsx', message: 'error TS2345: Argument of type A', count: 1 },
    { file: 'tests/band.test.tsx', message: 'error TS2345: Missing isCollapsed', count: 2 },
    { file: 'tests/band.test.tsx', message: 'error TS2345: Other', count: 1 },
  ],
});

function setup(rep, baseline) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-'));
  temps.push(dir);
  const reportFile = path.join(dir, 'v.json');
  const baselineFile = path.join(dir, 'type-baseline.json');
  fs.writeFileSync(reportFile, typeof rep === 'string' ? rep : JSON.stringify(rep));
  if (baseline) fs.writeFileSync(baselineFile, JSON.stringify(baseline));
  return { reportFile, baselineFile };
}
function run({ reportFile, baselineFile }, ...extra) {
  const r = spawnSync(process.execPath, [TOOL, reportFile, '--baseline', baselineFile, ...extra], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('type-baseline', () => {
  it('T1: findings equal to the baseline (line numbers moved) are green and counted', () => {
    const rep = baseReport();
    rep.contents[1].warnings[0].path = 'line 99, column 1';
    const r = run(setup(rep, baseBaseline()));
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /4 findings/);
  });

  it('T2: a planted new finding is red, naming file and message', () => {
    const rep = baseReport();
    rep.contents[0].warnings.push(tsWarning(5, 'A brand new problem'));
    const r = run(setup(rep, baseBaseline()));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /hooks\/tasks\.tsx/);
    assert.match(r.out, /A brand new problem/);
  });

  it('T2: one more of a known finding (the count grows) is red', () => {
    const rep = baseReport();
    rep.contents[1].warnings.push(tsWarning(40, 'Missing isCollapsed'));
    const r = run(setup(rep, baseBaseline()));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Missing isCollapsed/);
  });

  it('T3: a baseline finding that is gone is red, saying to shrink the baseline', () => {
    const rep = baseReport();
    rep.contents[0].warnings = [];
    const r = run(setup(rep, baseBaseline()));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /shrink the baseline/);
    assert.match(r.out, /hooks\/tasks\.tsx/);
  });

  it('T3: a count that fell is red too', () => {
    const rep = baseReport();
    rep.contents[1].warnings.splice(0, 1);
    const r = run(setup(rep, baseBaseline()));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /shrink the baseline/);
  });

  it('T4: unparsable JSON is red', () => {
    const r = run(setup('{ not json', baseBaseline()));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /JSON/i);
  });

  it('T4: JSON that is not a validate report is red', () => {
    const r = run(setup({ hello: 1 }, baseBaseline()));
    assert.equal(r.code, 1, r.out);
  });

  it('T4: a missing baseline file is red', () => {
    const s = setup(baseReport());
    const r = run(s);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /baseline/i);
  });

  it('warnings that are not TypeScript errors are not findings', () => {
    const rep = baseReport();
    rep.contents[2].warnings.push({ path: 'x', message: 'some other warning', code: null });
    const r = run(setup(rep, baseBaseline()));
    assert.equal(r.code, 0, r.out);
  });

  it('--write makes the baseline from a report and keeps the engine version', () => {
    const s = setup(baseReport());
    const r = run(s, '--write', '--engine', '2.1.330');
    assert.equal(r.code, 0, r.out);
    const written = JSON.parse(fs.readFileSync(s.baselineFile, 'utf8'));
    assert.equal(written.engine, '2.1.330');
    assert.deepEqual(written.findings, baseBaseline().findings);
    assert.equal(run(s).code, 0);
  });

  it('--write refuses to grow an existing baseline', () => {
    const rep = baseReport();
    rep.contents[0].warnings.push(tsWarning(5, 'A brand new problem'));
    const s = setup(rep, baseBaseline());
    const r = run(s, '--write', '--engine', '2.1.330');
    assert.equal(r.code, 1, r.out);
    assert.deepEqual(JSON.parse(fs.readFileSync(s.baselineFile, 'utf8')), baseBaseline());
  });
});
