// D1-D7: the settings data and its read-back. GitHub is a scripted function (argv, optional stdin → stdout): the tool
// never reaches a network here, and no key, token or secret is real — the public line below is a made-up string.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { ownedDir } from '../.agents/conventions/tools/lib/owned.mjs';
import { DEPLOY_KEY_ACTOR, EXIT, ROOT, ghLauncher, loadData, main, planApply, readBack, validateData } from '../.github/scripts/repo-settings.mjs';

const REPO = 'example/mods';
const FAKE_KEY = 'ssh-ed25519 AAAAC3NzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE';
const clone = (value) => JSON.parse(JSON.stringify(value));
const noNotes = (value) => {
  if (Array.isArray(value)) return value.map(noNotes);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !k.startsWith('$')).map(([k, v]) => [k, noNotes(v)]));
  return value;
};

/** The committed data, with the deploy key line the owner would have pasted (made up). */
function data() {
  const d = clone(loadData());
  d.settings.deployKey.key = FAKE_KEY;
  return d;
}

/** What GitHub would answer when every part equals the data. Each test breaks one part of it. */
function liveFrom(d) {
  const live = {};
  live[`repos/${REPO}/rulesets`] = d.rulesets.map((r, i) => ({ id: 100 + i, name: r.body.name, target: r.body.target, enforcement: r.body.enforcement }));
  d.rulesets.forEach((r, i) => {
    live[`repos/${REPO}/rulesets/${100 + i}`] = { id: 100 + i, ...noNotes(r.body), source_type: 'Repository', source: REPO, current_user_can_bypass: 'never', _links: {} };
  });
  const e = d.settings.environment;
  live[`repos/${REPO}/environments/${e.name}`] = {
    name: e.name,
    protection_rules: [
      { id: 1, type: 'required_reviewers', prevent_self_review: e.prevent_self_review, reviewers: e.reviewers.map((r) => ({ type: r.type, reviewer: { login: 'owner', id: r.id } })) },
      { id: 2, type: 'branch_policy' },
    ],
    deployment_branch_policy: clone(e.deployment_branch_policy),
    can_admins_bypass: e.can_admins_bypass,
  };
  live[`repos/${REPO}/environments/${e.name}/deployment-branch-policies`] = { total_count: 1, branch_policies: e.branch_policies.map((p, i) => ({ id: 7 + i, ...p })) };
  live[`repos/${REPO}/environments/${e.name}/secrets`] = { total_count: e.secrets.length, secrets: e.secrets.map((name) => ({ name })) };
  live[`repos/${REPO}/actions/secrets`] = { total_count: 0, secrets: [] };
  live[`repos/${REPO}/keys`] = [{ id: 5, key: FAKE_KEY, title: d.settings.deployKey.title, read_only: d.settings.deployKey.read_only, verified: true }];
  live[`repos/${REPO}/actions/permissions/workflow`] = { default_workflow_permissions: d.settings.actions.default_workflow_permissions, can_approve_pull_request_reviews: d.settings.actions.can_approve_pull_request_reviews };
  live[`repos/${REPO}/actions/permissions/fork-pr-contributor-approval`] = { approval_policy: d.settings.actions.fork_pr_contributor_approval };
  return live;
}

/** A scripted gh. A GET answers from `live` (an Error is thrown, an absent endpoint is a 404, a function gets the query and answers a page); every call is recorded. */
function fakeGh(live) {
  const calls = [];
  const gh = async (args, input) => {
    calls.push({ args, input });
    const writing = args.includes('-X');
    if (writing) return '{}';
    const [endpoint, query = ''] = args[1].split('?');
    const found = live[endpoint];
    const answer = typeof found === 'function' ? found(new URLSearchParams(query)) : found;
    if (answer === undefined) throw new Error('gh: Not Found (HTTP 404)');
    if (answer instanceof Error) throw answer;
    return JSON.stringify(answer);
  };
  gh.calls = calls;
  gh.writes = () => calls.filter((c) => c.args.includes('-X')).map((c) => ({ method: c.args[c.args.indexOf('-X') + 1], endpoint: c.args[c.args.indexOf('-X') + 2], body: JSON.parse(c.input) }));
  return gh;
}

