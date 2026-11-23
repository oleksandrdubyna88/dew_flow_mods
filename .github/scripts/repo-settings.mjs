#!/usr/bin/env node
/**
 * The settings of this repository that GitHub holds and no file can make it read — as data, and the drift from it as
 * an exit code. The shape is `branch-protection.mjs` of dew_flow_conventions: the data is reviewed, the check is a
 * command, `--apply` writes the data, and the exit code is read back from GitHub, never from the write.
 *
 *   node .github/scripts/repo-settings.mjs                    # read every part back and compare it with the data
 *   node .github/scripts/repo-settings.mjs --apply            # write the rulesets and the environment, then read back
 *   node .github/scripts/repo-settings.mjs --apply --dry-run  # only PRINT the calls an apply would make (GETs only)
 *
 * The data: `.github/rulesets/*.json` (each file is the body of POST /repos/{r}/rulesets) and `.github/settings.json`
 * (the `release` environment, the deploy key, the Actions settings). Keys that start with `$` are for the reader and
 * never reach GitHub.
 *
 * Exit: 0 every part equals its data · 1 drift, each difference printed as `part: field` · 2 called wrongly, or the
 * data itself is wrong · 3 a part could not be looked at (403, 404, no network, no token). THREE IS NOT ONE: "it is
 * wrong" and "I could not look" are different answers, and 0 is never printed for a part that was not seen.
 *
 * What `--apply` does NOT do, on purpose: it adds no deploy key and sets no secret. A key that an agent session made
 * is a key that session could keep, so the owner makes both in the owner's own terminal (README, "The release gate").
 * `gh` is a function parameter (argv, optional stdin → stdout), as in tools/promote-release.mjs: no environment
 * variable names the executable.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { killTree } from '../../tools/lib/proc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(HERE, '..', '..');
const GH_TIMEOUT_MS = 30_000;

export const EXIT = Object.freeze({ MATCH: 0, DRIFT: 1, USAGE: 2, UNSEEN: 3 });

/** The one bypass actor a ruleset of this repository may have: every deploy key, always. */
export const DEPLOY_KEY_ACTOR = Object.freeze({ actor_id: null, actor_type: 'DeployKey', bypass_mode: 'always' });
/** Rulesets that may carry that actor; every other ruleset has none. */
export const MAY_BYPASS = Object.freeze(['release-moves', 'tags-create']);
/**
 * The rule types each ruleset holds, sorted: exactly these and no others. A bypass covers every rule of its ruleset,
 * so a rule added or taken out changes what a ruleset means; the data may not do that without this table changing.
 */
export const RULE_TYPES = Object.freeze({
  main: ['deletion', 'non_fast_forward', 'pull_request', 'required_linear_history', 'required_status_checks'],
  'release-moves': ['creation', 'update'],
  'release-fixed': ['deletion', 'non_fast_forward'],
  'tags-create': ['creation'],
  'tags-fixed': ['deletion', 'update'],
});

/**
 * What each ruleset holds, exactly: its target and its include. A ruleset on another ref than its own protects nothing
 * of the ref it is named for (`release-fixed` pointed at main leaves release open to a rewind), so the data may not
 * move a ruleset to another ref without this table changing. EVERY tag (`~ALL`), not a pattern per plugin: a pattern
 * covers only the names it spells, and `git fetch origin release` or `git clone --branch release` takes a TAG named
 * release when one exists. Nobody but the deploy key creates a tag.
 */
export const SCOPE = Object.freeze({
  main: { target: 'branch', include: ['refs/heads/main'] },
  'release-moves': { target: 'branch', include: ['refs/heads/release'] },
  'release-fixed': { target: 'branch', include: ['refs/heads/release'] },
  'tags-create': { target: 'tag', include: ['~ALL'] },
  'tags-fixed': { target: 'tag', include: ['~ALL'] },
});

/** The Actions app's id: a required check names it, so a status posted by another identity does not count. */
export const ACTIONS_APP_ID = 15368;

const firstLine = (text) => String(text ?? '').trim().split('\n')[0];
const sorted = (list) => [...list].sort((a, b) => (a < b ? -1 : Number(a > b)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stripNotes = (value) => {
  if (Array.isArray(value)) return value.map(stripNotes);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('$')).map(([key, v]) => [key, stripNotes(v)]));
  }
  return value;
};

