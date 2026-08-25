import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  Client,
  type FileEntryWithStats,
  type SFTPWrapper,
  type Stats,
} from "ssh2";
import { z } from "zod";

export const SshConfigInput = z.object({
  enabled: z.boolean(),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65_535).default(22),
  username: z.string().trim().min(1).max(64),
  authType: z.enum(["password", "privateKey"]),
  password: z.string().max(1_024).optional(),
  privateKey: z.string().max(65_536).optional(),
  passphrase: z.string().max(1_024).optional(),
  rootPath: z.string().trim().startsWith("/").max(1_024),
  hostFingerprint: z.string().trim().max(256).optional(),
});

export type SshConfig = z.infer<typeof SshConfigInput>;
export type SshFileEntry = {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink";
  size: number;
  modifiedAt: string | null;
  permissions: string;
};
export type SftpSession = {
  client: Client;
  sftp: SFTPWrapper;
  fingerprint: string;
};
export type DockerContainerStats = {
  id: string;
  name: string;
  cpuPercent: number;
  memUsage: string;
  memPercent: number;
  netIO: string;
  blockIO: string;
};
export type DiskIoCounter = {
  device: string;
  readBytes: string;
  writeBytes: string;
};
export type LogSnapshot = {
  source:
    | "syslog"
    | "journalctl"
    | "dmesg"
    | "nginx-error"
    | "nginx-access"
    | "libvirt"
    | "php-fpm"
    | "docker";
  lines: string[];
};

export function completeSshConfig(
  input: SshConfig | undefined,
  current?: SshConfig,
): SshConfig | undefined {
  if (!input) return undefined;
  if (!input.enabled)
    return {
      ...input,
      password: undefined,
      privateKey: undefined,
      passphrase: undefined,
    };
  if (!input.hostFingerprint)
    throw new Error("Test the SSH connection before saving it");
  const canReuseSecrets =
    current !== undefined &&
    input.host === current.host &&
    input.port === current.port &&
    input.username === current.username &&
    input.authType === current.authType &&
    input.hostFingerprint === current.hostFingerprint;
  const password =
    input.password ?? (canReuseSecrets ? current.password : undefined);
  const privateKey =
    input.privateKey ?? (canReuseSecrets ? current.privateKey : undefined);
  const passphrase =
    input.passphrase ?? (canReuseSecrets ? current.passphrase : undefined);
  if (input.authType === "password" && !password)
    throw new Error("An SSH password is required");
  if (input.authType === "privateKey" && !privateKey)
    throw new Error("An SSH private key is required");
  return {
    ...input,
    password: input.authType === "password" ? password : undefined,
    privateKey: input.authType === "privateKey" ? privateKey : undefined,
    passphrase: input.authType === "privateKey" ? passphrase : undefined,
  };
}