const check = (d, live) => readBack({ data: d, gh: fakeGh(live), repo: REPO });
const rulesetLive = (live, name) => Object.values(live).find((v) => v && v.name === name && v.rules !== undefined);

describe('D1 the data files', () => {
  it('the committed data is valid: every bypass is [] or the one DeployKey actor, all active, a pattern per catalog plugin', () => {
    const d = loadData();
    assert.deepEqual(validateData(d), []);
    for (const { file, body } of d.rulesets) {
      assert.ok(body.bypass_actors.length === 0 || (body.bypass_actors.length === 1 && JSON.stringify(body.bypass_actors[0]) === JSON.stringify(DEPLOY_KEY_ACTOR)), file);
      assert.equal(body.enforcement, 'active', file);
    }
    const names = d.rulesets.map((r) => r.body.name).sort();
    assert.deepEqual(names, ['main', 'release-fixed', 'release-moves', 'tags-create', 'tags-fixed']);
    const by = Object.fromEntries(d.rulesets.map((r) => [r.body.name, r.body]));
    assert.deepEqual(by.main.bypass_actors, []);
    assert.deepEqual(by['release-fixed'].bypass_actors, []);
    assert.deepEqual(by['tags-fixed'].bypass_actors, []);
    assert.equal(by['tags-create'].target, 'tag');
    assert.equal(by['tags-fixed'].target, 'tag');
    assert.deepEqual(by['release-moves'].rules.map((r) => r.type), ['creation', 'update']);
    assert.deepEqual(by['release-fixed'].rules.map((r) => r.type), ['deletion', 'non_fast_forward']);
    assert.deepEqual(by['tags-create'].rules.map((r) => r.type), ['creation']);
    assert.deepEqual(by['tags-fixed'].rules.map((r) => r.type), ['update', 'deletion']);
    const checks = by.main.rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks;
    assert.ok(checks.length >= 5 && checks.every((c) => c.integration_id === 15368), 'each check names the Actions app');
  });

  it('a bypass actor that is not the deploy key, a bypass on a fixed ruleset, or a ruleset that is not active is a finding', () => {
    const find = (patch) => { const d = clone(loadData()); patch(d); return validateData(d); };
    const by = (d, name) => d.rulesets.find((r) => r.body.name === name).body;
    assert.match(find((d) => { by(d, 'release-moves').bypass_actors.push({ actor_id: 5, actor_type: 'Integration', bypass_mode: 'always' }); }).join('\n'), /release-moves\.json: bypass_actors/);
    assert.match(find((d) => { by(d, 'main').bypass_actors = [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }]; }).join('\n'), /main\.json: bypass_actors/);
    assert.match(find((d) => { by(d, 'tags-fixed').bypass_actors = [DEPLOY_KEY_ACTOR]; }).join('\n'), /tags-fixed\.json: tags-fixed has the DeployKey bypass/);
    assert.match(find((d) => { by(d, 'main').enforcement = 'evaluate'; }).join('\n'), /main\.json: enforcement is "evaluate"/);
    assert.match(find((d) => { by(d, 'release-moves').bypass_actors = []; }).join('\n'), /release-moves: the ruleset lacks the DeployKey bypass/);
  });

  it('the exact rule types and an empty exclude per ruleset: a rule removed or added, an exclude, or an unknown name is a finding', () => {
    const find = (patch) => { const d = clone(loadData()); patch(d); return validateData(d).join('\n'); };
    const by = (d, name) => d.rulesets.find((r) => r.body.name === name).body;
    assert.match(find((d) => { by(d, 'release-fixed').rules = by(d, 'release-fixed').rules.filter((r) => r.type !== 'non_fast_forward'); }), /release-fixed: the rule types are \["deletion"\], they must be \["deletion","non_fast_forward"\]/);
    assert.match(find((d) => { by(d, 'tags-create').rules.push({ type: 'deletion' }); }), /tags-create: the rule types are/);
    assert.match(find((d) => { by(d, 'main').rules = by(d, 'main').rules.filter((r) => r.type !== 'required_linear_history'); }), /main: the rule types are/);
    assert.match(find((d) => { by(d, 'release-moves').conditions.ref_name.exclude = ['refs/heads/release']; }), /release-moves: conditions\.ref_name\.exclude is \["refs\/heads\/release"\], it must be \[\]/);
    assert.match(find((d) => { by(d, 'main').conditions.ref_name.exclude = ['refs/heads/main']; }), /main: conditions\.ref_name\.exclude/);
    assert.match(find((d) => { by(d, 'tags-fixed').conditions.ref_name.exclude = ['refs/tags/x']; }), /tags-fixed: conditions\.ref_name\.exclude/);
    assert.match(find((d) => { by(d, 'main').name = 'other'; }), /is not one of/);
  });

  it('both tag rulesets cover EVERY tag (~ALL), not a pattern per plugin: a tag named release must not be creatable by anyone with write', () => {
    const d = loadData();
    const by = Object.fromEntries(d.rulesets.map((r) => [r.body.name, r.body]));
    for (const name of ['tags-create', 'tags-fixed']) assert.deepEqual(by[name].conditions.ref_name.include, ['~ALL'], name);
    const find = (patch) => { const e = clone(loadData()); patch(e); return validateData(e).join('\n'); };
    for (const name of ['tags-create', 'tags-fixed']) {
      assert.match(find((e) => { e.rulesets.find((r) => r.body.name === name).body.conditions.ref_name.include = ['refs/tags/agent-models--v*']; }), new RegExp(`${name}: conditions\\.ref_name\\.include is \\["refs/tags/agent-models--v\\*"\\], it must be \\["~ALL"\\]`));
      assert.match(find((e) => { e.rulesets.find((r) => r.body.name === name).body.conditions.ref_name.include = []; }), new RegExp(`${name}: conditions\\.ref_name\\.include`));
    }
    // A second plugin needs no new pattern: ~ALL already covers its tags.
    const second = clone(loadData());
    second.catalog.plugins.push({ name: 'second-mod', source: './plugins/second-mod', description: 'x' });
    assert.deepEqual(validateData(second), []);
  });
});