/** The data, read from `root`: every ruleset file, the settings file, the catalog. */
export function loadData(root = ROOT) {
  const rulesetDir = path.join(root, '.github', 'rulesets');
  const rulesets = fs.readdirSync(rulesetDir).filter((f) => f.endsWith('.json')).sort()
    .map((file) => ({ file, body: JSON.parse(fs.readFileSync(path.join(rulesetDir, file), 'utf8')) }));
  const settings = JSON.parse(fs.readFileSync(path.join(root, '.github', 'settings.json'), 'utf8'));
  const catalog = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  return { rulesets, settings, catalog };
}

/**
 * The data is written in the form GitHub reads back, so a read-back that differs is a real difference: a pull_request
 * rule carries the two server defaults, and an update rule has no parameters unless one is true (GitHub drops an empty or false-only object).
 */
function canonicalFindings(file, body) {
  const hasTrueValue = (parameters) => Object.values(parameters ?? {}).some((v) => v === true);
  return (body.rules ?? []).flatMap((rule) => {
    if (rule.type === 'update') {
      return 'parameters' in rule && !hasTrueValue(rule.parameters)
        ? [`${file}: ${body.name}: the update rule has parameters; GitHub drops an empty or false-only object, so write the rule without them`]
        : [];
    }
    if (rule.type !== 'pull_request') return [];
    const p = rule.parameters ?? {};
    return [
      ...(same(p.required_reviewers, []) ? [] : [`${file}: ${body.name}: pull_request.required_reviewers is ${JSON.stringify(p.required_reviewers)}, GitHub's form is []`]),
      ...(p.require_extra_approval_for_unattributed_changes === true ? [] : [`${file}: ${body.name}: pull_request.require_extra_approval_for_unattributed_changes is ${JSON.stringify(p.require_extra_approval_for_unattributed_changes)}, GitHub's form is true`]),
    ];
  });
}

/**
 * D1: what the data must be before anything is compared with it. Returns the findings (empty is good).
 * Every bypass list is empty or exactly the deploy key (and only the two `move` rulesets have it); every ruleset is
 * `active`; every named ruleset is present, on its own target and exactly its own include (both tag rulesets cover
 * every tag, `~ALL`); each ruleset has its exact rule types and an empty exclude.
 */
export function validateData({ rulesets, settings, catalog }) {
  const findings = [];
  const byName = new Map();
  for (const { file, body } of rulesets) {
    if (byName.has(body.name)) findings.push(`${file}: the name "${body.name}" is used twice`);
    byName.set(body.name, body);
    const bypass = body.bypass_actors;
    if (!Array.isArray(bypass)) findings.push(`${file}: bypass_actors is not a list`);
    else if (bypass.length > 0 && !(bypass.length === 1 && same(bypass[0], DEPLOY_KEY_ACTOR))) {
      findings.push(`${file}: bypass_actors is ${JSON.stringify(bypass)}; it is [] or exactly the one DeployKey actor`);
    } else if (bypass.length === 1 && !MAY_BYPASS.includes(body.name)) {
      findings.push(`${file}: ${body.name} has the DeployKey bypass; only ${MAY_BYPASS.join(' and ')} may`);
    }
    if (body.enforcement !== 'active') findings.push(`${file}: enforcement is ${JSON.stringify(body.enforcement)}, it must be "active"`);
    if (!['branch', 'tag'].includes(body.target)) findings.push(`${file}: target is ${JSON.stringify(body.target)}`);
    else if (body.name in SCOPE && body.target !== SCOPE[body.name].target) findings.push(`${file}: target is ${JSON.stringify(body.target)}, it must be ${JSON.stringify(SCOPE[body.name].target)}`);
    if (!(body.name in RULE_TYPES)) findings.push(`${file}: the name ${JSON.stringify(body.name)} is not one of ${Object.keys(RULE_TYPES).join(', ')}`);
    else {
      const types = sorted((body.rules ?? []).map((r) => r.type));
      if (!same(types, RULE_TYPES[body.name])) findings.push(`${file}: ${body.name}: the rule types are ${JSON.stringify(types)}, they must be ${JSON.stringify(RULE_TYPES[body.name])}`);
    }
    findings.push(...canonicalFindings(file, body));
    const exclude = body.conditions?.ref_name?.exclude;
    if (!same(exclude, [])) findings.push(`${file}: ${body.name}: conditions.ref_name.exclude is ${JSON.stringify(exclude)}, it must be []: an exclude takes refs out of the rules`);
  }
  for (const name of Object.keys(SCOPE)) {
    if (!byName.has(name)) findings.push(`${name}: the ruleset is missing from .github/rulesets; the data must hold all of ${Object.keys(SCOPE).join(', ')}`);
  }
  for (const name of MAY_BYPASS) {
    if (byName.has(name) && byName.get(name).bypass_actors?.length !== 1) findings.push(`${name}: the ruleset lacks the DeployKey bypass that lets the promotion move the ref`);
  }
  for (const [name, { include: want }] of Object.entries(SCOPE)) {
    const include = byName.get(name)?.conditions?.ref_name?.include;
    if (byName.has(name) && !same(include, want)) findings.push(`${name}: conditions.ref_name.include is ${JSON.stringify(include)}, it must be ${JSON.stringify(want)}${want[0] === '~ALL' ? ': every tag, not a pattern' : ': the ref this ruleset is named for, and no other'}`);
  }
  const env = settings.environment ?? {};
  if (!Array.isArray(env.reviewers) || env.reviewers.length !== 1) findings.push('settings.json: the environment has exactly one reviewer, the owner');
  if (!same(env.branch_policies, [{ name: 'main', type: 'branch' }])) findings.push('settings.json: the environment deploys from the branch main only');
  if (!same(env.secrets, ['RELEASE_DEPLOY_KEY'])) findings.push('settings.json: the environment holds the one secret RELEASE_DEPLOY_KEY');
  if (settings.deployKey?.read_only !== false) findings.push('settings.json: the deploy key is writable (read_only false)');
  return findings;
}

