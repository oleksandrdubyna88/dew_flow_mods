// STUB for the RED run: the gate that finds nothing. Replaced by the real gate in the next commit.
export const FORBIDDEN_NAMES = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"];
export function layoutFindings() { return []; }
export function versionVerdict() { return { ok: true, tags: [], changed: [] }; }