describe('D1 every named ruleset, on its own ref', () => {
  const find = (patch) => { const d = clone(loadData()); patch(d); return validateData(d).join('\n'); };
  const by = (d, name) => d.rulesets.find((r) => r.body.name === name).body;

  it('a ruleset that is missing from the data is a finding, each of the five by name', () => {
    for (const name of ['main', 'release-moves', 'release-fixed', 'tags-create', 'tags-fixed']) {
      assert.match(find((d) => { d.rulesets = d.rulesets.filter((r) => r.body.name !== name); }), new RegExp(`${name}: the ruleset is missing`), name);
    }
  });

  it('a ruleset that holds another ref than its own, or another target, is a finding: release-fixed on main protects nothing of release', () => {
    assert.match(find((d) => { by(d, 'release-fixed').conditions.ref_name.include = ['refs/heads/main']; }), /release-fixed: conditions\.ref_name\.include is \["refs\/heads\/main"\], it must be \["refs\/heads\/release"\]/);
    assert.match(find((d) => { by(d, 'release-fixed').conditions.ref_name.include = ['refs/heads/release', 'refs/heads/main']; }), /release-fixed: conditions\.ref_name\.include/);
    assert.match(find((d) => { by(d, 'release-moves').conditions.ref_name.include = ['refs/heads/rel*']; }), /release-moves: conditions\.ref_name\.include/);
    assert.match(find((d) => { by(d, 'main').conditions.ref_name.include = ['~DEFAULT_BRANCH']; }), /main: conditions\.ref_name\.include/);
    assert.match(find((d) => { by(d, 'release-fixed').target = 'tag'; }), /release-fixed\.json: target is "tag", it must be "branch"/);
    assert.match(find((d) => { by(d, 'tags-fixed').target = 'branch'; }), /tags-fixed\.json: target is "branch", it must be "tag"/);
  });
});

