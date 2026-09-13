import { accessSync, constants, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

function isExecutable(filename: string): boolean {
  try {
    accessSync(filename, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findInPath(pathValue: string | undefined): string | undefined {
  if (!pathValue) return undefined;
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "codex");
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function findInEditorExtensions(root: string): string | undefined {
  let extensions: string[];
  try {
    extensions = readdirSync(root)
      .filter((name) => name.startsWith("openai.chatgpt-"))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch {
    return undefined;
  }

  for (const extension of extensions) {
    const binDirectory = join(root, extension, "bin");
    let platformDirectories: string[];
    try {
      platformDirectories = readdirSync(binDirectory);
    } catch {
      continue;
    }
    for (const platformDirectory of platformDirectories) {
      const candidate = join(binDirectory, platformDirectory, "codex");
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

export function resolveCodexExecutable(): string {
  const configured = process.env.CODEX_CLI_PATH;
  if (configured) {
    if (isExecutable(configured)) return configured;
    throw new Error(`CODEX_CLI_PATH is not executable: ${configured}`);
  }

  const pathMatch = findInPath(process.env.PATH);
  if (pathMatch) return pathMatch;

  const userHome = homedir();
  const directCandidates = [
    join(userHome, ".local", "bin", "codex"),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
  ];
  for (const candidate of directCandidates) {
    if (isExecutable(candidate)) return candidate;
  }

  const extensionRoots = [
    join(userHome, ".vscode", "extensions"),
    join(userHome, ".vscode-insiders", "extensions"),
    join(userHome, ".cursor", "extensions"),
    join(userHome, ".windsurf", "extensions"),
  ];
  for (const root of extensionRoots) {
    const candidate = findInEditorExtensions(root);
    if (candidate) return candidate;
  }

  throw new Error(
    "Codex CLI was not found. Install it or set CODEX_CLI_PATH to the executable path.",
  );
}
