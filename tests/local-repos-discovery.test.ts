import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { discoverLocalGitRepos } from "../dist/server/dashboard.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "antfarm-local-repos-"));
after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function mkdirp(...parts: string[]): string {
  const full = path.join(tmpRoot, ...parts);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

function createGitRepo(dir: string, asFile = false): void {
  if (asFile) fs.writeFileSync(path.join(dir, ".git"), "gitdir: ../.git/worktrees/example\n");
  else fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
}

test("discoverLocalGitRepos returns only git repos with normalized absolute path and name", () => {
  const repoA = mkdirp("projects", "alpha");
  const repoB = mkdirp("projects", "beta");
  const notRepo = mkdirp("projects", "notes");
  createGitRepo(repoA);
  createGitRepo(repoB, true);
  fs.writeFileSync(path.join(notRepo, "README.md"), "not a repo\n");

  const repos = discoverLocalGitRepos([path.join(tmpRoot, "projects")]);
  const byPath = new Map(repos.map((repo) => [repo.path, repo]));

  assert.equal(repos.some((repo) => repo.path === path.resolve(notRepo)), false, "non-repo directory should be excluded");
  assert.ok(byPath.has(path.resolve(repoA)));
  assert.ok(byPath.has(path.resolve(repoB)));
  assert.equal(byPath.get(path.resolve(repoA))?.name, "alpha");
  assert.equal(byPath.get(path.resolve(repoB))?.name, "beta");
});

test("discoverLocalGitRepos de-duplicates repo paths and includes suggestedPort when inferable", () => {
  const rootRepo = mkdirp("antfarm");
  const featureRepo = mkdirp("antfarm-feature-42");
  createGitRepo(rootRepo);
  createGitRepo(featureRepo);

  const repos = discoverLocalGitRepos([tmpRoot, tmpRoot]);
  const antfarm = repos.find((repo) => repo.path === path.resolve(rootRepo));
  const feature = repos.find((repo) => repo.path === path.resolve(featureRepo));

  assert.ok(antfarm);
  assert.ok(feature);
  assert.equal(antfarm?.suggestedPort, 3333);
  assert.equal(feature?.suggestedPort, 3442);

  const uniquePaths = new Set(repos.map((repo) => repo.path));
  assert.equal(uniquePaths.size, repos.length, "repo list should not contain duplicates");
});