describe('D2 the live rulesets', () => {
  it('equal: exit 0, every part says it matches', async () => {
    const d = data();
    const r = await check(d, liveFrom(d));
    assert.equal(r.code, EXIT.MATCH, r.lines.join('\n'));
    assert.ok(r.lines.every((l) => /matches the data$/.test(l)), r.lines.join('\n'));
  });

  it('an extra bypass actor, enforcement evaluate, a missing rule, a changed check, a missing ruleset: exit 1, each names ruleset and field', async () => {
    const cases = [
      ['an extra bypass actor', (live) => { rulesetLive(live, 'release-moves').bypass_actors.push({ actor_id: 15368, actor_type: 'Integration', bypass_mode: 'always' }); }, /ruleset release-moves: bypass_actors/],
      ['enforcement evaluate', (live) => { rulesetLive(live, 'main').enforcement = 'evaluate'; }, /ruleset main: enforcement — data "active", live "evaluate"/],
      ['a missing rule', (live) => { const m = rulesetLive(live, 'release-fixed'); m.rules = m.rules.filter((x) => x.type !== 'non_fast_forward'); }, /ruleset release-fixed: rules\.non_fast_forward — missing on GitHub/],
      ['a check of another app', (live) => { rulesetLive(live, 'main').rules.find((x) => x.type === 'required_status_checks').parameters.required_status_checks[0].integration_id = 1; }, /ruleset main: rules\.required_status_checks\.parameters/],
      ['a missing ruleset', (live) => { live[`repos/${REPO}/rulesets`] = live[`repos/${REPO}/rulesets`].filter((x) => x.name !== 'tags-fixed'); }, /ruleset tags-fixed: missing/],
    ];
    for (const [label, break_, expected] of cases) {
      const d = data();
      const live = liveFrom(d);
      break_(live);
      const r = await check(d, live);
      assert.equal(r.code, EXIT.DRIFT, `${label}: ${r.lines.join('\n')}`);
      assert.match(r.lines.join('\n'), expected, label);
    }
  });

  it('an extra unknown ruleset is listed, not drift', async () => {
    const d = data();
    const live = liveFrom(d);
    live[`repos/${REPO}/rulesets`].push({ id: 999, name: 'mystery', target: 'branch', enforcement: 'active' });
    const r = await check(d, live);
    assert.equal(r.code, EXIT.MATCH, r.lines.join('\n'));
    assert.match(r.notes.join('\n'), /ruleset "mystery" \(id 999\) is on GitHub and not in the data: listed, not drift/);
  });
});

describe('D3 the environment', () => {
  it('a second reviewer, a self-review block, a second branch policy, protected branches, a wrong secret set, a repository secret: exit 1, each named', async () => {
    const cases = [
      ['a second reviewer', (live, e) => { live[e].protection_rules[0].reviewers.push({ type: 'User', reviewer: { login: 'other', id: 42 } }); }, /environment release: reviewers/],
      ['prevent_self_review true', (live, e) => { live[e].protection_rules[0].prevent_self_review = true; }, /environment release: prevent_self_review — data false, live true/],
      ['a second branch policy', (live, e) => { live[`${e}/deployment-branch-policies`].branch_policies.push({ id: 9, name: 'dev', type: 'branch' }); }, /environment release: branch policies/],
      ['protected_branches true', (live, e) => { live[e].deployment_branch_policy = { protected_branches: true, custom_branch_policies: false }; }, /environment release: deployment_branch_policy/],
      ['no secret', (live, e) => { live[`${e}/secrets`] = { total_count: 0, secrets: [] }; }, /environment release: secrets — data \["RELEASE_DEPLOY_KEY"\], live \[\]/],
      ['a secret of another name', (live, e) => { live[`${e}/secrets`] = { total_count: 1, secrets: [{ name: 'OTHER' }] }; }, /environment release: secrets/],
      ['the key also as a repository secret', (live) => { live[`repos/${REPO}/actions/secrets`] = { total_count: 1, secrets: [{ name: 'RELEASE_DEPLOY_KEY' }] }; }, /repository secret RELEASE_DEPLOY_KEY: it exists as a repository secret too/],
      ['administrators can bypass', (live, e) => { live[e].can_admins_bypass = true; }, /environment release: can_admins_bypass — data false, live true/],
      ['a wait timer', (live, e) => { live[e].protection_rules.push({ id: 3, type: 'wait_timer', wait_timer: 30 }); }, /environment release: wait_timer/],
    ];
    for (const [label, break_, expected] of cases) {
      const d = data();
      const live = liveFrom(d);
      break_(live, `repos/${REPO}/environments/release`);
      const r = await check(d, live);
      assert.equal(r.code, EXIT.DRIFT, `${label}: ${r.lines.join('\n')}`);
      assert.match(r.lines.join('\n'), expected, label);
    }
  });

  it('can_admins_bypass that the API does not show is a note for the owner, not a drift and not a pass of that field', async () => {
    const d = data();
    const live = liveFrom(d);
    delete live[`repos/${REPO}/environments/release`].can_admins_bypass;
    const r = await check(d, live);
    assert.equal(r.code, EXIT.MATCH, r.lines.join('\n'));
    assert.match(r.notes.join('\n'), /can_admins_bypass is not shown by the API; the owner sets it by hand/);
  });
});

