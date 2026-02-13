import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BUNDLED_SKILLS,
  installBundledSkills,
  uninstallBundledSkills,
  installAntfarmSkill,
  uninstallAntfarmSkill,
} from "./skill-install.js";

const originalHome = process.env.HOME;

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

async function withTempHome(): Promise<string> {
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "antfarm-skill-test-"));
  process.env.HOME = tmpHome;
  return tmpHome;
}

describe("skill installer", () => {
  it("installs all bundled skills into ~/.openclaw/skills", async () => {
    const tmpHome = await withTempHome();

    const results = await installBundledSkills();
    assert.equal(results.length, BUNDLED_SKILLS.length);

    for (const skillName of BUNDLED_SKILLS) {
      const result = results.find((entry) => entry.name === skillName);
      assert.ok(result, `missing install result for ${skillName}`);
      assert.equal(result.installed, true);

      const installedPath = path.join(tmpHome, ".openclaw", "skills", skillName, "SKILL.md");
      const content = await fs.readFile(installedPath, "utf-8");
      assert.ok(content.length > 0, `${skillName}/SKILL.md should be populated`);
    }
  });

  it("uninstall removes mittens and antfarm-workflows skill directories", async () => {
    const tmpHome = await withTempHome();
    await installBundledSkills();

    await uninstallBundledSkills();

    for (const skillName of BUNDLED_SKILLS) {
      const installedDir = path.join(tmpHome, ".openclaw", "skills", skillName);
      await assert.rejects(fs.access(installedDir));
    }
  });

  it("legacy antfarm-only wrapper remains functional", async () => {
    const tmpHome = await withTempHome();

    const result = await installAntfarmSkill();
    assert.equal(result.installed, true);

    const antfarmDir = path.join(tmpHome, ".openclaw", "skills", "antfarm-workflows");
    await fs.access(path.join(antfarmDir, "SKILL.md"));

    await uninstallAntfarmSkill();
    await assert.rejects(fs.access(antfarmDir));
  });
});
