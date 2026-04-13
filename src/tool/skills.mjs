import fs from "node:fs/promises";
import path from "node:path";

function toPosixPath(value) {
  return String(value ?? "").replaceAll(path.sep, "/");
}

function resolveWorkDir(workDir) {
  return path.resolve(workDir || process.cwd());
}

function resolveSkillsFile({ workDir, skillsFile }) {
  const cwd = resolveWorkDir(workDir);
  const target = String(skillsFile ?? "").trim() || "data/copilot-skills.json";
  return path.isAbsolute(target) ? target : path.resolve(cwd, target);
}

function normalizePathInput(inputPath) {
  return String(inputPath ?? "")
    .replaceAll("\u200b", "")
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .trim();
}

function unique(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const value = String(item ?? "").trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

async function ensureDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readState(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { paths: [] };
    }
    const paths = Array.isArray(parsed.paths)
      ? unique(parsed.paths.map((item) => String(item ?? "").trim()))
      : [];
    return { paths };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { paths: [] };
    }
    throw error;
  }
}

async function writeState(filePath, state) {
  await ensureDir(filePath);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const content = `${JSON.stringify({ paths: unique(state.paths ?? []) }, null, 2)}\n`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, filePath);
}

async function toCanonicalDir(inputPath) {
  let stat;
  try {
    stat = await fs.stat(inputPath);
  } catch (error) {
    const reason = String(error?.code || error?.message || error);
    throw new Error(`skills path is not accessible: ${inputPath} (${reason})`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`skills path is not a directory: ${inputPath}`);
  }

  return fs.realpath(inputPath).catch(() => path.resolve(inputPath));
}

function buildDetail(item, workDir) {
  const cwd = resolveWorkDir(workDir);
  const relative = path.relative(cwd, item) || ".";
  return {
    path: item,
    relativePath: toPosixPath(relative),
    name: path.basename(item),
  };
}

export async function listSkills({ workDir = "", skillsFile = "" } = {}) {
  const filePath = resolveSkillsFile({ workDir, skillsFile });
  const state = await readState(filePath);

  const skills = [];
  for (const item of state.paths) {
    const exists = await fs.stat(item).then((s) => s.isDirectory()).catch(() => false);
    skills.push({
      ...buildDetail(item, workDir),
      exists,
    });
  }

  return {
    count: skills.length,
    skills,
    skillsFile: filePath,
  };
}

export async function addSkill({ skillPath = "", workDir = "", skillsFile = "" } = {}) {
  const inputPath = normalizePathInput(skillPath);
  if (!inputPath) {
    throw new Error("skillPath is required");
  }

  const cwd = resolveWorkDir(workDir);
  const requested = path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
  const canonical = await toCanonicalDir(requested);

  const filePath = resolveSkillsFile({ workDir: cwd, skillsFile });
  const state = await readState(filePath);
  if (state.paths.includes(canonical)) {
    return {
      changed: false,
      added: buildDetail(canonical, cwd),
      count: state.paths.length,
      skillsFile: filePath,
    };
  }

  state.paths.push(canonical);
  await writeState(filePath, state);

  return {
    changed: true,
    added: buildDetail(canonical, cwd),
    count: state.paths.length,
    skillsFile: filePath,
  };
}

export async function removeSkill({ skillPath = "", workDir = "", skillsFile = "" } = {}) {
  const inputPath = normalizePathInput(skillPath);
  if (!inputPath) {
    throw new Error("skillPath is required");
  }

  const cwd = resolveWorkDir(workDir);
  const requested = path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
  const resolvedRequested = await fs.realpath(requested).catch(() => path.resolve(requested));

  const filePath = resolveSkillsFile({ workDir: cwd, skillsFile });
  const state = await readState(filePath);

  const before = state.paths.length;
  state.paths = state.paths.filter((item) => item !== resolvedRequested && item !== path.resolve(requested));
  const removed = before !== state.paths.length;

  if (removed) {
    await writeState(filePath, state);
  }

  return {
    changed: removed,
    removedPath: resolvedRequested,
    count: state.paths.length,
    skillsFile: filePath,
  };
}

export async function getSkillDirectoriesForSession({ workDir = "", skillsFile = "" } = {}) {
  const filePath = resolveSkillsFile({ workDir, skillsFile });
  const state = await readState(filePath);

  const result = [];
  for (const item of state.paths) {
    const exists = await fs.stat(item).then((s) => s.isDirectory()).catch(() => false);
    if (exists) {
      result.push(item);
    }
  }

  return unique(result);
}