describe('D3 secrets are read page by page', () => {
  const names = (from, count) => Array.from({ length: count }, (_, i) => ({ name: `S${from + i}` }));
  /** A listing of `total` secrets, 100 to a page; `hidden` is what the LAST page holds in place of the plain ones. */
  const paged = (total, last = []) => (query) => {
    const page = Number(query.get('page') ?? 1);
    const on = page === 1 ? names(0, Math.min(100, total)) : page === 2 ? [...names(100, Math.max(0, total - 101)), ...last] : [];
    return { total_count: total, secrets: on };
  };

  it('the key as a repository secret on the SECOND page is found: the first page is not the listing', async () => {
    const d = data();
    const live = liveFrom(d);
    live[`repos/${REPO}/actions/secrets`] = paged(101, [{ name: 'RELEASE_DEPLOY_KEY' }]);
    const r = await check(d, live);
    assert.equal(r.code, EXIT.DRIFT, r.lines.join('\n'));
    assert.match(r.lines.join('\n'), /repository secret RELEASE_DEPLOY_KEY: it exists as a repository secret too/);
  });

  it('a long listing without the key matches; a listing that ends short of its own count is exit 3, never a match', async () => {
    const d = data();
    const live = liveFrom(d);
    live[`repos/${REPO}/actions/secrets`] = (query) => ({ total_count: 150, secrets: Number(query.get('page') ?? 1) <= 2 ? names(0, 75) : [] });
    assert.equal((await check(d, live)).code, EXIT.MATCH);
    live[`repos/${REPO}/actions/secrets`] = (query) => ({ total_count: 150, secrets: Number(query.get('page') ?? 1) === 1 ? names(0, 100) : [] });
    const short = await check(d, live);
    assert.equal(short.code, EXIT.UNSEEN, short.lines.join('\n'));
    assert.match(short.lines.join('\n'), /repository secrets: could not look — .*short of the count/);
    live[`repos/${REPO}/actions/secrets`] = { secrets: [] };
    assert.equal((await check(d, live)).code, EXIT.UNSEEN, 'no total_count is no listing');
  });
});

describe('D4 the deploy key', () => {
  it('two keys, a read-only key, another public key, a data file with no key yet: exit 1, each named', async () => {
    const cases = [
      ['two keys', (live, d) => { live[`repos/${REPO}/keys`].push({ id: 6, key: 'ssh-ed25519 AAAAOTHER', title: 'laptop', read_only: false }); }, /deployKey: 2 deploy keys on GitHub/],
      ['read_only true', (live) => { live[`repos/${REPO}/keys`][0].read_only = true; }, /deployKey: read_only — data false, live true/],
      ['another public key', (live) => { live[`repos/${REPO}/keys`][0].key = 'ssh-ed25519 AAAAC3NzaSOMEONEELSESOMEONEELSE'; }, /deployKey: key — the public key on GitHub is not the one in the data/],
      ['another title', (live) => { live[`repos/${REPO}/keys`][0].title = 'laptop'; }, /deployKey: title/],
      ['no keys', (live) => { live[`repos/${REPO}/keys`] = []; }, /deployKey: 0 deploy keys on GitHub/],
    ];
    for (const [label, break_, expected] of cases) {
      const d = data();
      const live = liveFrom(d);
      break_(live, d);
      const r = await check(d, live);
      assert.equal(r.code, EXIT.DRIFT, `${label}: ${r.lines.join('\n')}`);
      assert.match(r.lines.join('\n'), expected, label);
    }
    const d = data();
    d.settings.deployKey.key = '';
    const r = await check(d, liveFrom(d));
    assert.equal(r.code, EXIT.DRIFT, r.lines.join('\n'));
    assert.match(r.lines.join('\n'), /deployKey: key — the data has no public key yet/);
  });

  it('the comment after the key does not make it another key', async () => {
    const d = data();
    const live = liveFrom(d);
    live[`repos/${REPO}/keys`][0].key = `${FAKE_KEY} release`;
    assert.equal((await check(d, live)).code, EXIT.MATCH);
  });
});

