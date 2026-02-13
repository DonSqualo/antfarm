import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

export const BUNDLED_SKILLS = ["antfarm-workflows", "mittens"] as const;

/**
 * Get the path to the antfarm skills directory (bundled with antfarm).
 */
function getAntfarmSkillsDir(): string {
  // Skills are in the antfarm package under skills/
  return path.join(import.meta.dirname, "..", "..", "skills");
}

/**
 * Get the user's OpenClaw skills directory.
 */
function getUserSkillsDir(): string {
  return path.join(os.homedir(), ".openclaw", "skills");
}

async function installBundledSkill(skillName: string): Promise<{ installed: boolean; path: string }> {
  const srcDir = path.join(getAntfarmSkillsDir(), skillName);
  const destDir = path.join(getUserSkillsDir(), skillName);

  // Ensure user skills directory exists
  await fs.mkdir(getUserSkillsDir(), { recursive: true });

  try {
    await fs.access(srcDir);
    await fs.mkdir(destDir, { recursive: true });

    const skillContent = await fs.readFile(path.join(srcDir, "SKILL.md"), "utf-8");
    await fs.writeFile(path.join(destDir, "SKILL.md"), skillContent, "utf-8");

    return { installed: true, path: destDir };
  } catch {
    return { installed: false, path: destDir };
  }
}

async function uninstallBundledSkill(skillName: string): Promise<void> {
  const destDir = path.join(getUserSkillsDir(), skillName);

  try {
    await fs.rm(destDir, { recursive: true, force: true });
  } catch {
    // Already gone
  }
}

/**
 * Install all bundled antfarm skills to the user's skills directory.
 */
export async function installBundledSkills(): Promise<Array<{ name: string; installed: boolean; path: string }>> {
  const results: Array<{ name: string; installed: boolean; path: string }> = [];
  for (const skillName of BUNDLED_SKILLS) {
    const result = await installBundledSkill(skillName);
    results.push({ name: skillName, ...result });
  }
  return results;
}

/**
 * Uninstall all bundled antfarm skills from the user's skills directory.
 */
export async function uninstallBundledSkills(): Promise<void> {
  for (const skillName of BUNDLED_SKILLS) {
    await uninstallBundledSkill(skillName);
  }
}

/**
 * Backward-compatible wrappers for older call sites/tests.
 */
export async function installAntfarmSkill(): Promise<{ installed: boolean; path: string }> {
  return installBundledSkill("antfarm-workflows");
}

export async function uninstallAntfarmSkill(): Promise<void> {
  await uninstallBundledSkill("antfarm-workflows");
}
