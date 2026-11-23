// B1-B3: claude-bin prints the path of the Claude Code native binary that `npm ci --ignore-scripts` leaves in the
// platform package, and refuses a missing file, the stub, or a binary that is not the pinned version.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-bin.mjs');
const temps = [];
after(() => { for (const t of temps) fs.rmSync(t, { recursive: true, force: true }); });

const PLATFORM_PACKAGE = `claude-code-${process.platform}-${process.arch}`;
const EXE = process.platform === 'win32' ? 'claude.exe' : 'claude';
const PAD = `# ${'padding '.repeat(1500)}\n`; // a real binary is megabytes; a stub is a few hundred bytes

function makeRoot(version = '2.1.330') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-'));
  temps.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { '@anthropic-ai/claude-code': version } }));
  return root;
}
function install(root, content, { name = EXE } = {}) {
  const dir = path.join(root, 'node_modules', '@anthropic-ai', PLATFORM_PACKAGE);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, { mode: 0o755 });
  return file;
}
const fake = (versionLine) => `#!/bin/sh\n${PAD}echo '${versionLine}'\n`;
function run(root) {
  const r = spawnSync(process.execPath, [TOOL, '--root', root], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('claude-bin', () => {
  it('prints the path of a binary that reports the pinned version, and nothing else', () => {
    const root = makeRoot();
    const file = install(root, fake('2.1.330 (Claude Code)'));
    const r = run(root);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), file);
  });

  it('B1: the 500-byte stub is red and the reason names the stub', () => {
    const root = makeRoot();
    install(root, '#!/bin/sh\necho "claude native binary not installed (postinstall did not run)" >&2\nexit 1\n');
    const r = run(root);
    assert.equal(r.code, 1, r.out);
    assert.equal(r.out, '', 'nothing is printed on stdout when red');
    assert.match(r.err, /stub/i);
  });

  it('B2: a missing file is red and names the path it looked for', () => {
    const root = makeRoot();
    const r = run(root);
    assert.equal(r.code, 1, r.out);
    assert.ok(r.err.includes(path.join('node_modules', '@anthropic-ai', PLATFORM_PACKAGE, EXE)), r.err);
  });

  it('B3: a binary that prints another version is red, naming both versions', () => {
    const root = makeRoot();
    install(root, fake('2.1.999 (Claude Code)'));
    const r = run(root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.err, /2\.1\.999/);
    assert.match(r.err, /2\.1\.330/);
  });

  it('the pinned version comes from package.json, not from the tool', () => {
    const root = makeRoot('2.2.0');
    install(root, fake('2.2.0 (Claude Code)'));
    assert.equal(run(root).code, 0);
    assert.ok(!fs.readFileSync(TOOL, 'utf8').includes('2.1.330'), 'the version is typed in the tool');
  });

  it('a package.json without the dependency is red', () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    install(root, fake('2.1.330 (Claude Code)'));
    const r = run(root);
    assert.equal(r.code, 1, r.out);
    assert.match(r.err, /@anthropic-ai\/claude-code/);
  });
});