describe('D5 a part that could not be looked at', () => {
  it('403 or 404 on any part is exit 3 that names the part — never 0, and never hidden by a drift elsewhere', async () => {
    const parts = [
      [`repos/${REPO}/rulesets`, /rulesets: could not look/],
      [`repos/${REPO}/rulesets/100`, /could not look/],
      [`repos/${REPO}/environments/release`, /environment: could not look/],
      [`repos/${REPO}/environments/release/deployment-branch-policies`, /environment branch policies: could not look/],
      [`repos/${REPO}/environments/release/secrets`, /environment secrets: could not look/],
      [`repos/${REPO}/actions/secrets`, /repository secrets: could not look/],
      [`repos/${REPO}/keys`, /deploy keys: could not look/],
      [`repos/${REPO}/actions/permissions/workflow`, /actions permissions: could not look/],
      [`repos/${REPO}/actions/permissions/fork-pr-contributor-approval`, /fork approval: could not look/],
    ];
    for (const [endpoint, expected] of parts) {
      for (const status of [403, 404]) {
        const d = data();
        const live = liveFrom(d);
        live[endpoint] = new Error(`gh: ${status === 403 ? 'Resource not accessible by integration' : 'Not Found'} (HTTP ${status})`);
        const r = await check(d, live);
        assert.equal(r.code, EXIT.UNSEEN, `${endpoint} ${status}: ${r.lines.join('\n')}`);
        assert.match(r.lines.join('\n'), expected, endpoint);
      }
    }
    // a drift in another part does not turn "could not look" into "wrong": three is the worst answer
    const d = data();
    const live = liveFrom(d);
    live[`repos/${REPO}/keys`] = new Error('gh: Not Found (HTTP 404)');
    rulesetLive(live, 'main').enforcement = 'evaluate';
    const r = await check(d, live);
    assert.equal(r.code, EXIT.UNSEEN, r.lines.join('\n'));
    assert.match(r.lines.join('\n'), /DRIFT ruleset main/);
  });

  it('a ruleset answer with no bypass_actors is not "no bypass": the login cannot write it, so it is exit 3', async () => {
    const d = data();
    const live = liveFrom(d);
    delete rulesetLive(live, 'release-moves').bypass_actors;
    const r = await check(d, live);
    assert.equal(r.code, EXIT.UNSEEN, r.lines.join('\n'));
    assert.match(r.lines.join('\n'), /ruleset release-moves: could not look — the answer has no bypass_actors/);
  });
});

/** The data in a temp folder, with the deploy key line filled in, so `main` can read it from `root`. */
function dataDir(t, patch = () => {}) {
  const root = ownedDir(t, 'repo-settings');
  fs.mkdirSync(path.join(root, '.github', 'rulesets'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, '.github', 'rulesets'))) fs.copyFileSync(path.join(ROOT, '.github', 'rulesets', f), path.join(root, '.github', 'rulesets', f));
  fs.copyFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), path.join(root, '.claude-plugin', 'marketplace.json'));
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.github', 'settings.json'), 'utf8'));
  settings.deployKey.key = FAKE_KEY;
  patch(settings, root);
  fs.writeFileSync(path.join(root, '.github', 'settings.json'), JSON.stringify(settings, null, 2));
  return root;
}
const run = async (argv, { gh, root }) => {
  const out = [];
  const code = await main(argv, { GITHUB_REPOSITORY: REPO }, { gh, log: (m) => out.push(m), fail: (m) => out.push(m), root });
  return { code, out: out.join('\n') };
};
const hasDollar = (value) => JSON.stringify(value).includes('"$');