function fingerprint(key: Buffer) {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

function virtualPath(value: string | undefined) {
  if (!value || value === "/") return "/";
  if (value.includes("\0")) throw new Error("Invalid file path");
  const normalized = posix.normalize(`/${value.replaceAll("\\", "/")}`);
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}

function absolutePath(config: SshConfig, value: string | undefined) {
  const root = posix.normalize(config.rootPath);
  const virtual = virtualPath(value);
  return virtual === "/" ? root : posix.join(root, virtual.slice(1));
}

function permissions(mode: number) {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

export function normalizeSshConnectionError(error: Error) {
  const level = (error as Error & { level?: string }).level;
  if (
    level === "client-authentication" ||
    /all configured authentication methods failed/i.test(error.message)
  ) {
    return new Error(
      "SSH authentication failed. Verify the username and password, then confirm SSH access is enabled in Unraid.",
      { cause: error },
    );
  }
  return error;
}
export async function discoverSshFingerprint(config: SshConfig) {
  if (!config.enabled) throw new Error("SSH file access is not configured");
  const client = new Client();
  const deferred = Promise.withResolvers<{ fingerprint: string }>();
  let observedFingerprint = "";
  let settled = false;
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    client.end();
    if (observedFingerprint) {
      deferred.resolve({ fingerprint: observedFingerprint });
      return;
    }
    deferred.reject(error ?? new Error("Unable to read the SSH host key"));
  };
  client.on("error", finish);
  client.once("close", () => finish());
  client.connect({
    host: config.host,
    port: config.port,
    username: config.username,
    readyTimeout: 12_000,
    hostVerifier: (key: Buffer) => {
      observedFingerprint = fingerprint(key);
      queueMicrotask(() => finish());
      return false;
    },
  });
  return deferred.promise;
}

const SFTP_OPEN_TIMEOUT_MS = 12_000;

export async function openSftp(config: SshConfig): Promise<SftpSession> {
  if (!config.enabled) throw new Error("SSH file access is not configured");
  let observedFingerprint = "";
  const client = new Client();
  const deferred = Promise.withResolvers<SftpSession>();
  let settled = false;
  let openingTimer: NodeJS.Timeout | undefined;
  const clearOpeningTimer = () => {
    clearTimeout(openingTimer);
    openingTimer = undefined;
  };
  const failOpening = (error: Error) => {
    if (settled) return;
    settled = true;
    clearOpeningTimer();
    client.end();
    deferred.reject(normalizeSshConnectionError(error));
  };
  const failClosedOpening = () =>
    failOpening(
      new Error("SSH connection closed before the SFTP subsystem opened"),
    );
  // EventEmitter errors remain handled for the lifetime of the connection. Once
  // opening has settled, later transport errors are surfaced by active SFTP
  // operations instead of becoming an uncaught process-level exception.
  client.on("error", failOpening);
  client.once("close", failClosedOpening);
  client.once("end", failClosedOpening);
  client.once("ready", () => {
    if (settled) return;
    openingTimer = setTimeout(
      () => failOpening(new Error("Timed out opening the SFTP subsystem")),
      SFTP_OPEN_TIMEOUT_MS,
    );
    try {
      client.sftp((error, sftp) => {
        if (settled) return;
        if (error) {
          failOpening(error);
          return;
        }
        settled = true;
        clearOpeningTimer();
        sftp.on("error", () => {});
        deferred.resolve({ client, sftp, fingerprint: observedFingerprint });
      });
    } catch (error) {
      failOpening(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const password = config.authType === "password" ? config.password : undefined;
  if (password) {
    client.on(
      "keyboard-interactive",
      (_name, _instructions, _language, prompts, finish) => {
        finish(prompts.map(() => password));
      },
    );
  }
  client.connect({
    host: config.host,
    port: config.port,
    username: config.username,
    password,
    tryKeyboard: Boolean(password),
    privateKey:
      config.authType === "privateKey" ? config.privateKey : undefined,
    passphrase:
      config.authType === "privateKey" ? config.passphrase : undefined,
    readyTimeout: 12_000,
    keepaliveInterval: 5_000,
    keepaliveCountMax: 2,
    hostVerifier: (key: Buffer) => {
      observedFingerprint = fingerprint(key);
      return observedFingerprint === config.hostFingerprint;
    },
  });
  return deferred.promise;
}

async function withSftp<T>(
  config: SshConfig,
  operation: (sftp: SFTPWrapper) => Promise<T>,
) {
  const session = await openSftp(config);
  try {
    return await operation(session.sftp);
  } finally {
    session.client.end();
  }
}
function execText(client: Client, command: string) {
  const deferred = Promise.withResolvers<string>();
  client.exec(command, (error, stream) => {
    if (error) {
      deferred.reject(error);
      return;
    }
    let stdout = "";
    let stderr = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      stdout += chunk;
    });
    stream.stderr.setEncoding("utf8");
    stream.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    stream.once("close", (code: number) => {
      if (code === 0) deferred.resolve(stdout);
      else
        deferred.reject(
          new Error(stderr.trim() || `SSH command exited with code ${code}`),
        );
    });
    stream.once("error", deferred.reject);
  });
  return deferred.promise;
}

function dockerPercentage(value: unknown) {
  const parsed = Number(String(value ?? "").replace("%", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function readDockerStats(
  config: SshConfig,
): Promise<DockerContainerStats[]> {
  const session = await openSftp(config);
  try {
    const output = await execText(
      session.client,
      "docker stats --no-stream --format '{{json .}}'",
    );
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const value = JSON.parse(line) as Record<string, unknown>;
        return {
          id: String(value.ID ?? ""),
          name: String(value.Name ?? ""),
          cpuPercent: dockerPercentage(value.CPUPerc),
          memUsage: String(value.MemUsage ?? ""),
          memPercent: dockerPercentage(value.MemPerc),
          netIO: String(value.NetIO ?? ""),
          blockIO: String(value.BlockIO ?? ""),
        };
      })
      .filter((stats) => stats.id && stats.name);
  } finally {
    session.client.end();
  }
}
export async function readDiskIoCounters(
  config: SshConfig,
): Promise<DiskIoCounter[]> {
  const session = await openSftp(config);
  try {
    const output = await execText(session.client, "cat /proc/diskstats");
    return output
      .split("\n")
      .map((line): DiskIoCounter | null => {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 10) return null;
        const device = fields[2];
        const readSectors = fields[5];
        const writeSectors = fields[9];
        if (!device || !readSectors || !writeSectors) return null;
        try {
          return {
            device,
            readBytes: (BigInt(readSectors) * 512n).toString(),
            writeBytes: (BigInt(writeSectors) * 512n).toString(),
          };
        } catch {
          return null;
        }
      })
      .filter((counter): counter is DiskIoCounter => counter !== null);
  } finally {
    session.client.end();
  }
}

const MAX_LOG_OUTPUT_BYTES = 1_048_576;
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function cleanLogLines(output: string) {
  const cleaned = output
    .replace(ANSI_ESCAPE, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  const bytes = Buffer.from(cleaned);
  const bounded = bytes
    .subarray(Math.max(0, bytes.length - MAX_LOG_OUTPUT_BYTES))
    .toString("utf8")
    .replace(/^\uFFFD/, "")
    .replace(/\n+$/, "");
  return bounded ? bounded.split("\n") : [];
}

export const SERVER_LOG_SOURCE_IDS = [
  "system",
  "kernel",
  "journal",
  "nginx-error",
  "nginx-access",
  "libvirt",
  "php-fpm",
] as const;
export type ServerLogSource = (typeof SERVER_LOG_SOURCE_IDS)[number];
export type ServerLogSourceOption = {
  id: ServerLogSource;
  label: string;
};

const SERVER_LOG_SOURCE_LABELS: Record<ServerLogSource, string> = {
  system: "System",
  kernel: "Kernel",
  journal: "Journal",
  "nginx-error": "Nginx errors",
  "nginx-access": "Nginx access",
  libvirt: "Libvirt",
  "php-fpm": "PHP-FPM",
};

export async function listServerLogSources(
  config: SshConfig,
): Promise<ServerLogSourceOption[]> {
  const session = await openSftp(config);
  try {
    const output = await execText(
      session.client,
      `printf 'system\\n'; command -v dmesg >/dev/null 2>&1 && printf 'kernel\\n'; command -v journalctl >/dev/null 2>&1 && journalctl --no-pager -n 1 >/dev/null 2>&1 && printf 'journal\\n'; [ -r /var/log/nginx/error.log ] && printf 'nginx-error\\n'; [ -r /var/log/nginx/access.log ] && printf 'nginx-access\\n'; [ -r /var/log/libvirt/libvirtd.log ] && printf 'libvirt\\n'; [ -r /var/log/php-fpm.log ] && printf 'php-fpm\\n'; true`,
    );
    const available = new Set(output.trim().split(/\s+/));
    return SERVER_LOG_SOURCE_IDS.filter((id) => available.has(id)).map(
      (id) => ({ id, label: SERVER_LOG_SOURCE_LABELS[id] }),
    );
  } finally {
    session.client.end();
  }
}

export async function readServerLogs(
  config: SshConfig,
  lines: number,
  requestedSource: ServerLogSource = "system",
): Promise<LogSnapshot> {
  const session = await openSftp(config);
  try {
    if (requestedSource === "system") {
      const output = await execText(
        session.client,
        `if [ -r /var/log/syslog ]; then printf '__SOURCE__:syslog\\n'; tail -n ${lines} /var/log/syslog; elif command -v journalctl >/dev/null 2>&1; then printf '__SOURCE__:journalctl\\n'; journalctl --no-pager -n ${lines} -o short-iso; else printf '__SOURCE__:dmesg\\n'; dmesg | tail -n ${lines}; fi`,
      );
      const cleanedLines = cleanLogLines(output);
      const [marker, ...logLines] = cleanedLines;
      const source = marker?.startsWith("__SOURCE__:")
        ? marker.slice("__SOURCE__:".length)
        : "syslog";
      return {
        source:
          source === "journalctl" || source === "dmesg" ? source : "syslog",
        lines: marker?.startsWith("__SOURCE__:") ? logLines : cleanedLines,
      };
    }

    const commands: Record<
      Exclude<ServerLogSource, "system">,
      { command: string; source: LogSnapshot["source"] }
    > = {
      kernel: { command: `dmesg | tail -n ${lines}`, source: "dmesg" },
      journal: {
        command: `journalctl --no-pager -n ${lines} -o short-iso`,
        source: "journalctl",
      },
      "nginx-error": {
        command: `tail -n ${lines} /var/log/nginx/error.log`,
        source: "nginx-error",
      },
      "nginx-access": {
        command: `tail -n ${lines} /var/log/nginx/access.log`,
        source: "nginx-access",
      },
      libvirt: {
        command: `tail -n ${lines} /var/log/libvirt/libvirtd.log`,
        source: "libvirt",
      },
      "php-fpm": {
        command: `tail -n ${lines} /var/log/php-fpm.log`,
        source: "php-fpm",
      },
    };
    const selected = commands[requestedSource];
    return {
      source: selected.source,
      lines: cleanLogLines(await execText(session.client, selected.command)),
    };
  } finally {
    session.client.end();
  }
}

export async function readDockerLogs(
  config: SshConfig,
  containerId: string,
  lines: number,
): Promise<LogSnapshot> {
  const session = await openSftp(config);
  try {
    const output = await execText(
      session.client,
      `docker logs --tail ${lines} --timestamps ${containerId} 2>&1`,
    );
    return { source: "docker", lines: cleanLogLines(output) };
  } finally {
    session.client.end();
  }
}
const VM_ICON_DIRECTORIES = [
  "/boot/config/plugins/dynamix.vm.manager/templates/images",
  "/usr/local/emhttp/plugins/dynamix.vm.manager/templates/images",
] as const;
const VM_ICON_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export function extractVmIconName(xml: string) {
  const match = /<vmtemplate\b[^>]*\bicon=(["'])([^"']+)\1/i.exec(xml);
  if (!match?.[2]) return null;
  const name = posix.basename(match[2]);
  return VM_ICON_TYPES[posix.extname(name).toLowerCase()] ? name : null;
}

function readRemoteFile(sftp: SFTPWrapper, path: string) {
  const deferred = Promise.withResolvers<Buffer>();
  sftp.readFile(path, (error, data) =>
    error ? deferred.reject(error) : deferred.resolve(data),
  );
  return deferred.promise;
}

export async function readVmIcon(config: SshConfig, vmId: string) {
  const session = await openSftp(config);
  try {
    const xml = await execText(session.client, `virsh dumpxml ${vmId}`);
    const name = extractVmIconName(xml);
    if (!name) return null;
    const contentType = VM_ICON_TYPES[posix.extname(name).toLowerCase()];
    if (!contentType) return null;
    for (const directory of VM_ICON_DIRECTORIES) {
      try {
        const path = posix.join(directory, name);
        const attributes = await stat(session.sftp, path);
        if (attributes.size > 2 * 1_024 * 1_024)
          throw new Error("VM icon exceeds 2 MiB");
        return {
          content: await readRemoteFile(session.sftp, path),
          contentType,
        };
      } catch (error) {
        if (error instanceof Error && error.message === "VM icon exceeds 2 MiB")
          throw error;
      }
    }
    return null;
  } finally {
    session.client.end();
  }
}

function readDirectory(sftp: SFTPWrapper, path: string) {
  const deferred = Promise.withResolvers<FileEntryWithStats[]>();
  sftp.readdir(path, (error, entries) =>
    error ? deferred.reject(error) : deferred.resolve(entries),
  );
  return deferred.promise;
}

function stat(sftp: SFTPWrapper, path: string) {
  const deferred = Promise.withResolvers<Stats>();
  sftp.lstat(path, (error, attributes) =>
    error ? deferred.reject(error) : deferred.resolve(attributes),
  );
  return deferred.promise;
}
function realpath(sftp: SFTPWrapper, path: string) {
  const deferred = Promise.withResolvers<string>();
  sftp.realpath(path, (error, resolvedPath) =>
    error ? deferred.reject(error) : deferred.resolve(resolvedPath),
  );
  return deferred.promise;
}

function assertInsideRoot(root: string, candidate: string) {
  const relative = posix.relative(root, candidate);
  if (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith("../") &&
      !posix.isAbsolute(relative))
  )
    return;
  throw new Error("The requested path is outside the configured SSH root");
}

async function confinedExistingPath(
  sftp: SFTPWrapper,
  config: SshConfig,
  path: string,
) {
  const root = await realpath(sftp, absolutePath(config, "/"));
  const candidate = await realpath(sftp, absolutePath(config, path));
  assertInsideRoot(root, candidate);
  return candidate;
}

type ConfinedLeaf = {
  path: string;
  rootLookupPath: string;
  resolvedRoot: string;
  parentLookupPath: string;
  resolvedParent: string;
};

async function confinedLeaf(
  sftp: SFTPWrapper,
  config: SshConfig,
  path: string,
): Promise<ConfinedLeaf> {
  const candidate = absolutePath(config, path);
  const rootLookupPath = absolutePath(config, "/");
  const parentLookupPath = posix.dirname(candidate);
  const resolvedRoot = await realpath(sftp, rootLookupPath);
  const resolvedParent = await realpath(sftp, parentLookupPath);
  assertInsideRoot(resolvedRoot, resolvedParent);
  return {
    path: posix.join(resolvedParent, posix.basename(candidate)),
    rootLookupPath,
    resolvedRoot,
    parentLookupPath,
    resolvedParent,
  };
}

async function assertConfinementUnchanged(
  sftp: SFTPWrapper,
  confinement: ConfinedLeaf,
) {
  const currentRoot = await realpath(sftp, confinement.rootLookupPath);
  const currentParent = await realpath(sftp, confinement.parentLookupPath);
  if (
    currentRoot !== confinement.resolvedRoot ||
    currentParent !== confinement.resolvedParent
  )
    throw new Error("The SSH root or destination folder changed during upload");
  assertInsideRoot(currentRoot, currentParent);
}

function mkdir(sftp: SFTPWrapper, path: string) {
  const deferred = Promise.withResolvers<void>();
  sftp.mkdir(path, { mode: 0o755 }, (error) =>
    error ? deferred.reject(error) : deferred.resolve(),
  );
  return deferred.promise;
}

function rename(sftp: SFTPWrapper, from: string, to: string) {
  const deferred = Promise.withResolvers<void>();
  sftp.rename(from, to, (error) =>
    error ? deferred.reject(error) : deferred.resolve(),
  );
  return deferred.promise;
}

function unlink(sftp: SFTPWrapper, path: string) {
  const deferred = Promise.withResolvers<void>();
  sftp.unlink(path, (error) =>
    error ? deferred.reject(error) : deferred.resolve(),
  );
  return deferred.promise;
}

async function installUploadedFile(
  sftp: SFTPWrapper,
  from: string,
  to: string,
  confinement: ConfinedLeaf,
) {
  await assertConfinementUnchanged(sftp, confinement);
  try {
    const extensionRename = Promise.withResolvers<void>();
    sftp.ext_openssh_rename(from, to, (error) =>
      error ? extensionRename.reject(error) : extensionRename.resolve(),
    );
    await extensionRename.promise;
    return;
  } catch {
    // Servers without posix-rename support require the SFTP v3 path below.
  }

  let initialRenameError: unknown;
  try {
    await assertConfinementUnchanged(sftp, confinement);
    await rename(sftp, from, to);
    return;
  } catch (error) {
    initialRenameError = error;
  }

  const backupPath = posix.join(
    posix.dirname(to),
    `.${posix.basename(to)}.backup-${randomBytes(16).toString("hex")}`,
  );
  try {
    await assertConfinementUnchanged(sftp, confinement);
    await rename(sftp, to, backupPath);
  } catch (backupError) {
    throw new AggregateError(
      [initialRenameError, backupError],
      "The uploaded file could not replace its destination",
    );
  }

  try {
    await assertConfinementUnchanged(sftp, confinement);
    await rename(sftp, from, to);
  } catch (replacementError) {
    try {
      await rename(sftp, backupPath, to);
    } catch (rollbackError) {
      throw new AggregateError(
        [replacementError, rollbackError],
        "The upload replacement failed and its destination could not be restored",
      );
    }
    throw replacementError;
  }

  try {
    await unlink(sftp, backupPath);
  } catch (cleanupError) {
    try {
      await rename(sftp, to, from);
      await rename(sftp, backupPath, to);
    } catch (rollbackError) {
      throw new AggregateError(
        [cleanupError, rollbackError],
        "The upload backup could not be removed or restored",
      );
    }
    throw cleanupError;
  }
}

function rmdir(sftp: SFTPWrapper, path: string) {
  const deferred = Promise.withResolvers<void>();
  sftp.rmdir(path, (error) =>
    error ? deferred.reject(error) : deferred.resolve(),
  );
  return deferred.promise;
}

async function removeRecursively(sftp: SFTPWrapper, path: string) {
  const attributes = await stat(sftp, path);
  if (attributes.isDirectory() && !attributes.isSymbolicLink()) {
    const entries = await readDirectory(sftp, path);
    for (const entry of entries) {
      if (entry.filename === "." || entry.filename === "..") continue;
      await removeRecursively(sftp, posix.join(path, entry.filename));
    }
    await rmdir(sftp, path);
    return;
  }
  await unlink(sftp, path);
}

export async function testSsh(config: SshConfig) {
  if (!config.hostFingerprint)
    throw new Error("Discover and confirm the SSH host fingerprint first");
  const session = await openSftp(config);
  try {
    await readDirectory(
      session.sftp,
      await confinedExistingPath(session.sftp, config, "/"),
    );
    return { fingerprint: session.fingerprint };
  } finally {
    session.client.end();
  }
}

export async function listFiles(
  config: SshConfig,
  path: string | undefined,
  page: number,
  pageSize: number,
) {
  const currentPath = virtualPath(path);
  return withSftp(config, async (sftp) => {
    const directory = await confinedExistingPath(sftp, config, currentPath);
    const entries = await readDirectory(sftp, directory);
    const files: SshFileEntry[] = entries
      .filter((entry) => entry.filename !== "." && entry.filename !== "..")
      .map<SshFileEntry>((entry) => ({
        name: entry.filename,
        path:
          currentPath === "/"
            ? `/${entry.filename}`
            : `${currentPath}/${entry.filename}`,
        type: entry.attrs.isDirectory()
          ? "directory"
          : entry.attrs.isSymbolicLink()
            ? "symlink"
            : "file",
        size: entry.attrs.size,
        modifiedAt: entry.attrs.mtime
          ? new Date(entry.attrs.mtime * 1_000).toISOString()
          : null,
        permissions: permissions(entry.attrs.mode),
      }))
      .sort((left, right) => {
        if (left.type === "directory" && right.type !== "directory") return -1;
        if (left.type !== "directory" && right.type === "directory") return 1;
        return left.name.localeCompare(right.name, undefined, {
          sensitivity: "base",
        });
      });
    const totalItems = files.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const currentPage = Math.min(page, totalPages);
    const firstItem = (currentPage - 1) * pageSize;
    return {
      path: currentPath,
      rootPath: config.rootPath,
      files: files.slice(firstItem, firstItem + pageSize),
      page: currentPage,
      pageSize,
      totalItems,
      totalPages,
    };
  });
}

export async function createFolder(config: SshConfig, path: string) {
  if (virtualPath(path) === "/") throw new Error("A folder name is required");
  return withSftp(config, async (sftp) =>
    mkdir(sftp, (await confinedLeaf(sftp, config, path)).path),
  );
}

export async function renameFile(config: SshConfig, from: string, to: string) {
  if (virtualPath(from) === "/" || virtualPath(to) === "/")
    throw new Error("The SSH root cannot be renamed");
  return withSftp(config, async (sftp) =>
    rename(
      sftp,
      (await confinedLeaf(sftp, config, from)).path,
      (await confinedLeaf(sftp, config, to)).path,
    ),
  );
}

export async function deleteFile(config: SshConfig, path: string) {
  if (virtualPath(path) === "/")
    throw new Error("The SSH root cannot be deleted");
  return withSftp(config, async (sftp) =>
    removeRecursively(sftp, (await confinedLeaf(sftp, config, path)).path),
  );
}

export async function uploadFile(
  config: SshConfig,
  path: string,
  source: Readable,
) {
  if (virtualPath(path) === "/") throw new Error("A file name is required");
  const session = await openSftp(config);
  let temporaryPath: string | undefined;
  try {
    const confinement = await confinedLeaf(session.sftp, config, path);
    const destinationPath = confinement.path;
    temporaryPath = posix.join(
      posix.dirname(destinationPath),
      `.${posix.basename(destinationPath)}.upload-${randomBytes(16).toString("hex")}`,
    );
    const destination = session.sftp.createWriteStream(temporaryPath, {
      flags: "wx",
      mode: 0o644,
    });
    await pipeline(source, destination);
    await installUploadedFile(
      session.sftp,
      temporaryPath,
      destinationPath,
      confinement,
    );
    temporaryPath = undefined;
  } catch (error) {
    if (temporaryPath) {
      try {
        await unlink(session.sftp, temporaryPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "The upload failed and its temporary file could not be removed",
        );
      }
    }
    throw error;
  } finally {
    session.client.end();
  }
}

export async function downloadFile(config: SshConfig, path: string) {
  const virtual = virtualPath(path);
  if (virtual === "/") throw new Error("A file is required");
  const session = await openSftp(config);
  try {
    const resolvedPath = await confinedExistingPath(
      session.sftp,
      config,
      virtual,
    );
    const attributes = await stat(session.sftp, resolvedPath);
    if (attributes.isDirectory())
      throw new Error("Folders cannot be downloaded directly");
    return {
      ...session,
      size: attributes.size,
      name: posix.basename(virtual),
      stream: session.sftp.createReadStream(resolvedPath),
    };
  } catch (error) {
    session.client.end();
    throw error;
  }
}
