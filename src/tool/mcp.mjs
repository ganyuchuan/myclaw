import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MCP_CONFIG_FILE = "config/mcporter.json";

function ensureObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function normalizeServerConfig(input) {
  const server = ensureObject(input, "mcp server config");
  const normalized = { ...server };

  if (!normalized.type) {
    if (typeof normalized.command === "string" && normalized.command.trim()) {
      normalized.type = "local";
    } else if (
      (typeof normalized.url === "string" && normalized.url.trim()) ||
      (typeof normalized.baseUrl === "string" && normalized.baseUrl.trim())
    ) {
      normalized.type = "http";
    }
  }

  if (!normalized.url && typeof normalized.baseUrl === "string" && normalized.baseUrl.trim()) {
    normalized.url = normalized.baseUrl;
  }

  delete normalized.baseUrl;
  return normalized;
}

function normalizeServersMap(input) {
  const source = ensureObject(input, "mcpServers");
  const normalized = {};

  for (const [name, value] of Object.entries(source)) {
    const key = String(name ?? "").trim();
    if (!key) {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    normalized[key] = normalizeServerConfig(value);
  }

  return normalized;
}

function parseConfigInput(configInput) {
  const parsed = typeof configInput === "string" ? JSON.parse(configInput) : configInput;
  const root = ensureObject(parsed, "json_config");

  if (root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)) {
    return normalizeServersMap(root.mcpServers);
  }

  const name = String(root.name ?? "").trim();
  if (name) {
    if (root.config && typeof root.config === "object" && !Array.isArray(root.config)) {
      return { [name]: normalizeServerConfig(root.config) };
    }

    const { name: _name, ...serverConfig } = root;
    return { [name]: normalizeServerConfig(serverConfig) };
  }

  const allValuesAreObjects = Object.values(root).every(
    (item) => item && typeof item === "object" && !Array.isArray(item),
  );
  if (allValuesAreObjects) {
    return normalizeServersMap(root);
  }

  throw new Error(
    "json_config must be one of: {\"mcpServers\": {...}}, {\"name\": \"server\", ...}, or {\"serverName\": {...}}",
  );
}

function resolveMcpConfigPath({ workDir, mcpConfigFile }) {
  const baseDir = path.resolve(workDir || process.cwd());
  const target = mcpConfigFile || DEFAULT_MCP_CONFIG_FILE;
  return path.resolve(baseDir, target);
}

async function readConfigJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return ensureObject(parsed, "mcporter config");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {};
    }
    throw new Error(`failed to read MCP config: ${String(error?.message ?? error)}`);
  }
}

async function writeConfigJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function loadMcpServersForCopilot({ workDir, mcpConfigFile }) {
  const filePath = resolveMcpConfigPath({ workDir, mcpConfigFile });
  const root = await readConfigJson(filePath);
  const servers = normalizeServersMap(root.mcpServers || {});
  return {
    filePath,
    mcpServers: servers,
  };
}

export async function listMcpServers({ workDir, mcpConfigFile }) {
  const { filePath, mcpServers } = await loadMcpServersForCopilot({ workDir, mcpConfigFile });
  return {
    filePath,
    mcpServers,
    names: Object.keys(mcpServers),
    count: Object.keys(mcpServers).length,
  };
}

export async function upsertMcpServers({ configInput, workDir, mcpConfigFile }) {
  const nextServers = parseConfigInput(configInput);
  const filePath = resolveMcpConfigPath({ workDir, mcpConfigFile });
  const root = await readConfigJson(filePath);
  const currentServers = normalizeServersMap(root.mcpServers || {});

  const changedNames = [];
  for (const [name, server] of Object.entries(nextServers)) {
    const previous = currentServers[name];
    const nextRaw = JSON.stringify(server);
    const prevRaw = previous ? JSON.stringify(previous) : "";
    if (nextRaw !== prevRaw) {
      changedNames.push(name);
    }
    currentServers[name] = server;
  }

  const merged = {
    ...root,
    mcpServers: currentServers,
  };

  await writeConfigJson(filePath, merged);

  return {
    filePath,
    changed: changedNames.length > 0,
    changedNames,
    names: Object.keys(nextServers),
    mcpServers: currentServers,
    count: Object.keys(currentServers).length,
  };
}

export async function removeMcpServer({ name, workDir, mcpConfigFile }) {
  const targetName = String(name ?? "").trim();
  if (!targetName) {
    throw new Error("mcp_name is required");
  }

  const filePath = resolveMcpConfigPath({ workDir, mcpConfigFile });
  const root = await readConfigJson(filePath);
  const currentServers = normalizeServersMap(root.mcpServers || {});

  const existed = Object.prototype.hasOwnProperty.call(currentServers, targetName);
  if (existed) {
    delete currentServers[targetName];
    const merged = {
      ...root,
      mcpServers: currentServers,
    };
    await writeConfigJson(filePath, merged);
  }

  return {
    filePath,
    removed: existed,
    name: targetName,
    count: Object.keys(currentServers).length,
    mcpServers: currentServers,
  };
}