describe('D6 --apply', () => {
  it('sends the data without $ keys: POST when absent, PUT by id when present, the environment, the missing branch policy', async (t) => {
    const root = dataDir(t);
    const d = loadData(root);
    const live = liveFrom({ ...d, settings: d.settings });
    // main and tags-create exist; the other three do not; the environment has no branch policy yet
    live[`repos/${REPO}/rulesets`] = live[`repos/${REPO}/rulesets`].filter((r) => ['main', 'tags-create'].includes(r.name));
    live[`repos/${REPO}/environments/release/deployment-branch-policies`] = { total_count: 0, branch_policies: [] };
    const gh = fakeGh(live);
    await run(['--apply'], { gh, root });
    const writes = gh.writes();
    const ids = Object.fromEntries(live[`repos/${REPO}/rulesets`].map((r) => [r.name, r.id]));
    const summary = writes.map((w) => `${w.method} ${w.endpoint} ${w.body.name ?? ''}`.trim());
    assert.deepEqual(summary.filter((s) => /rulesets/.test(s)).sort(), [
      `POST repos/${REPO}/rulesets release-fixed`,
      `POST repos/${REPO}/rulesets release-moves`,
      `POST repos/${REPO}/rulesets tags-fixed`,
      `PUT repos/${REPO}/rulesets/${ids.main} main`,
      `PUT repos/${REPO}/rulesets/${ids['tags-create']} tags-create`,
    ]);
    const env = writes.find((w) => w.endpoint === `repos/${REPO}/environments/release`);
    assert.equal(env.method, 'PUT');
    assert.deepEqual(env.body, { wait_timer: 0, prevent_self_review: false, can_admins_bypass: false, reviewers: [{ type: 'User', id: 71817001 }], deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } });
    const policy = writes.find((w) => w.endpoint === `repos/${REPO}/environments/release/deployment-branch-policies`);
    assert.deepEqual([policy.method, policy.body], ['POST', { name: 'main', type: 'branch' }]);
    for (const w of writes) assert.ok(!hasDollar(w.body), `${w.endpoint} carries a $ key`);
    for (const w of writes) assert.ok(!/\/keys|secrets/.test(w.endpoint), `${w.endpoint}: the key and the secret are the owner's, never an apply's`);
    // the environment is written before its branch policy, and the rulesets before both
    const order = writes.map((w) => w.endpoint);
    assert.ok(order.indexOf(`repos/${REPO}/environments/release`) < order.indexOf(`repos/${REPO}/environments/release/deployment-branch-policies`));
  });

  it('then exits by the READ-BACK, not by the writes: every write accepted and GitHub still drifting is exit 1', async (t) => {
    const root = dataDir(t);
    const d = loadData(root);
    const live = liveFrom(d);
    rulesetLive(live, 'release-moves').bypass_actors.push({ actor_id: 15368, actor_type: 'Integration', bypass_mode: 'always' });
    const gh = fakeGh(live);
    const r = await run(['--apply'], { gh, root });
    assert.ok(gh.writes().length > 0, 'the writes were sent');
    assert.equal(r.code, EXIT.DRIFT, r.out);
    assert.match(r.out, /DRIFT ruleset release-moves: bypass_actors/);

    const equal = fakeGh(liveFrom(d));
    const ok = await run(['--apply'], { gh: equal, root });
    assert.ok(equal.writes().length > 0);
    assert.equal(ok.code, EXIT.MATCH, ok.out);
    assert.match(ok.out, /equals its data/);
  });

  it('--apply --dry-run sends nothing and prints the calls; --dry-run alone is a usage error', async (t) => {
    const root = dataDir(t);
    const live = liveFrom(loadData(root));
    live[`repos/${REPO}/rulesets`] = [];
    live[`repos/${REPO}/environments/release/deployment-branch-policies`] = { total_count: 0, branch_policies: [] };
    const gh = fakeGh(live);
    const r = await run(['--apply', '--dry-run'], { gh, root });
    assert.equal(r.code, EXIT.MATCH, r.out);
    assert.deepEqual(gh.writes(), [], 'a dry run sends no write');
    assert.ok(gh.calls.every((c) => c.args.length === 2 && c.args[0] === 'api'), 'only GETs');
    assert.match(r.out, /DRY RUN — \d+ call\(s\) an apply to example\/mods would make; nothing was sent/);
    assert.match(r.out, new RegExp(`POST repos/${REPO}/rulesets {3}\\{"name":"main"`));
    assert.match(r.out, new RegExp(`PUT repos/${REPO}/environments/release `));
    assert.match(r.out, new RegExp(`POST repos/${REPO}/environments/release/deployment-branch-policies `));
    const alone = await run(['--dry-run'], { gh: fakeGh(liveFrom(loadData(root))), root });
    assert.equal(alone.code, EXIT.USAGE, alone.out);
  });

  it('wrong data stops before GitHub is asked, and an unknown flag is a usage error', async (t) => {
    const root = dataDir(t);
    const file = path.join(root, '.github', 'rulesets', 'main.json');
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    body.bypass_actors = [{ actor_id: 5, actor_type: 'Integration', bypass_mode: 'always' }];
    fs.writeFileSync(file, JSON.stringify(body));
    const gh = fakeGh(liveFrom(loadData(root)));
    const r = await run([], { gh, root });
    assert.equal(r.code, EXIT.USAGE, r.out);
    assert.match(r.out, /the data is wrong, nothing was asked of GitHub/);
    assert.deepEqual(gh.calls, []);
    assert.equal((await run(['--force'], { gh, root })).code, EXIT.USAGE);
  });
});