// ── reading GitHub ───────────────────────────────────────────────────────────────────────────────

/** A part that could not be looked at: the part, and why. Never a drift. */
class Unseen extends Error {
  constructor(part, reason) {
    super(`${part}: ${reason}`);
    this.part = part;
  }
}

async function get(gh, part, endpoint) {
  let text;
  try {
    text = await gh(['api', endpoint]);
  } catch (error) {
    const said = firstLine(error.message);
    const denied = /HTTP (403|404)/.test(said);
    throw new Unseen(part, `could not look — ${said}${denied ? ' (denied, or not there: the part cannot be judged either way)' : ''}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Unseen(part, 'could not look — the answer is not JSON');
  }
}

/** A page holds at most this many; the listing endpoints answer 30 unless asked. */
const PER_PAGE = 100;
/** A ceiling on paging, so an answer that keeps claiming more cannot spin here for ever (1000 secrets). */
const MAX_PAGES = 10;

/**
 * The names of every secret of a listing (`{total_count, secrets: [{name}]}`), read page by page. The first page is not
 * the listing: a match on "the key is not a repository secret" is only as good as the pages that were read. A listing
 * with no `total_count`, a page empty before the count is reached, or more pages than the ceiling is unreadable.
 */
async function secretNames(gh, part, endpoint) {
  const names = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const answer = await get(gh, part, `${endpoint}?per_page=${PER_PAGE}&page=${page}`);
    if (!Number.isSafeInteger(answer?.total_count) || answer.total_count < 0 || !Array.isArray(answer.secrets)) {
      throw new Unseen(part, 'could not look — the answer has no readable total_count and secrets');
    }
    names.push(...answer.secrets.map((s) => s.name));
    if (names.length >= answer.total_count) return names;
    if (answer.secrets.length === 0) throw new Unseen(part, `could not look — the listing ends at ${names.length} of ${answer.total_count} secrets, short of the count GitHub gave`);
  }
  throw new Unseen(part, `could not look — more than ${MAX_PAGES} pages of secrets`);
}

/** A ruleset reduced to what the data speaks for: GitHub's answer adds ids, urls and `source`. */
export function normaliseRuleset(body) {
  const params = (rule) => {
    const p = rule.parameters ?? null;
    if (p === null) return null;
    const out = { ...p };
    if (Array.isArray(out.required_status_checks)) {
      out.required_status_checks = [...out.required_status_checks]
        .map((c) => ({ context: c.context, integration_id: c.integration_id ?? null }))
        .sort((a, b) => (a.context < b.context ? -1 : Number(a.context > b.context)));
    }
    if (Array.isArray(out.allowed_merge_methods)) out.allowed_merge_methods = sorted(out.allowed_merge_methods);
    // GitHub answers its keys in its own order; the order of a parameter object is not a difference.
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : Number(a > b))));
  };
  const ref = body.conditions?.ref_name ?? {};
  return {
    name: body.name,
    target: body.target,
    enforcement: body.enforcement,
    include: sorted(ref.include ?? []),
    exclude: sorted(ref.exclude ?? []),
    bypass_actors: (body.bypass_actors ?? [])
      .map((a) => ({ actor_id: a.actor_id ?? null, actor_type: a.actor_type, bypass_mode: a.bypass_mode }))
      .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
    rules: Object.fromEntries((body.rules ?? []).map((r) => [r.type, params(r)])),
  };
}

/** The differences of one ruleset, as `field — data X, live Y` lines. */
function diffRuleset(want, got) {
  const out = [];
  for (const field of ['target', 'enforcement', 'include', 'exclude', 'bypass_actors']) {
    if (!same(want[field], got[field])) out.push(`${field === 'include' || field === 'exclude' ? `conditions.ref_name.${field}` : field} — data ${JSON.stringify(want[field])}, live ${JSON.stringify(got[field])}`);
  }
  for (const type of sorted(new Set([...Object.keys(want.rules), ...Object.keys(got.rules)]))) {
    if (!(type in got.rules)) out.push(`rules.${type} — missing on GitHub`);
    else if (!(type in want.rules)) out.push(`rules.${type} — on GitHub, not in the data`);
    else if (!same(want.rules[type], got.rules[type])) out.push(`rules.${type}.parameters — data ${JSON.stringify(want.rules[type])}, live ${JSON.stringify(got.rules[type])}`);
  }
  return out;
}

async function readRulesets({ data, gh, repo }) {
  const drift = [];
  const notes = [];
  const list = await get(gh, 'rulesets', `repos/${repo}/rulesets?per_page=100&includes_parents=false`);
  if (!Array.isArray(list)) throw new Unseen('rulesets', 'could not look — the answer is not a list');
  const wanted = new Set(data.rulesets.map((r) => r.body.name));
  for (const { body } of data.rulesets) {
    const found = list.find((r) => r.name === body.name);
    if (found === undefined) {
      drift.push(`ruleset ${body.name}: missing — the data has it, GitHub has none`);
      continue;
    }
    const full = await get(gh, `ruleset ${body.name}`, `repos/${repo}/rulesets/${found.id}`);
    // bypass_actors is shown only to a caller who can write the ruleset: an answer without the key is not "no bypass".
    if (!Array.isArray(full.bypass_actors)) throw new Unseen(`ruleset ${body.name}`, 'could not look — the answer has no bypass_actors (it is shown only to a caller who can write the ruleset)');
    for (const line of diffRuleset(normaliseRuleset(stripNotes(body)), normaliseRuleset(full))) drift.push(`ruleset ${body.name}: ${line}`);
  }
  for (const found of list) {
    if (!wanted.has(found.name)) notes.push(`ruleset "${found.name}" (id ${found.id}) is on GitHub and not in the data: listed, not drift`);
  }
  return { part: 'rulesets', drift, notes };
}

async function readEnvironment({ data, gh, repo }) {
  const want = data.settings.environment;
  const name = want.name;
  const drift = [];
  const notes = [];
  const env = await get(gh, 'environment', `repos/${repo}/environments/${name}`);
  const rules = env.protection_rules ?? [];
  const waitTimer = rules.find((r) => r.type === 'wait_timer')?.wait_timer ?? 0;
  const review = rules.find((r) => r.type === 'required_reviewers');
  const reviewers = (review?.reviewers ?? []).map((r) => ({ type: r.type, id: r.reviewer?.id })).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  if (waitTimer !== want.wait_timer) drift.push(`environment ${name}: wait_timer — data ${want.wait_timer}, live ${waitTimer}`);
  if (!same(reviewers, [...want.reviewers].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)))) {
    drift.push(`environment ${name}: reviewers — data ${JSON.stringify(want.reviewers)}, live ${JSON.stringify(reviewers)}`);
  }
  const prevent = review?.prevent_self_review === true;
  if (prevent !== want.prevent_self_review) drift.push(`environment ${name}: prevent_self_review — data ${want.prevent_self_review}, live ${prevent}`);
  const policy = env.deployment_branch_policy ?? { protected_branches: false, custom_branch_policies: false };
  if (!same({ protected_branches: policy.protected_branches, custom_branch_policies: policy.custom_branch_policies }, want.deployment_branch_policy)) {
    drift.push(`environment ${name}: deployment_branch_policy — data ${JSON.stringify(want.deployment_branch_policy)}, live ${JSON.stringify(policy)}`);
  }
  if (typeof env.can_admins_bypass === 'boolean') {
    if (env.can_admins_bypass !== want.can_admins_bypass) drift.push(`environment ${name}: can_admins_bypass — data ${want.can_admins_bypass}, live ${env.can_admins_bypass}`);
  } else {
    notes.push(`environment ${name}: can_admins_bypass is not shown by the API; the owner sets it by hand and the record says so`);
  }
  const policies = await get(gh, 'environment branch policies', `repos/${repo}/environments/${name}/deployment-branch-policies`);
  const livePolicies = (policies.branch_policies ?? []).map((p) => ({ name: p.name, type: p.type ?? 'branch' })).sort((a, b) => (a.name < b.name ? -1 : 1));
  if (!same(livePolicies, [...want.branch_policies].sort((a, b) => (a.name < b.name ? -1 : 1)))) {
    drift.push(`environment ${name}: branch policies — data ${JSON.stringify(want.branch_policies)}, live ${JSON.stringify(livePolicies)}`);
  }
  const liveSecrets = sorted(await secretNames(gh, 'environment secrets', `repos/${repo}/environments/${name}/secrets`));
  if (!same(liveSecrets, sorted(want.secrets))) drift.push(`environment ${name}: secrets — data ${JSON.stringify(sorted(want.secrets))}, live ${JSON.stringify(liveSecrets)}`);
  for (const secret of await secretNames(gh, 'repository secrets', `repos/${repo}/actions/secrets`)) {
    if (want.secrets.includes(secret)) drift.push(`repository secret ${secret}: it exists as a repository secret too; the deploy key lives in the environment only`);
  }
  return { part: 'environment', drift, notes };
}

/** The first two fields of a public key line: the type and the key; the comment is not the key. */
const keyBody = (line) => String(line ?? '').trim().split(/\s+/).slice(0, 2).join(' ');

async function readDeployKey({ data, gh, repo }) {
  const want = data.settings.deployKey;
  const drift = [];
  const keys = await get(gh, 'deploy keys', `repos/${repo}/keys`);
  if (!Array.isArray(keys)) throw new Unseen('deploy keys', 'could not look — the answer is not a list');
  if (keys.length !== 1) {
    drift.push(`deployKey: ${keys.length} deploy keys on GitHub (${keys.map((k) => JSON.stringify(k.title)).join(', ') || 'none'}), the data has exactly one`);
    return { part: 'deploy key', drift, notes: [] };
  }
  const [live] = keys;
  if (live.title !== want.title) drift.push(`deployKey: title — data ${JSON.stringify(want.title)}, live ${JSON.stringify(live.title)}`);
  if (live.read_only !== want.read_only) drift.push(`deployKey: read_only — data ${want.read_only}, live ${live.read_only}`);
  if (keyBody(want.key) === '') drift.push('deployKey: key — the data has no public key yet; a pull request writes the line the owner printed');
  else if (keyBody(live.key) !== keyBody(want.key)) drift.push(`deployKey: key — the public key on GitHub is not the one in the data (live ${keyBody(live.key).slice(0, 24)}…)`);
  return { part: 'deploy key', drift, notes: [] };
}

async function readActions({ data, gh, repo }) {
  const want = data.settings.actions;
  const drift = [];
  const workflow = await get(gh, 'actions permissions', `repos/${repo}/actions/permissions/workflow`);
  if (workflow.default_workflow_permissions !== want.default_workflow_permissions) drift.push(`actions: default_workflow_permissions — data ${want.default_workflow_permissions}, live ${workflow.default_workflow_permissions}`);
  if (workflow.can_approve_pull_request_reviews !== want.can_approve_pull_request_reviews) drift.push(`actions: can_approve_pull_request_reviews — data ${want.can_approve_pull_request_reviews}, live ${workflow.can_approve_pull_request_reviews}`);
  const fork = await get(gh, 'fork approval', `repos/${repo}/actions/permissions/fork-pr-contributor-approval`);
  if (fork.approval_policy !== want.fork_pr_contributor_approval) drift.push(`actions: fork_pr_contributor_approval — data ${want.fork_pr_contributor_approval}, live ${fork.approval_policy}`);
  return { part: 'actions', drift, notes: [] };
}

const PARTS = [readRulesets, readEnvironment, readDeployKey, readActions];

/**
 * Read every part back and compare it with the data. Returns `{code, lines, notes}`; the code is the worst of the
 * parts (0 < 1 < 3), because answering 0 for the part that happened to be fine is the lie these codes exist to prevent.
 */
export async function readBack({ data, gh, repo }) {
  const lines = [];
  const notes = [];
  let code = EXIT.MATCH;
  for (const read of PARTS) {
    try {
      const result = await read({ data, gh, repo });
      notes.push(...result.notes);
      if (result.drift.length === 0) lines.push(`${result.part}: matches the data`);
      else {
        code = Math.max(code, EXIT.DRIFT);
        lines.push(...result.drift.map((d) => `DRIFT ${d}`));
      }
    } catch (error) {
      if (!(error instanceof Unseen)) throw error;
      code = Math.max(code, EXIT.UNSEEN);
      lines.push(`COULD NOT LOOK ${error.message}`);
    }
  }
  return { code, lines, notes };
}

// ── writing GitHub (only with --apply) ───────────────────────────────────────────────────────────

/** The body of the environment PUT: the data without notes and without the parts that have their own endpoints. */
export function environmentBody(settings) {
  const e = stripNotes(settings.environment);
  return {
    wait_timer: e.wait_timer,
    prevent_self_review: e.prevent_self_review,
    can_admins_bypass: e.can_admins_bypass,
    reviewers: e.reviewers,
    deployment_branch_policy: e.deployment_branch_policy,
  };
}

/**
 * The writes of an apply, in order, as `{method, endpoint, body}`: each ruleset POST when absent and PUT by id when
 * present; the environment PUT; each branch policy POST when absent. Reads (GET) decide POST or PUT; nothing is sent.
 */
export async function planApply({ data, gh, repo }) {
  const plan = [];
  const list = await get(gh, 'rulesets', `repos/${repo}/rulesets?per_page=100&includes_parents=false`);
  if (!Array.isArray(list)) throw new Unseen('rulesets', 'could not look — the answer is not a list');
  for (const { body } of data.rulesets) {
    const found = list.find((r) => r.name === body.name);
    const sent = stripNotes(body);
    plan.push(found === undefined
      ? { method: 'POST', endpoint: `repos/${repo}/rulesets`, body: sent }
      : { method: 'PUT', endpoint: `repos/${repo}/rulesets/${found.id}`, body: sent });
  }
  const env = data.settings.environment;
  plan.push({ method: 'PUT', endpoint: `repos/${repo}/environments/${env.name}`, body: environmentBody(data.settings) });
  let existing = [];
  try {
    const answer = await gh(['api', `repos/${repo}/environments/${env.name}/deployment-branch-policies`]);
    existing = JSON.parse(answer).branch_policies ?? [];
  } catch {
    existing = []; // the environment does not exist yet: its first PUT comes before, and every policy is absent
  }
  for (const policy of env.branch_policies) {
    if (!existing.some((p) => p.name === policy.name)) plan.push({ method: 'POST', endpoint: `repos/${repo}/environments/${env.name}/deployment-branch-policies`, body: stripNotes(policy) });
  }
  return plan;
}

async function send(gh, { method, endpoint, body }) {
  await gh(['api', '-X', method, endpoint, '--input', '-'], JSON.stringify(body));
}

// ── the command ──────────────────────────────────────────────────────────────────────────────────

/**
 * The launcher of `gh`: argv and optional stdin in, stdout out, an Error whose message is the first line of stderr.
 * A `gh` that outlives `timeoutMs` is killed WITH everything it started (`killTree` of tools/lib/proc.mjs: the process
 * group, or `taskkill /T` on Windows): a timeout that only stops waiting leaves an orphan, and a plain `child.kill()` on
 * Windows reaches the shell and none of its children. `proc.run` has no stdin, and `--input -` needs one.
 */
export function ghLauncher(env = process.env, { timeoutMs = GH_TIMEOUT_MS, maxBytes = 8 * 1024 * 1024 } = {}) {
  return (args, input) => new Promise((resolve, reject) => {
    const child = spawn('gh', args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    const out = [];
    const err = [];
    let size = 0;
    let timedOut = false;
    let overflow = false;
    let failure = null;
    const take = (list) => (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        overflow = true;
        killTree(child);
      } else list.push(chunk);
    };
    child.stdout.on('data', take(out));
    child.stderr.on('data', take(err));
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on('error', (error) => { failure = error; });
    // A gh that exits can leave descendants holding its pipes; end its group now, or 'close' never comes.
    child.on('exit', () => killTree(child));
    child.on('close', (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(err).toString('utf8');
      if (timedOut) reject(new Error(`gh timed out after ${timeoutMs} ms and was stopped with everything it started`));
      else if (overflow) reject(new Error(`gh printed more than ${maxBytes} bytes`));
      else if (failure !== null) reject(new Error(firstLine(failure.message)));
      else if (code !== 0) reject(new Error(firstLine(stderr) || `gh exited with ${code}`));
      else resolve(Buffer.concat(out).toString('utf8'));
    });
    child.stdin.on('error', () => { /* gh ended before it read its input: its exit code says why */ });
    child.stdin.end(input);
  });
}

function repositoryOf(env, argv) {
  const at = argv.indexOf('--repo');
  if (at !== -1) return argv[at + 1] ?? '';
  if (/^[^\s/]+\/[^\s/]+$/.test(env.GITHUB_REPOSITORY ?? '')) return env.GITHUB_REPOSITORY;
  try {
    const url = execFileSync('git', ['-C', ROOT, 'remote', 'get-url', 'origin'], { encoding: 'utf8', timeout: 20_000 }).trim();
    const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
    return m === null ? '' : `${m[1]}/${m[2]}`;
  } catch {
    return '';
  }
}

export async function main(argv, env = process.env, { gh = ghLauncher(env), log = console.log, fail = console.error, root = ROOT } = {}) {
  const known = ['--apply', '--dry-run', '--repo'];
  const flags = argv.filter((a, i) => a.startsWith('--') && !(argv[i - 1] === '--repo'));
  const bad = flags.filter((f) => !known.includes(f));
  const apply = argv.includes('--apply');
  const dry = argv.includes('--dry-run');
  if (bad.length > 0 || (dry && !apply)) {
    fail(`repo-settings: usage: node .github/scripts/repo-settings.mjs [--repo owner/name] [--apply [--dry-run]]${dry && !apply ? ' (--dry-run goes with --apply)' : ''}`);
    return EXIT.USAGE;
  }
  const repo = repositoryOf(env, argv);
  if (!/^[^\s/]+\/[^\s/]+$/.test(repo)) {
    fail('repo-settings: which repository? pass --repo owner/name, or set GITHUB_REPOSITORY, or point origin at GitHub.');
    return EXIT.USAGE;
  }
  let data;
  try {
    data = loadData(root);
  } catch (error) {
    fail(`repo-settings: the data cannot be read — ${firstLine(error.message)}`);
    return EXIT.USAGE;
  }
  const problems = validateData(data);
  if (problems.length > 0) {
    fail('repo-settings: the data is wrong, nothing was asked of GitHub:');
    for (const p of problems) fail(`  ${p}`);
    return EXIT.USAGE;
  }

  if (apply) {
    let plan;
    try {
      plan = await planApply({ data, gh, repo });
    } catch (error) {
      if (!(error instanceof Unseen)) throw error;
      fail(`repo-settings: ${error.message}`);
      return EXIT.UNSEEN;
    }
    if (dry) {
      log(`repo-settings: DRY RUN — ${plan.length} call(s) an apply to ${repo} would make; nothing was sent.`);
      for (const call of plan) log(`  ${call.method} ${call.endpoint}   ${JSON.stringify(call.body)}`);
      return EXIT.MATCH;
    }
    for (const call of plan) {
      try {
        await send(gh, call);
        log(`repo-settings: ${call.method} ${call.endpoint}`);
      } catch (error) {
        fail(`repo-settings: ${call.method} ${call.endpoint} failed — ${firstLine(error.message)}`);
        return EXIT.UNSEEN;
      }
    }
  }

  const result = await readBack({ data, gh, repo });
  for (const line of result.lines) (line.startsWith('DRIFT') || line.startsWith('COULD NOT') ? fail : log)(`repo-settings: ${line}`);
  for (const note of result.notes) log(`repo-settings: note — ${note}`);
  if (result.code === EXIT.MATCH) log(`repo-settings: ${repo} equals its data.`);
  return result.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(`repo-settings: could not finish — ${firstLine(error.message)}`);
    process.exitCode = EXIT.UNSEEN;
  });
}
