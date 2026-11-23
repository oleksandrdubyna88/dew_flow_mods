// The shape of .github/workflows/ci.yml, read as text (the repository has no YAML parser and installs none).
// Each case pins one line of the workflow that a past review found wrong.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CI = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

/** The text of one job: from its `  <key>:` line to the next two-space key. */
function job(key) {
  const lines = CI.split('\n');
  const start = lines.findIndex((l) => l === `  ${key}:`);
  assert.notEqual(start, -1, `job ${key} is not in ci.yml`);
  let end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
  if (end === -1) end = lines.length;
  return lines.slice(start, end).join('\n');
}

describe('ci.yml shape', () => {
  it('S0: the triggers are push and pull_request only (no workflow_dispatch, never pull_request_target)', () => {
    const on = CI.slice(CI.indexOf('\non:\n') + 1, CI.indexOf('\nconcurrency:'));
    const triggers = on.split('\n').filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim().replace(/:.*$/, ''));
    assert.deepEqual(triggers, ['push', 'pull_request']);
  });

  it('S1: no instruction to re-run a red job (no re-run hoping)', () => {
    assert.doesNotMatch(CI, /re-?run/i);
  });

  it('S2: the native binary path is taken in its own statement, so a claude-bin failure fails the step', () => {
    assert.match(CI, /^\s+bin=\$\(node tools\/claude-bin\.mjs\)\s*$/m);
    assert.doesNotMatch(CI, /echo\s+"CLAUDE=\$\(/);
    assert.match(CI, /echo "CLAUDE=\$bin" >> "\$GITHUB_ENV"/);
  });

  it('S3: the tools job fetches the release tag of the proven version before the copy proof runs', () => {
    const tools = job('tools');
    const fetchAt = tools.indexOf('refs/tags/agent-models--v1.6.0:refs/tags/agent-models--v1.6.0');
    const proofAt = tools.indexOf('node tools/copy-proof.mjs');
    assert.ok(fetchAt !== -1, 'no step fetches the tag agent-models--v1.6.0');
    assert.ok(proofAt !== -1 && fetchAt < proofAt, 'the tag fetch comes after the copy proof');
  });

  it('S4: no SonarCloud workflow (no credential in CI)', () => {
    assert.ok(!fs.existsSync(path.join(ROOT, '.github', 'workflows', 'sonarcloud.yml')));
    assert.doesNotMatch(CI, /SONAR_TOKEN|secrets\./);
  });
});

describe('ci.yml shape: the release gate', () => {
  it('S5: the tools job fetches the shared rules BEFORE the tests, because the tests import their helper', () => {
    const tools = job('tools');
    const fetchAt = tools.indexOf('git submodule update --init --depth 1 .agents/conventions');
    const testsAt = tools.indexOf('run: npm test');
    assert.ok(fetchAt !== -1, 'no step initialises the mounted conventions');
    assert.ok(testsAt !== -1 && fetchAt < testsAt, 'the submodule is fetched after npm test');
  });

  it('S6: the tools job runs the layout gate on the commit it checked out', () => {
    assert.match(job('tools'), /^\s+run: node tools\/mods-gate\.mjs\s*$/m);
  });
});