describe('D7 the Actions settings', () => {
  it('a write-by-default token, a workflow that can approve pull requests, a laxer fork policy: exit 1, each named', async () => {
    const cases = [
      [(live) => { live[`repos/${REPO}/actions/permissions/workflow`].default_workflow_permissions = 'write'; }, /actions: default_workflow_permissions — data read, live write/],
      [(live) => { live[`repos/${REPO}/actions/permissions/workflow`].can_approve_pull_request_reviews = true; }, /actions: can_approve_pull_request_reviews/],
      [(live) => { live[`repos/${REPO}/actions/permissions/fork-pr-contributor-approval`].approval_policy = 'first_time_contributors'; }, /actions: fork_pr_contributor_approval — data all_external_contributors/],
    ];
    for (const [break_, expected] of cases) {
      const d = data();
      const live = liveFrom(d);
      break_(live);
      const r = await check(d, live);
      assert.equal(r.code, EXIT.DRIFT, r.lines.join('\n'));
      assert.match(r.lines.join('\n'), expected);
    }
  });

  it('planApply decides POST or PUT from the reads and sends nothing itself', async () => {
    const d = data();
    const gh = fakeGh(liveFrom(d));
    const plan = await planApply({ data: d, gh, repo: REPO });
    assert.equal(plan.filter((c) => c.method === 'PUT').length, 6, 'five rulesets by id and the environment');
    assert.deepEqual(gh.writes(), []);
  });
});

describe('D8 the gh launcher stops the whole tree at its ceiling', () => {
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const POSIX = process.platform !== 'win32';

  it('a gh that outlives the ceiling is killed with the child it started: the timeout is an error and no descendant is left', { skip: !POSIX }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-launcher-'));
    const pidFile = path.join(dir, 'grandchild.pid');
    t.after(() => {
      try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* gone, as it should be */ }
      fs.rmSync(dir, { recursive: true, force: true });
    });
    fs.mkdirSync(path.join(dir, 'bin'));
    // The fake gh starts a descendant that holds no pipe (so only a tree kill can reach it), records its pid and hangs.
    fs.writeFileSync(path.join(dir, 'bin', 'gh'), '#!/bin/sh\nsleep 300 >/dev/null 2>&1 &\necho $! > "$PID_FILE"\nsleep 300\n', { mode: 0o755 });
    const gh = ghLauncher({ ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, PID_FILE: pidFile }, { timeoutMs: 700 });
    const refused = await gh(['api', 'user']).then(() => null, (error) => error);
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(grandchild > 1, 'the fake gh recorded its descendant');
    const until = Date.now() + 3000;
    while (alive(grandchild) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    assert.equal(alive(grandchild), false, 'the descendant of a timed-out gh is gone');
    assert.match(String(refused?.message), /timed out/);
  });

  it('a normal call returns its output, writes stdin, and a failing call says the first line of stderr', { skip: !POSIX }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-launcher-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin', 'gh'), '#!/bin/sh\nif [ "$1" = fail ]; then echo "gh: Not Found (HTTP 404)" >&2; echo more >&2; exit 1; fi\nif [ "$1" = echo ]; then cat; else echo "args:$*"; fi\n', { mode: 0o755 });
    const gh = ghLauncher({ ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}` });
    assert.equal((await gh(['api', 'user'])).trim(), 'args:api user');
    assert.equal(await gh(['echo'], '{"a":1}'), '{"a":1}');
    await assert.rejects(gh(['fail']), (e) => e.message === 'gh: Not Found (HTTP 404)');
  });
});
