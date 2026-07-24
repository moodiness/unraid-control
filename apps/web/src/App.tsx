import {
  Activity,
  AlertTriangle,
  Archive,
  Bell,
  ArrowUpRight,
  Boxes,
  Check,
  ChevronRight,
  ChevronLeft,
  CircleGauge,
  CircuitBoard,
  CloudOff,
  Cpu,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Globe2,
  Languages,
  LogIn,
  LogOut,
  KeyRound,
  House,
  MemoryStick,
  Monitor,
  Moon,
  Network,
  Router,
  Pause,
  Pencil,
  Play,
  Power,
  RefreshCw,
  RotateCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  Sun,
  Thermometer,
  Terminal,
  Trash2,
  Usb,
  Upload,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { api, AUTH_REQUIRED_EVENT, type AuthStatus } from "./api";
import packageInfo from "../package.json";
import { Localized, useI18n, type Language } from "./i18n";
import type {
  ArrayInfo,
  Container as DockerContainer,
  Dashboard,
  Disk,
  FileEntry,
  LogSnapshot,
  ServerLogSource,
  ServerLogSourceOption,
  PendingAction,
  ServerConfig,
  ServerSummary,
  Share,
  SshSettingsInput,
  View,
  Vm,
} from "./types";

const VIEW_META: Record<
  View,
  { label: string; eyebrow: string; icon: LucideIcon }
> = {
  dashboard: { label: "Home", eyebrow: "Overview", icon: CircleGauge },
  storage: { label: "Storage", eyebrow: "Array & disks", icon: HardDrive },
  docker: { label: "Docker", eyebrow: "Containers", icon: Boxes },
  vms: { label: "Machines", eyebrow: "Virtualization", icon: Monitor },
  shares: { label: "Shares", eyebrow: "Data", icon: Folder },
  logs: { label: "Logs", eyebrow: "System journal", icon: Terminal },
};

const LANGUAGE_LABELS: Record<Language, string> = {
  en: "English",
  fr: "Français",
  es: "Español",
  de: "Deutsch",
  it: "Italiano",
  pt: "Português",
  "pt-BR": "Português (Brasil)",
  ja: "日本語",
  zh: "简体中文",
  ru: "Русский",
  ar: "العربية",
};
const LANGUAGE_CODES = Object.keys(LANGUAGE_LABELS) as Language[];
const VALID_VIEWS = Object.keys(VIEW_META) as View[];
const initialView = new URLSearchParams(window.location.search).get(
  "view",
) as View | null;

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};

function numeric(value: string | number | undefined) {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function formatBytes(
  value: string | number | undefined,
  source: "bytes" | "kib" = "bytes",
) {
  let amount = numeric(value) * (source === "kib" ? 1024 : 1);
  if (amount <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 100 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function formatRate(value: number | null | undefined) {
  return value === null || value === undefined
    ? "Measuring…"
    : `${formatBytes(value)}/s`;
}
function formatDiskRate(value: number | null | undefined) {
  if (value === 0) return "0 MB/s";
  return formatRate(value);
}

function percent(
  used: string | number | undefined,
  total: string | number | undefined,
) {
  const denominator = numeric(total);
  return denominator > 0
    ? Math.min(100, Math.max(0, (numeric(used) / denominator) * 100))
    : 0;
}

function effectiveStorageCapacity(array: ArrayInfo) {
  const arrayTotal = numeric(array.capacity.kilobytes.total);
  if (arrayTotal > 0) {
    return {
      used: numeric(array.capacity.kilobytes.used),
      free: numeric(array.capacity.kilobytes.free),
      total: arrayTotal,
      fromPools: false,
    };
  }

  const filesystems = new Set<string>();
  let used = 0;
  let free = 0;
  let total = 0;
  for (const disk of array.caches) {
    const fsTotal = numeric(disk.fsSize);
    if (fsTotal <= 0) continue;
    const fsUsed = numeric(disk.fsUsed);
    const fsFree = numeric(disk.fsFree);
    const filesystem = `${fsTotal}:${fsUsed}:${fsFree}`;
    if (filesystems.has(filesystem)) continue;
    filesystems.add(filesystem);
    total += fsTotal;
    used += fsUsed;
    free += fsFree || Math.max(0, fsTotal - fsUsed);
  }
  return { used, free, total, fromPools: total > 0 };
}

function uptime(bootTime: string | undefined, language: Language) {
  if (!bootTime) return "—";
  const elapsed = Date.now() - new Date(bootTime).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 0) return bootTime;
  const days = Math.floor(elapsed / 86_400_000);
  const hours = Math.floor((elapsed % 86_400_000) / 3_600_000);
  const dayText = new Intl.NumberFormat(language, {
    style: "unit",
    unit: "day",
    unitDisplay: "narrow",
  }).format(days);
  const hourText = new Intl.NumberFormat(language, {
    style: "unit",
    unit: "hour",
    unitDisplay: "narrow",
  }).format(hours);
  return `${dayText} ${hourText}`;
}

function statusTone(state?: string) {
  const value = state?.toUpperCase() ?? "";
  if (
    [
      "RUNNING",
      "STARTED",
      "ONLINE",
      "UP",
      "ACTIVE",
      "OK",
      "DISK_OK",
      "COMPLETED",
    ].includes(value)
  )
    return "success";
  if (["PAUSED", "WARNING", "IDLE", "OFFLINE"].includes(value))
    return "warning";
  return "neutral";
}

function GlassCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={`glass-card ${className}`}>{children}</section>;
}

function CardHeader({
  icon: Icon,
  title,
  detail,
  action,
}: {
  icon: LucideIcon;
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="card-header">
      <span className="card-icon">
        <Icon size={17} />
      </span>
      <div>
        <h2>{title}</h2>
        {detail && <p>{detail}</p>}
      </div>
      {action && <div className="card-action">{action}</div>}
    </div>
  );
}

function Status({ value, label }: { value?: string; label?: string }) {
  return (
    <span className={`status status-${statusTone(value)}`}>
      <i />
      {label ?? value?.toLowerCase() ?? "unknown"}
    </span>
  );
}

function Progress({
  value,
  tone = "accent",
}: {
  value: number;
  tone?: "accent" | "success" | "warning";
}) {
  const safe = Math.min(100, Math.max(0, value));
  return (
    <div className={`progress progress-${tone}`}>
      <span style={{ width: `${safe}%` }} />
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  detail,
  text,
  percentage,
  tone = "accent",
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  text?: string;
  percentage: number;
  tone?: "accent" | "violet" | "blue";
}) {
  const safe = Math.min(100, Math.max(0, percentage));
  return (
    <article className={`metric metric-${tone}`}>
      <div
        className="metric-ring"
        style={{ "--progress": `${safe * 3.6}deg` } as CSSProperties}
      >
        <span>
          <Icon size={21} />
        </span>
      </div>
      <div className="metric-copy">
        <small>{label}</small>
        <strong>{value}</strong>
        <p>{detail}</p>
        {text && <p className="metric-secondary">{text}</p>}
      </div>
    </article>
  );
}

function DetailStat({
  icon: Icon,
  label,
  value,
  detail,
  action,
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <article className="detail-stat">
      <span className="detail-stat-icon">
        <Icon size={16} />
      </span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        {detail && <p>{detail}</p>}
      </div>
      {action && <span className="detail-stat-action">{action}</span>}
    </article>
  );
}

function Empty({
  icon: Icon,
  title,
  text,
}: {
  icon: LucideIcon;
  title: string;
  text: string;
}) {
  return (
    <div className="empty">
      <span>
        <Icon size={22} />
      </span>
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}

function hostnameFromUrl(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}
function dockerObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function dockerValue(
  value: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const candidate = value[key];
    if (candidate !== undefined && candidate !== null && candidate !== "")
      return String(candidate);
  }
  return "";
}

function containerNetworks(container: DockerContainer) {
  const settings = dockerObject(container.networkSettings);
  const networks = dockerObject(settings.Networks ?? settings.networks);
  return Object.entries(networks).map(([name, rawNetwork]) => {
    const network = dockerObject(rawNetwork);
    return {
      name,
      ip: dockerValue(network, "IPAddress", "ipAddress", "GlobalIPv6Address"),
      mac: dockerValue(network, "MacAddress", "macAddress"),
    };
  });
}

function containerMounts(container: DockerContainer) {
  return (container.mounts ?? []).map((rawMount) => {
    const mount = dockerObject(rawMount);
    return {
      source: dockerValue(mount, "Source", "source", "Name", "name"),
      destination: dockerValue(mount, "Destination", "destination"),
      mode: dockerValue(mount, "Mode", "mode"),
    };
  });
}

function containerPortLabel(port: DockerContainer["ports"][number]) {
  const internal = `${port.privatePort}/${port.type.toLowerCase()}`;
  return port.publicPort
    ? `${port.ip || "0.0.0.0"}:${port.publicPort} → ${internal}`
    : internal;
}
function dockerIoPair(value: string | undefined) {
  const [read, write] = value?.split(/\s*\/\s*/, 2) ?? [];
  return {
    read: read?.trim() || "Unavailable",
    write: write?.trim() || "Unavailable",
  };
}

type DockerRuntimeStats = NonNullable<
  Dashboard["dockerStats"]["containers"]
>[number];

function ContainerDetails({
  container,
  stats,
}: {
  container: DockerContainer;
  stats?: DockerRuntimeStats;
}) {
  const networks = containerNetworks(container);
  const mounts = containerMounts(container);
  const ports = container.ports.length
    ? container.ports
    : (container.templatePorts ?? []);
  const blockIo = dockerIoPair(stats?.blockIO);
  return (
    <Localized>
      <>
        <div className="app-row-details">
          <div>
            <small>CPU load</small>
            <strong>
              {stats ? `${stats.cpuPercent.toFixed(2)} %` : "Unavailable"}
            </strong>
          </div>
          <div>
            <small>Memory load</small>
            <strong>{stats ? stats.memUsage : "Unavailable"}</strong>
            {stats && <span>{stats.memPercent.toFixed(2)} %</span>}
          </div>
          <div>
            <small>Disk read</small>
            <strong translate="no">{blockIo.read}</strong>
          </div>
          <div>
            <small>Disk write</small>
            <strong translate="no">{blockIo.write}</strong>
          </div>
          <div>
            <small>Uptime</small>
            <strong>{container.status || "Unavailable"}</strong>
          </div>
          <div>
            <small>Network mode</small>
            <strong translate="no">
              {container.hostConfig?.networkMode ||
                networks.map((network) => network.name).join(", ") ||
                "—"}
            </strong>
          </div>
          <div>
            <small>Container IP</small>
            <strong translate="no">
              {networks
                .map((network) => network.ip)
                .filter(Boolean)
                .join(", ") || "—"}
            </strong>
          </div>
          <div>
            <small>MAC address</small>
            <strong translate="no">
              {networks
                .map((network) => network.mac)
                .filter(Boolean)
                .join(", ") || "—"}
            </strong>
          </div>
        </div>
        {ports.length > 0 && (
          <div className="app-detail-group">
            <small>Container ports</small>
            <div>
              {ports.map((port, index) => (
                <code key={`${port.privatePort}-${index}`}>
                  {containerPortLabel(port)}
                </code>
              ))}
            </div>
          </div>
        )}
        {Boolean(container.lanIpPorts?.length) && (
          <div className="app-detail-group">
            <small>LAN access</small>
            <div>
              {container.lanIpPorts?.map((value) => (
                <code key={value}>{value}</code>
              ))}
            </div>
          </div>
        )}
        {mounts.length > 0 && (
          <div className="app-detail-group">
            <small>Volumes</small>
            <div>
              {mounts.map((mount, index) => (
                <code key={`${mount.destination}-${index}`}>
                  {mount.source || "—"} → {mount.destination || "—"}
                  {mount.mode ? ` · ${mount.mode}` : ""}
                </code>
              ))}
            </div>
          </div>
        )}
      </>
    </Localized>
  );
}

function Setup({
  onComplete,
  onCancel,
  server,
}: {
  onComplete: (config: ServerConfig) => void;
  onCancel?: () => void;
  server?: ServerSummary;
}) {
  const [name, setName] = useState(server?.name ?? "Tower");
  const [baseUrl, setBaseUrl] = useState(server?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [allowSelfSigned, setAllowSelfSigned] = useState(
    server?.allowSelfSigned ?? true,
  );
  const currentSsh = server?.ssh;
  const [sshEnabled, setSshEnabled] = useState(currentSsh?.enabled ?? false);
  const [sshHost, setSshHost] = useState(
    currentSsh?.host ?? hostnameFromUrl(server?.baseUrl ?? ""),
  );
  const [sshPort, setSshPort] = useState(String(currentSsh?.port ?? 22));
  const [sshUsername, setSshUsername] = useState(
    currentSsh?.username ?? "root",
  );
  const [sshAuthType, setSshAuthType] = useState<"password" | "privateKey">(
    currentSsh?.authType ?? "password",
  );
  const [sshPassword, setSshPassword] = useState("");
  const [sshPrivateKey, setSshPrivateKey] = useState("");
  const [sshPassphrase, setSshPassphrase] = useState("");
  const [sshRootPath, setSshRootPath] = useState(
    currentSsh?.rootPath ?? "/mnt/user",
  );
  const [sshFingerprint, setSshFingerprint] = useState(
    currentSsh?.hostFingerprint ?? "",
  );
  const [busy, setBusy] = useState<"test" | "ssh" | "save" | null>(null);
  const [message, setMessage] = useState<{
    text: string;
    error?: boolean;
  } | null>(null);
  const sshPayload: SshSettingsInput | undefined =
    sshEnabled || currentSsh
      ? {
          enabled: sshEnabled,
          host: sshHost,
          port: Number(sshPort),
          username: sshUsername,
          authType: sshAuthType,
          password: sshPassword || undefined,
          privateKey: sshPrivateKey || undefined,
          passphrase: sshPassphrase || undefined,
          rootPath: sshRootPath,
          hostFingerprint: sshFingerprint || undefined,
        }
      : undefined;
  const payload = {
    name,
    baseUrl,
    apiKey,
    allowSelfSigned,
    ssh: sshPayload,
  };

  const testSshConnection = async () => {
    if (!sshPayload) return;
    setBusy("ssh");
    setMessage(null);
    try {
      const result = await api.testSsh(sshPayload, server?.id);
      setSshFingerprint(result.fingerprint);
      setMessage({ text: "SSH connection verified." });
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : "SSH connection failed",
        error: true,
      });
    } finally {
      setBusy(null);
    }
  };

  const testConnection = async () => {
    setBusy("test");
    setMessage(null);
    try {
      const result = await api.test(payload);
      setMessage({
        text: result.hostname
          ? `Connected to ${result.hostname}.`
          : "Connection successful.",
      });
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : "Connection failed",
        error: true,
      });
    } finally {
      setBusy(null);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("save");
    setMessage(null);
    try {
      const nextConfig = server
        ? await api.update(server.id, {
            ...payload,
            apiKey: apiKey || undefined,
          })
        : await api.save(payload);
      onComplete(nextConfig);
    } catch (error) {
      setMessage({
        text: error instanceof Error ? error.message : "Setup failed",
        error: true,
      });
      setBusy(null);
    }
  };

  return (
    <Localized>
      <main className="setup-page">
        <div className="ambient ambient-a" />
        <div className="ambient ambient-b" />
        <section className="setup-shell">
          <div className="setup-intro">
            <img src="/icon.svg" className="setup-logo" alt="" />
            <span className="eyebrow">YOUR SERVER. EVERYWHERE.</span>
            <h1>
              Welcome to
              <br />
              <em>Unraid.</em>
            </h1>
            <p>
              A private, fast and installable interface that keeps your server,
              apps and machines within reach.
            </p>
            <div className="trust-row">
              <span>
                <ShieldCheck size={17} /> Encrypted key
              </span>
              <span>
                <Zap size={17} /> 100% local
              </span>
              <span>
                <Sparkles size={17} /> Native PWA
              </span>
            </div>
          </div>

          <form className="setup-card glass-card" onSubmit={save}>
            <div className="setup-card-top">
              <div>
                <small>{server ? "EDIT SERVER" : "UNRAID CONNECTION"}</small>
                <h2>
                  {server ? "Update server connection" : "Connect your server"}
                </h2>
              </div>
            </div>
            <label>
              <span>Server name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Tower"
                autoComplete="organization"
                required
              />
            </label>
            <label>
              <span>Unraid address</span>
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="http://192.168.1.10"
                inputMode="url"
                autoComplete="url"
                required
              />
              <small className="setup-field-hint">
                Use the same address as the Unraid WebGUI, for example
                http://192.168.1.10. Avoid localhost and .local names.
              </small>
            </label>
            <label>
              <span>API key</span>
              <input
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={
                  server
                    ? "Leave blank to keep the current key."
                    : "unraid_xxxxxxxxx"
                }
                type="password"
                autoComplete="off"
                required={!server}
                minLength={8}
              />
              {server && (
                <small className="setup-field-hint">
                  Leave blank to keep the current key.
                </small>
              )}
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={allowSelfSigned}
                onChange={(event) => setAllowSelfSigned(event.target.checked)}
              />
              <span>
                <strong>Allow a self-signed certificate</strong>
                <small>Recommended for a local HTTPS connection.</small>
              </span>
            </label>
            <section className={`ssh-setup ${sshEnabled ? "is-enabled" : ""}`}>
              <label className="check-row ssh-toggle">
                <input
                  type="checkbox"
                  checked={sshEnabled}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    setSshEnabled(enabled);
                    if (enabled && !sshHost)
                      setSshHost(hostnameFromUrl(baseUrl));
                  }}
                />
                <span>
                  <strong>
                    <Terminal size={16} /> Enable SSH file access (optional)
                  </strong>
                  <small>
                    Browse, upload and manage files through an encrypted SFTP
                    connection.
                  </small>
                </span>
              </label>
              {sshEnabled && (
                <div className="ssh-fields">
                  <div className="setup-field-grid ssh-address-grid">
                    <label>
                      <span>SSH host</span>
                      <input
                        value={sshHost}
                        onChange={(event) => {
                          setSshHost(event.target.value);
                          setSshFingerprint("");
                        }}
                        placeholder="192.168.1.10"
                        autoComplete="url"
                        required
                      />
                    </label>
                    <label>
                      <span>Port</span>
                      <input
                        value={sshPort}
                        onChange={(event) => setSshPort(event.target.value)}
                        type="number"
                        min="1"
                        max="65535"
                        inputMode="numeric"
                        required
                      />
                    </label>
                  </div>
                  <div className="setup-field-grid">
                    <label>
                      <span>Username</span>
                      <input
                        value={sshUsername}
                        onChange={(event) => setSshUsername(event.target.value)}
                        placeholder="root"
                        autoComplete="username"
                        required
                      />
                    </label>
                    <label>
                      <span>Authentication</span>
                      <select
                        value={sshAuthType}
                        onChange={(event) => {
                          setSshAuthType(
                            event.target.value as "password" | "privateKey",
                          );
                          setSshFingerprint("");
                        }}
                      >
                        <option value="password">Password</option>
                        <option value="privateKey">Private key</option>
                      </select>
                    </label>
                  </div>
                  {sshAuthType === "password" ? (
                    <label>
                      <span>Password</span>
                      <input
                        value={sshPassword}
                        onChange={(event) => {
                          setSshPassword(event.target.value);
                          setSshFingerprint("");
                        }}
                        type="password"
                        autoComplete="off"
                        placeholder={
                          currentSsh?.configured
                            ? "Leave blank to keep the current password."
                            : "SSH password"
                        }
                        required={!currentSsh?.configured}
                      />
                    </label>
                  ) : (
                    <>
                      <label>
                        <span>Private key</span>
                        <textarea
                          value={sshPrivateKey}
                          onChange={(event) => {
                            setSshPrivateKey(event.target.value);
                            setSshFingerprint("");
                          }}
                          rows={4}
                          autoComplete="off"
                          placeholder={
                            currentSsh?.configured
                              ? "Leave blank to keep the current key."
                              : "-----BEGIN OPENSSH PRIVATE KEY-----"
                          }
                          required={!currentSsh?.configured}
                        />
                      </label>
                      <label>
                        <span>Key passphrase (optional)</span>
                        <input
                          value={sshPassphrase}
                          onChange={(event) =>
                            setSshPassphrase(event.target.value)
                          }
                          type="password"
                          autoComplete="off"
                        />
                      </label>
                    </>
                  )}
                  <label>
                    <span>Start folder</span>
                    <input
                      value={sshRootPath}
                      onChange={(event) => setSshRootPath(event.target.value)}
                      placeholder="/mnt/user"
                      required
                    />
                    <small className="setup-field-hint">
                      Access is confined to this folder and its descendants.
                    </small>
                  </label>
                  <div className="ssh-test-row">
                    <button
                      className="button secondary"
                      type="button"
                      onClick={testSshConnection}
                      disabled={busy !== null || !sshHost || !sshUsername}
                    >
                      {busy === "ssh" ? (
                        <RefreshCw className="spin" size={17} />
                      ) : (
                        <KeyRound size={17} />
                      )}
                      Verify SSH
                    </button>
                    {sshFingerprint && (
                      <small className="ssh-fingerprint">
                        Host key {sshFingerprint}
                      </small>
                    )}
                  </div>
                </div>
              )}
            </section>
            {message && (
              <div
                className={`form-message ${message.error ? "is-error" : "is-success"}`}
              >
                {message.error ? (
                  <AlertTriangle size={16} />
                ) : (
                  <Check size={16} />
                )}
                {message.text}
              </div>
            )}
            <div className="setup-actions">
              {onCancel && (
                <button
                  className="button ghost"
                  type="button"
                  onClick={onCancel}
                >
                  Cancel
                </button>
              )}
              <button
                className="button secondary"
                type="button"
                onClick={testConnection}
                disabled={busy !== null || !baseUrl || !apiKey}
              >
                {busy === "test" ? (
                  <RefreshCw className="spin" size={17} />
                ) : (
                  <Network size={17} />
                )}
                Test
              </button>
              <button className="button primary" disabled={busy !== null}>
                {busy === "save" ? (
                  <RefreshCw className="spin" size={17} />
                ) : null}
                {server ? "Save changes" : "Connect"}
                <ChevronRight size={17} />
              </button>
            </div>
            <p className="privacy-note">
              <ShieldCheck size={14} /> Your API key is encrypted with
              AES-256-GCM and never leaves your installation.
            </p>
          </form>
        </section>
      </main>
    </Localized>
  );
}

type HeroTone = "server" | "docker" | "vms" | "shares" | "logs";

function HeroVisual({
  icon: Icon,
  tone,
}: {
  icon: LucideIcon;
  tone: HeroTone;
}) {
  return (
    <div className={`hero-visual is-${tone}`} aria-hidden>
      <div className="orbit orbit-one" />
      <div className="orbit orbit-two" />
      <div className="hero-visual-core">
        <Icon size={42} />
      </div>
      <i className="satellite s-one" />
      <i className="satellite s-two" />
    </div>
  );
}

function DashboardView({ data, online }: { data: Dashboard; online: boolean }) {
  const { language } = useI18n();
  const [publicIpVisible, setPublicIpVisible] = useState(false);
  const info = data.system.info;
  const metrics = data.system.metrics;
  const array = data.array.array;
  const storageDevices = array
    ? array.parities.length +
      array.disks.length +
      array.caches.length +
      (array.boot ? 1 : 0)
    : 0;
  const poolDevices = array?.caches.length ?? 0;
  const cpu = metrics?.cpu?.percentTotal ?? 0;
  const memory = metrics?.memory?.percentTotal ?? 0;
  const capacity = array
    ? effectiveStorageCapacity(array)
    : { used: 0, free: 0, total: 0, fromPools: false };
  const arrayPercent = percent(capacity.used, capacity.total);
  const hardware = data.hardware.info;
  const temperatureSensors = data.telemetry.metrics?.temperature?.sensors ?? [];
  const cpuPackageTemperatures = (hardware?.cpu?.packages?.temp ?? []).filter(
    (value): value is number => Number.isFinite(value),
  );
  const apiCpuTemperatures = temperatureSensors
    .filter((sensor) => sensor.type.startsWith("CPU"))
    .map((sensor) => sensor.current.value)
    .filter((value): value is number => Number.isFinite(value));
  const cpuTemperatures = apiCpuTemperatures.length
    ? apiCpuTemperatures
    : cpuPackageTemperatures;
  const cpuTemperature = cpuTemperatures.length
    ? Math.max(...cpuTemperatures)
    : undefined;
  const temperatureDisks = array
    ? [array.boot, ...array.parities, ...array.disks, ...array.caches].filter(
        (disk): disk is Disk =>
          disk !== undefined &&
          Number.isFinite(disk.temp) &&
          numeric(disk.temp) > 0,
      )
    : [];
  const accessUrls = data.network.network?.accessUrls ?? [];
  const localAccess =
    accessUrls.find((url) => url.type === "LAN") ??
    accessUrls.find((url) => url.type === "DEFAULT");
  const primaryNetwork = data.networkInfo.info?.primaryNetwork;
  const localAddress =
    primaryNetwork?.ipAddress ||
    primaryNetwork?.ipv4Addresses?.[0]?.address ||
    hostnameFromUrl(localAccess?.ipv4 ?? "") ||
    hostnameFromUrl(data.server.baseUrl) ||
    "Unavailable";
  const publicAddress = data.publicIp.address ?? "Unavailable";
  const networkMetrics = data.telemetry.metrics?.network ?? [];
  const metricsByName = new Map(
    networkMetrics.map((item) => [item.name, item]),
  );
  const shouldDisplayInterface = (name: string) =>
    !/^(?:lo$|veth|docker\d*$|br-[a-f0-9]{6,}$)/i.test(name);
  const officialInterfaces = (
    data.networkInfo.info?.networkInterfaces ?? []
  ).filter((item) => shouldDisplayInterface(item.name));
  const officialByName = new Map(
    officialInterfaces.map((item) => [item.name, item]),
  );
  const legacyInterfaces = (hardware?.devices?.network ?? []).filter((item) =>
    shouldDisplayInterface(item.iface),
  );
  const legacyByName = new Map(
    legacyInterfaces.map((item) => [item.iface, item]),
  );
  const interfaceNames = [
    ...new Set([
      ...officialInterfaces.map((item) => item.name),
      ...legacyInterfaces.map((item) => item.iface),
      ...networkMetrics.map((item) => item.name).filter(shouldDisplayInterface),
    ]),
  ];
  const memoryLayout = hardware?.memory?.layout ?? [];
  const memoryTypes = [
    ...new Set(memoryLayout.map((module) => module.type).filter(Boolean)),
  ].join(" · ");
  const unraidVersion =
    hardware?.versions?.core?.unraid ??
    info?.versions?.core?.unraid ??
    info?.os.release ??
    "Unavailable";
  const license =
    data.registration.registration?.type ??
    data.registration.registration?.state ??
    "Unavailable";

  return (
    <Localized>
      <div className="dashboard-grid view-enter">
        <section className="hero-card glass-card">
          <div className="hero-copy">
            <div className={`live-pill ${online ? "" : "is-offline"}`}>
              <i /> {online ? "SYSTEM OPERATIONAL" : "SYSTEM OFFLINE"}
            </div>
            <h1>
              Hello. <span>{info?.os.hostname ?? data.server.name}</span>
              <br />
              {online ? "is running beautifully." : "is currently unreachable."}
            </h1>
            <p>
              {online ? (
                <>
                  {info?.cpu.brand ?? "Unraid server"} · up for{" "}
                  {uptime(info?.os.uptime, language)}
                </>
              ) : (
                "Showing the last data received from this server."
              )}
            </p>
          </div>
          <HeroVisual icon={Server} tone="server" />
        </section>

        <section className="metrics-row">
          <Metric
            icon={Cpu}
            label="PROCESSOR"
            value={`${Math.round(cpu)} %`}
            detail={`${info?.cpu.cores ?? "—"} cores · ${cpuTemperature === undefined ? `${info?.cpu.speed?.toFixed(2) ?? "—"} GHz` : `${Math.round(cpuTemperature)} °C`}`}
            percentage={cpu}
          />
          <Metric
            icon={MemoryStick}
            label="MEMORY"
            value={`${Math.round(memory)} %`}
            detail={`${formatBytes(metrics?.memory?.used)} / ${formatBytes(metrics?.memory?.total)}`}
            percentage={memory}
            tone="violet"
          />
          <Metric
            icon={HardDrive}
            label="STORAGE"
            value={`${Math.round(arrayPercent)} %`}
            detail={`${formatBytes(capacity.used, "kib")} / ${formatBytes(capacity.total, "kib")}`}
            text={`${storageDevices} devices · ${poolDevices} pool devices`}
            percentage={arrayPercent}
            tone="blue"
          />
        </section>
        <GlassCard className="system-summary">
          <CardHeader
            icon={Server}
            title="System information"
            detail={`${info?.os.hostname ?? data.server.name} · Unraid ${unraidVersion}`}
            action={
              <Status
                value={online ? "ONLINE" : "OFFLINE"}
                label={online ? license : "offline"}
              />
            }
          />
          <div className="detail-grid">
            <DetailStat
              icon={Server}
              label="Model"
              value={
                [info?.system.manufacturer, info?.system.model]
                  .filter(Boolean)
                  .join(" ") || "Unavailable"
              }
              detail={hardware?.system?.version}
            />
            <DetailStat
              icon={Sparkles}
              label="Unraid version"
              value={unraidVersion}
              detail={`API ${hardware?.versions?.core?.api ?? "—"} · ${info?.os.arch ?? "—"}`}
            />
            <DetailStat
              icon={ShieldCheck}
              label="Server license"
              value={license}
              detail={data.registration.registration?.state}
            />
            <DetailStat
              icon={Activity}
              label="Uptime"
              value={uptime(info?.os.uptime, language)}
              detail={info?.os.uptime}
            />
            <DetailStat
              icon={Cpu}
              label="Processor"
              value={info?.cpu.brand ?? "Unavailable"}
              detail={`${info?.cpu.cores ?? "—"} cores · ${info?.cpu.threads ?? "—"} threads · ${hardware?.cpu?.socket ?? "—"}`}
            />
            <DetailStat
              icon={CircuitBoard}
              label="Motherboard"
              value={
                [hardware?.baseboard?.manufacturer, hardware?.baseboard?.model]
                  .filter(Boolean)
                  .join(" ") || "Unavailable"
              }
              detail={`${hardware?.baseboard?.memSlots ?? "—"} memory slots`}
            />
            <DetailStat
              icon={MemoryStick}
              label="Installed memory"
              value={formatBytes(metrics?.memory?.total)}
              detail={
                memoryTypes ||
                `${memoryLayout.length} memory module${memoryLayout.length === 1 ? "" : "s"}`
              }
            />
            <DetailStat
              icon={Router}
              label="Local IP"
              value={<span translate="no">{localAddress}</span>}
              detail={primaryNetwork?.name ?? localAccess?.name ?? "LAN"}
            />
            <DetailStat
              icon={Globe2}
              label="Public IP"
              value={
                <span
                  className={`sensitive-value ${publicIpVisible ? "is-visible" : ""}`}
                  translate="no"
                >
                  {publicAddress}
                </span>
              }
              detail="Hidden by default"
              action={
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => setPublicIpVisible((current) => !current)}
                  aria-label={
                    publicIpVisible ? "Hide public IP" : "Reveal public IP"
                  }
                  aria-pressed={publicIpVisible}
                  title={
                    publicIpVisible ? "Hide public IP" : "Reveal public IP"
                  }
                >
                  {publicIpVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              }
            />
            <DetailStat
              icon={Terminal}
              label="Software"
              value={`Kernel ${hardware?.versions?.core?.kernel ?? info?.os.kernel ?? "—"}`}
              detail={`Docker ${hardware?.versions?.packages?.docker ?? "—"} · Node ${hardware?.versions?.packages?.node ?? "—"}`}
            />
            <DetailStat
              icon={Usb}
              label="Hardware inventory"
              value={`${hardware?.devices?.gpu?.length ?? 0} GPU · ${hardware?.devices?.pci?.length ?? 0} PCI`}
              detail={`${hardware?.devices?.usb?.length ?? 0} USB ${(hardware?.devices?.usb?.length ?? 0) === 1 ? "device" : "devices"}`}
            />
          </div>
        </GlassCard>

        <GlassCard className="thermal-summary">
          <CardHeader
            icon={Thermometer}
            title="Component temperatures"
            detail={`${temperatureSensors.length || cpuPackageTemperatures.length + temperatureDisks.length} sensors available`}
          />
          <div className="telemetry-list">
            {temperatureSensors.map((sensor) => (
              <article className="telemetry-row" key={sensor.id}>
                <span className="telemetry-icon">
                  <Thermometer size={16} />
                </span>
                <div>
                  <strong>{sensor.name}</strong>
                  <small>
                    {sensor.type.replaceAll("_", " ")}
                    {sensor.location ? ` · ${sensor.location}` : ""}
                  </small>
                </div>
                <div className="temperature-reading">
                  <b
                    className={`temperature-${sensor.current.status.toLowerCase()}`}
                  >
                    {Math.round(sensor.current.value)}°
                  </b>
                  <small>
                    {sensor.min ? `${Math.round(sensor.min.value)}°` : "—"} /{" "}
                    {sensor.max ? `${Math.round(sensor.max.value)}°` : "—"}
                  </small>
                </div>
              </article>
            ))}
            {!temperatureSensors.length &&
              cpuPackageTemperatures.map((temperature, index) => (
                <article className="telemetry-row" key={`cpu-${index}`}>
                  <span className="telemetry-icon">
                    <Cpu size={16} />
                  </span>
                  <div>
                    <strong>CPU package {index + 1}</strong>
                    <small>
                      {hardware?.cpu?.packages?.power?.[index]
                        ? `${hardware.cpu.packages.power[index]?.toFixed(1)} W`
                        : "Processor"}
                    </small>
                  </div>
                  <div className="temperature-reading">
                    <b>{Math.round(temperature)}°C</b>
                  </div>
                </article>
              ))}
            {!temperatureSensors.length &&
              temperatureDisks.map((disk) => (
                <article className="telemetry-row" key={disk.id}>
                  <span className="telemetry-icon">
                    <HardDrive size={16} />
                  </span>
                  <div>
                    <strong>{disk.name ?? disk.device}</strong>
                    <small>{disk.type}</small>
                  </div>
                  <div className="temperature-reading">
                    <b>{disk.temp}°C</b>
                  </div>
                </article>
              ))}
            {!temperatureSensors.length &&
              !cpuPackageTemperatures.length &&
              !temperatureDisks.length && (
                <Empty
                  icon={Thermometer}
                  title="No temperature sensors"
                  text={
                    data.telemetry.error ??
                    "No component temperatures were reported."
                  }
                />
              )}
          </div>
        </GlassCard>

        <GlassCard className="network-summary">
          <CardHeader
            icon={Network}
            title="Network bandwidth"
            detail={`${interfaceNames.length} network interface${interfaceNames.length === 1 ? "" : "s"}`}
          />
          <div className="telemetry-list">
            {interfaceNames.map((name) => {
              const networkInterface = officialByName.get(name);
              const legacyInterface = legacyByName.get(name);
              const networkMetric = metricsByName.get(name);
              const address =
                networkInterface?.ipAddress ||
                networkInterface?.ipv4Addresses?.[0]?.address;
              const speed = networkInterface?.speed
                ? `${networkInterface.speed} Mb/s`
                : legacyInterface?.speed;
              return (
                <article className="network-row" key={name}>
                  <span className="telemetry-icon">
                    <Router size={16} />
                  </span>
                  <div className="network-copy">
                    <div>
                      <strong translate="no">{name}</strong>
                      <Status
                        value={
                          networkMetric?.operstate ??
                          networkInterface?.operstate ??
                          networkInterface?.status
                        }
                      />
                    </div>
                    <small>
                      {address ?? "No address"}
                      {speed ? ` · ${speed}` : ""}
                      {networkInterface?.duplex
                        ? ` · ${networkInterface.duplex}`
                        : ""}
                    </small>
                    <span>
                      {networkInterface?.description ??
                        legacyInterface?.model ??
                        legacyInterface?.vendor}
                    </span>
                  </div>
                  <div className="network-rates">
                    <span title="Download rate">
                      <Download size={13} />
                      {formatRate(networkMetric?.rxSec)}
                    </span>
                    <span title="Upload rate">
                      <Upload size={13} />
                      {formatRate(networkMetric?.txSec)}
                    </span>
                  </div>
                </article>
              );
            })}
            {!interfaceNames.length && (
              <Empty
                icon={Network}
                title="Network unavailable"
                text={
                  data.telemetry.error ??
                  data.networkInfo.error ??
                  "No network interfaces were reported."
                }
              />
            )}
          </div>
        </GlassCard>
      </div>
    </Localized>
  );
}

function StorageView({
  array,
  error,
  requestAction,
  diskIo,
}: {
  array?: ArrayInfo;
  error?: string;
  requestAction: (action: PendingAction) => void;
  diskIo: Dashboard["diskIo"];
}) {
  if (!array)
    return (
      <GlassCard>
        <Empty
          icon={CloudOff}
          title="Storage unavailable"
          text={error ?? "The Array section is unavailable."}
        />
      </GlassCard>
    );
  const capacity = effectiveStorageCapacity(array);
  const allDisks = [
    ...(array.boot ? [array.boot] : []),
    ...array.parities,
    ...array.disks,
    ...array.caches,
  ];
  const ioByDevice = new Map(
    diskIo.devices?.map((device) => [device.device, device]),
  );
  const usage = percent(capacity.used, capacity.total);
  return (
    <Localized>
      <div className="content-stack view-enter">
        <section className="page-hero glass-card compact-hero">
          <div>
            <span className="eyebrow">
              {capacity.fromPools ? "STORAGE POOLS" : "MAIN ARRAY"}
            </span>
            <h1>{formatBytes(capacity.total, "kib")} capacity.</h1>
            <p>
              {allDisks.length} devices · {formatBytes(capacity.free, "kib")}{" "}
              still available.
            </p>
          </div>
          <div className="page-hero-actions">
            <Status value={array.state} />
            <button
              className={`button ${array.state === "STARTED" ? "danger-ghost" : "primary"}`}
              onClick={() =>
                requestAction({
                  target: "array",
                  action: array.state === "STARTED" ? "stop" : "start",
                  label: `l’array`,
                  dangerous: array.state === "STARTED",
                })
              }
            >
              {array.state === "STARTED" ? (
                <Square size={16} />
              ) : (
                <Play size={16} />
              )}
              {array.state === "STARTED" ? "Stop" : "Start"}
            </button>
          </div>
        </section>
        <div className="storage-overview glass-card">
          <div className="storage-value">
            <span>USAGE</span>
            <strong>{Math.round(usage)}%</strong>
          </div>
          <div className="storage-bar">
            <Progress value={usage} />
            <div>
              <span>{formatBytes(capacity.used, "kib")} used</span>
              <span>{formatBytes(capacity.total, "kib")} total</span>
            </div>
          </div>
          <div className="parity-chip">
            <ShieldCheck size={20} />
            <div>
              <span>Last parity</span>
              <strong>
                {array.parityCheckStatus.status
                  .toLowerCase()
                  .replaceAll("_", " ")}
              </strong>
            </div>
          </div>
        </div>
        <div className="section-title">
          <div>
            <span className="eyebrow">DEVICES</span>
            <h2>Disks, cache & boot</h2>
          </div>
          <span>{allDisks.length} items</span>
        </div>
        <div className="disk-grid">
          {allDisks.map((disk) => (
            <DiskCard
              key={disk.id}
              disk={disk}
              io={disk.device ? ioByDevice.get(disk.device) : undefined}
              ioUnavailable={Boolean(diskIo.error)}
            />
          ))}
        </div>
      </div>
    </Localized>
  );
}

function DiskCard({
  disk,
  io,
  ioUnavailable,
}: {
  disk: Disk;
  io?: NonNullable<Dashboard["diskIo"]["devices"]>[number];
  ioUnavailable: boolean;
}) {
  const usage = percent(disk.fsUsed, disk.fsSize);
  return (
    <Localized>
      <article className="disk-card glass-card">
        <div className="disk-top">
          <span className={`disk-visual ${disk.type.toLowerCase()}`}>
            <HardDrive size={21} />
          </span>
          <Status
            value={disk.status}
            label={
              disk.status === "DISK_OK" ? "healthy" : disk.status?.toLowerCase()
            }
          />
        </div>
        <div className="disk-name">
          <h3>{disk.name ?? disk.device ?? `Disk ${disk.idx}`}</h3>
          <p>
            {disk.device} · {disk.fsType ?? disk.transport ?? "—"}
          </p>
        </div>
        {disk.type !== "PARITY" && (
          <>
            <div className="disk-usage">
              <span>{formatBytes(disk.fsUsed, "kib")}</span>
              <b>{Math.round(usage)}%</b>
            </div>
            <Progress value={usage} tone={usage > 90 ? "warning" : "accent"} />
          </>
        )}
        <div className="disk-io">
          <span>
            <Download size={14} />
            <small>Reads</small>
            <strong>
              {ioUnavailable
                ? "Unavailable"
                : formatDiskRate(io?.readBytesPerSecond)}
            </strong>
          </span>
          <span>
            <Upload size={14} />
            <small>Writes</small>
            <strong>
              {ioUnavailable
                ? "Unavailable"
                : formatDiskRate(io?.writeBytesPerSecond)}
            </strong>
          </span>
        </div>
        <div className="disk-footer">
          <span>
            <Thermometer size={15} />
            {disk.temp ? `${disk.temp}°C` : "—"}
          </span>
          <span>
            <Activity size={15} />
            {numeric(disk.numErrors)} error
            {numeric(disk.numErrors) === 1 ? "" : "s"}
          </span>
          <span className={disk.isSpinning ? "spinning" : ""}>
            {disk.type === "FLASH" ? (
              <>
                <Usb size={15} />
                Boot device
              </>
            ) : (
              <>
                <RotateCw size={15} />
                {disk.isSpinning ? "Active" : "Standby"}
              </>
            )}
          </span>
        </div>
      </article>
    </Localized>
  );
}

function LogConsole({
  kind,
  containerId,
  compact = false,
}: {
  kind: "server" | "docker";
  containerId?: string;
  compact?: boolean;
}) {
  const { language } = useI18n();
  const [snapshot, setSnapshot] = useState<LogSnapshot | null>(null);
  const [lineLimit, setLineLimit] = useState(250);
  const [lineLimitDraft, setLineLimitDraft] = useState("250");
  const [serverSource, setServerSource] = useState<ServerLogSource>("system");
  const [serverSources, setServerSources] = useState<ServerLogSourceOption[]>([
    { id: "system", label: "System" },
  ]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const consoleRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (kind !== "server") return;
    void api
      .serverLogSources()
      .then((sources) => {
        if (!sources.length) return;
        setServerSources(sources);
        setServerSource((current) =>
          sources.some((source) => source.id === current)
            ? current
            : sources[0].id,
        );
      })
      .catch(() => undefined);
  }, [kind]);

  const loadLogs = useCallback(
    async (requestedLines: number) => {
      setLoading(true);
      try {
        const next =
          kind === "server"
            ? await api.serverLogs(requestedLines, serverSource)
            : await api.dockerLogs(containerId ?? "", requestedLines);
        setSnapshot(next);
        setError(null);
      } catch (logError) {
        setError(
          logError instanceof Error
            ? logError.message
            : "Logs are unavailable.",
        );
      } finally {
        setLoading(false);
      }
    },
    [containerId, kind, serverSource],
  );

  useEffect(() => {
    void loadLogs(lineLimit);
  }, [lineLimit, loadLogs]);

  const applyLineLimit = (refreshCurrent = false) => {
    const requested = Number(lineLimitDraft);
    const next = Number.isFinite(requested)
      ? Math.min(10_000, Math.max(1, Math.round(requested)))
      : lineLimit;
    setLineLimitDraft(String(next));
    if (next !== lineLimit) setLineLimit(next);
    else if (refreshCurrent) void loadLogs(next);
  };

  useEffect(() => {
    const consoleElement = consoleRef.current;
    if (!loading && consoleElement) {
      consoleElement.scrollTop = consoleElement.scrollHeight;
    }
  }, [loading, snapshot, search]);

  const query = search.trim().toLowerCase();
  const visibleLines =
    snapshot?.lines.filter(
      (line) => !query || line.toLowerCase().includes(query),
    ) ?? [];

  return (
    <section className={`log-viewer${compact ? " is-compact" : " glass-card"}`}>
      <div className="log-toolbar">
        <label className="search log-search">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Search logs…"
            placeholder="Search logs…"
          />
        </label>
        {kind === "server" && (
          <label className="log-source">
            <span>Source</span>
            <select
              value={serverSource}
              aria-label="Log source"
              onChange={(event) =>
                setServerSource(event.target.value as ServerLogSource)
              }
            >
              {serverSources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="log-limit">
          <span>Lines</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={10_000}
            step={1}
            value={lineLimitDraft}
            aria-label="Number of log lines"
            title="Enter between 1 and 10,000 lines"
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setLineLimitDraft(event.target.value)}
            onBlur={() => applyLineLimit()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
          />
        </label>
        <button
          className="icon-button"
          type="button"
          onClick={() => applyLineLimit(true)}
          aria-label="Refresh logs"
          title="Refresh logs"
          disabled={loading}
        >
          <RefreshCw className={loading ? "spin" : ""} size={17} />
        </button>
      </div>
      <div className="log-meta">
        <span>
          <i />
          {snapshot?.source ?? kind}
        </span>
        {snapshot && (
          <small>
            Updated {new Date(snapshot.fetchedAt).toLocaleTimeString(language)}
          </small>
        )}
      </div>
      <div
        ref={consoleRef}
        className="log-console"
        role="log"
        aria-live="polite"
      >
        {error ? (
          <div className="log-state is-error">
            <AlertTriangle size={18} />
            <span>{error}</span>
          </div>
        ) : loading && !snapshot ? (
          <div className="log-state">
            <RefreshCw className="spin" size={18} />
            <span>Loading logs…</span>
          </div>
        ) : visibleLines.length ? (
          <pre>{visibleLines.join("\n")}</pre>
        ) : (
          <div className="log-state">
            <Search size={18} />
            <span>No log entries match your search.</span>
          </div>
        )}
      </div>
    </section>
  );
}

function LogsView({
  sshEnabled,
  onOpenSettings,
}: {
  sshEnabled: boolean;
  onOpenSettings: () => void;
}) {
  return (
    <Localized>
      <div className="content-stack view-enter">
        <section className="page-hero glass-card">
          <div>
            <span className="eyebrow">SYSTEM LOGS</span>
            <h1>Your server, line by line.</h1>
            <p>Live system events retrieved securely over SSH.</p>
          </div>
          <HeroVisual icon={Terminal} tone="logs" />
        </section>
        {sshEnabled ? (
          <LogConsole kind="server" />
        ) : (
          <GlassCard>
            <Empty
              icon={Terminal}
              title="SSH is required"
              text="Enable SSH file access to securely retrieve server logs."
            />
            <div className="empty-action">
              <button className="button primary" onClick={onOpenSettings}>
                <Settings size={16} />
                Configure SSH
              </button>
            </div>
          </GlassCard>
        )}
      </div>
    </Localized>
  );
}

function DockerView({
  containers,
  stats,
  error,
  requestAction,
}: {
  containers: DockerContainer[];
  stats: DockerRuntimeStats[];
  error?: string;
  requestAction: (action: PendingAction) => void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "running" | "stopped">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [logTarget, setLogTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const statsByName = new Map(
    stats.map((item) => [item.name.replace(/^\//, ""), item]),
  );
  const shown = containers.filter((item) => {
    const matchesSearch = `${item.names.join(" ")} ${item.image}`
      .toLowerCase()
      .includes(search.toLowerCase());
    const matchesFilter =
      filter === "all" ||
      (filter === "running"
        ? item.state === "RUNNING"
        : item.state !== "RUNNING");
    return matchesSearch && matchesFilter;
  });
  return (
    <Localized>
      <div className="content-stack view-enter">
        <section className="page-hero glass-card">
          <div>
            <span className="eyebrow">DOCKER ENGINE</span>
            <h1>Your apps, under control.</h1>
            <p>
              {containers.filter((item) => item.state === "RUNNING").length}{" "}
              containers running out of {containers.length}.
            </p>
          </div>
          <HeroVisual icon={Boxes} tone="docker" />
        </section>
        <div className="toolbar">
          <label className="search">
            <Search size={17} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search for an application…"
              placeholder="Search for an application…"
            />
          </label>
          <div className="segment">
            {(["all", "running", "stopped"] as const).map((value) => (
              <button
                key={value}
                className={filter === value ? "active" : ""}
                onClick={() => setFilter(value)}
              >
                {value === "all"
                  ? "All"
                  : value === "running"
                    ? "Running"
                    : "Stopped"}
              </button>
            ))}
          </div>
        </div>
        {error && !containers.length ? (
          <GlassCard>
            <Empty icon={CloudOff} title="Docker unavailable" text={error} />
          </GlassCard>
        ) : (
          <div className="resource-list">
            {shown.map((container) => {
              const name =
                container.names[0]?.replace(/^\//, "") ?? "Application";
              const expanded = expandedId === container.id;
              const runtimeStats = statsByName.get(name);
              return (
                <article
                  className={`resource-row glass-card ${expanded ? "is-expanded" : ""}`}
                  key={container.id}
                >
                  <span className="resource-avatar docker-avatar">
                    {container.iconUrl ? (
                      <img src={container.iconUrl} alt="" />
                    ) : (
                      <Boxes size={22} />
                    )}
                  </span>
                  <div className="resource-main">
                    <div className="resource-title">
                      <h3>{container.names[0]?.replace(/^\//, "")}</h3>
                      {container.isUpdateAvailable && (
                        <span className="update-pill">UPDATE</span>
                      )}
                    </div>
                    <p>{container.image}</p>
                  </div>
                  <div className="resource-summary">
                    <Status value={container.state} />
                    <span>{container.status}</span>
                    {container.lanIpPorts?.[0] && (
                      <span>
                        <Network size={13} />
                        {container.lanIpPorts[0]}
                      </span>
                    )}
                  </div>
                  <div className="resource-actions">
                    {container.webUiUrl && (
                      <a
                        className="icon-button"
                        href={container.webUiUrl}
                        target="_blank"
                        rel="noreferrer"
                        title="Open interface"
                        aria-label="Open interface"
                      >
                        <ArrowUpRight size={17} />
                      </a>
                    )}
                    {container.state === "RUNNING" ? (
                      <>
                        <button
                          className="icon-button"
                          title="Restart"
                          aria-label="Restart"
                          onClick={() =>
                            requestAction({
                              target: "docker",
                              action: "restart",
                              id: container.id,
                              label: container.names[0] ?? "this container",
                            })
                          }
                        >
                          <RefreshCw size={17} />
                        </button>
                        <button
                          className="icon-button danger"
                          title="Stop"
                          aria-label="Stop"
                          onClick={() =>
                            requestAction({
                              target: "docker",
                              action: "stop",
                              id: container.id,
                              label: container.names[0] ?? "this container",
                              dangerous: true,
                            })
                          }
                        >
                          <Square size={16} />
                        </button>
                      </>
                    ) : (
                      <button
                        className="icon-button success"
                        title="Start"
                        aria-label="Start"
                        onClick={() =>
                          requestAction({
                            target: "docker",
                            action: "start",
                            id: container.id,
                            label: container.names[0] ?? "this container",
                          })
                        }
                      >
                        <Play size={17} />
                      </button>
                    )}
                    <button
                      className="icon-button"
                      type="button"
                      title="View logs"
                      aria-label={`View logs for ${name}`}
                      onClick={() => setLogTarget({ id: container.id, name })}
                    >
                      <Terminal size={17} />
                    </button>
                    <button
                      className="icon-button detail-toggle"
                      type="button"
                      title={expanded ? "Hide details" : "Show details"}
                      aria-label={expanded ? "Hide details" : "Show details"}
                      aria-expanded={expanded}
                      onClick={() =>
                        setExpandedId((current) =>
                          current === container.id ? null : container.id,
                        )
                      }
                    >
                      <ChevronRight size={17} />
                    </button>
                  </div>
                  {expanded && (
                    <ContainerDetails
                      container={container}
                      stats={runtimeStats}
                    />
                  )}
                </article>
              );
            })}
            {!shown.length && (
              <GlassCard>
                <Empty
                  icon={Search}
                  title="No results"
                  text="Try another search or filter."
                />
              </GlassCard>
            )}
          </div>
        )}
        {logTarget &&
          createPortal(
            <div
              className="modal-backdrop log-modal-backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setLogTarget(null);
              }}
            >
              <section
                className="modal log-modal glass-card"
                role="dialog"
                aria-modal="true"
                aria-labelledby="container-logs-title"
              >
                <button
                  className="modal-close icon-button"
                  type="button"
                  onClick={() => setLogTarget(null)}
                  aria-label="Close logs"
                >
                  <X size={18} />
                </button>
                <span className="eyebrow">CONTAINER LOGS</span>
                <h2 id="container-logs-title">{logTarget.name}</h2>
                <p className="log-modal-copy">
                  Live output retrieved securely over SSH.
                </p>
                <LogConsole
                  key={logTarget.id}
                  kind="docker"
                  containerId={logTarget.id}
                  compact
                />
              </section>
            </div>,
            document.body,
          )}
      </div>
    </Localized>
  );
}

function VmAvatar({ vm }: { vm: Vm }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <span className={`resource-avatar vm-avatar${loaded ? " has-image" : ""}`}>
      {!failed && (
        <img
          src={api.vmIconUrl(vm.id)}
          alt=""
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
      {!loaded && <Monitor size={21} />}
    </span>
  );
}

function VmsView({
  vms,
  error,
  requestAction,
}: {
  vms: Vm[];
  error?: string;
  requestAction: (action: PendingAction) => void;
}) {
  return (
    <Localized>
      <div className="content-stack view-enter">
        <section className="page-hero glass-card">
          <div>
            <span className="eyebrow">VIRTUALIZATION</span>
            <h1>Machines, without friction.</h1>
            <p>
              {vms.filter((vm) => vm.state === "RUNNING").length} machines
              running out of {vms.length}.
            </p>
          </div>
          <HeroVisual icon={Monitor} tone="vms" />
        </section>
        <div className="resource-list">
          {vms.map((vm) => (
            <article
              className="resource-row vm-resource-row glass-card"
              key={vm.id}
            >
              <VmAvatar vm={vm} />
              <div className="resource-main">
                <h3>{vm.name ?? "Virtual machine"}</h3>
                <p>ID {vm.id.split(":").at(-1)?.slice(0, 8)}</p>
              </div>
              <div className="resource-summary">
                <Status value={vm.state} />
              </div>
              <div className="resource-actions">
                {vm.state === "RUNNING" ? (
                  <>
                    <button
                      className="icon-button"
                      title="Pause"
                      onClick={() =>
                        requestAction({
                          target: "vm",
                          action: "pause",
                          id: vm.id,
                          label: vm.name ?? "this VM",
                        })
                      }
                    >
                      <Pause size={17} />
                    </button>
                    <button
                      className="icon-button"
                      title="Restart"
                      onClick={() =>
                        requestAction({
                          target: "vm",
                          action: "reboot",
                          id: vm.id,
                          label: vm.name ?? "this VM",
                        })
                      }
                    >
                      <RefreshCw size={17} />
                    </button>
                    <button
                      className="icon-button danger"
                      title="Stop"
                      onClick={() =>
                        requestAction({
                          target: "vm",
                          action: "stop",
                          id: vm.id,
                          label: vm.name ?? "this VM",
                          dangerous: true,
                        })
                      }
                    >
                      <Power size={17} />
                    </button>
                  </>
                ) : vm.state === "PAUSED" ? (
                  <button
                    className="icon-button success"
                    title="Resume"
                    onClick={() =>
                      requestAction({
                        target: "vm",
                        action: "resume",
                        id: vm.id,
                        label: vm.name ?? "this VM",
                      })
                    }
                  >
                    <Play size={17} />
                  </button>
                ) : (
                  <button
                    className="icon-button success"
                    title="Start"
                    onClick={() =>
                      requestAction({
                        target: "vm",
                        action: "start",
                        id: vm.id,
                        label: vm.name ?? "this VM",
                      })
                    }
                  >
                    <Play size={17} />
                  </button>
                )}
              </div>
            </article>
          ))}
          {!vms.length && (
            <GlassCard>
              <Empty
                icon={Monitor}
                title="No machines"
                text={
                  error ?? "No virtual machine is configured on this server."
                }
              />
            </GlassCard>
          )}
        </div>
      </div>
    </Localized>
  );
}

function childPath(parent: string, name: string) {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function parentPath(path: string) {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

type FileDialog =
  | { kind: "folder" }
  | { kind: "rename"; entry: FileEntry }
  | { kind: "delete"; entry: FileEntry };

function ShareFileBrowser({
  initialPath,
  serverId,
}: {
  initialPath: string;
  serverId: string;
}) {
  const [path, setPath] = useState(initialPath);
  const [listing, setListing] = useState<Awaited<
    ReturnType<typeof api.files>
  > | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [pageSizeInput, setPageSizeInput] = useState("10");
  const [pageJumpOpen, setPageJumpOpen] = useState(false);
  const [pageJumpInput, setPageJumpInput] = useState("1");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<FileDialog | null>(null);
  const [dialogValue, setDialogValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);

  const loadPath = useCallback(
    async (nextPath: string, nextPage: number, nextPageSize: number) => {
      setLoading(true);
      setError(null);
      try {
        const nextListing = await api.files(nextPath, nextPage, nextPageSize);
        setListing(nextListing);
        if (nextListing.page !== nextPage) setPage(nextListing.page);
      } catch (loadError) {
        setListing(null);
        setError(
          loadError instanceof Error
            ? loadError.message
            : "The folder could not be loaded.",
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    setPath(initialPath);
    setPage(1);
  }, [initialPath, serverId]);

  useEffect(() => {
    void loadPath(path, page, pageSize);
  }, [loadPath, page, pageSize, path, serverId]);

  const refresh = () => void loadPath(path, page, pageSize);
  const openPath = (nextPath: string) => {
    setPath(nextPath);
    setPage(1);
    setMessage(null);
    setPageJumpOpen(false);
  };
  const openDialog = (nextDialog: FileDialog) => {
    setPageJumpOpen(false);
    setDialog(nextDialog);
    setDialogValue(nextDialog.kind === "rename" ? nextDialog.entry.name : "");
  };

  const submitDialog = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog) return;
    setBusy(true);
    setMessage(null);
    try {
      if (dialog.kind === "folder") {
        await api.createFolder(childPath(path, dialogValue.trim()));
        setMessage("Folder created.");
      } else if (dialog.kind === "rename") {
        await api.renameFile(
          dialog.entry.path,
          childPath(parentPath(dialog.entry.path), dialogValue.trim()),
        );
        setMessage("Item renamed.");
      } else {
        await api.deleteFile(dialog.entry.path);
        setMessage("Item deleted.");
      }
      setDialog(null);
      await loadPath(path, page, pageSize);
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : "The file operation failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const selected = Array.from(files);
      for (const file of selected) {
        await api.uploadFile(childPath(path, file.name), file);
      }
      setMessage("Upload complete.");
      await loadPath(path, page, pageSize);
    } catch (uploadError) {
      setError(
        uploadError instanceof Error ? uploadError.message : "Upload failed.",
      );
    } finally {
      if (uploadInput.current) uploadInput.current.value = "";
      setBusy(false);
    }
  };
  const applyPageSize = () => {
    const requested = Number(pageSizeInput);
    const nextPageSize = Math.min(
      100,
      Math.max(10, Number.isFinite(requested) ? Math.round(requested) : 10),
    );
    setPageSizeInput(String(nextPageSize));
    if (nextPageSize === pageSize) return;
    setPageSize(nextPageSize);
    setPage(1);
    setPageJumpOpen(false);
  };

  const jumpToPage = (event: FormEvent) => {
    event.preventDefault();
    if (!listing) return;
    const requested = Number(pageJumpInput);
    const nextPage = Math.min(
      listing.totalPages,
      Math.max(1, Number.isFinite(requested) ? Math.round(requested) : 1),
    );
    setPageJumpInput(String(nextPage));
    setPage(nextPage);
    setPageJumpOpen(false);
  };

  const parts = path.split("/").filter(Boolean);
  const pageNumbers = listing
    ? [
        ...new Set([
          1,
          listing.page - 1,
          listing.page,
          listing.page + 1,
          listing.totalPages,
        ]),
      ]
        .filter(
          (candidate) => candidate >= 1 && candidate <= listing.totalPages,
        )
        .sort((left, right) => left - right)
    : [];

  return (
    <Localized>
      <section className="file-browser glass-card">
        <div className="file-browser-head">
          <div>
            <span className="eyebrow">SFTP FILES</span>
            <h2>File browser</h2>
            <p>
              Encrypted access inside{" "}
              <code translate="no">{listing?.rootPath ?? "Shares"}</code>
            </p>
          </div>
          <div className="file-browser-actions">
            <button
              className="icon-button"
              type="button"
              onClick={() => openPath(parentPath(path))}
              disabled={path === "/" || busy}
              title="Parent folder"
              aria-label="Parent folder"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={refresh}
              disabled={busy}
              title="Refresh"
              aria-label="Refresh"
            >
              <RefreshCw className={loading ? "spin" : ""} size={17} />
            </button>
            <button
              className="button secondary compact"
              type="button"
              onClick={() => openDialog({ kind: "folder" })}
              disabled={busy}
            >
              <FolderPlus size={17} /> New folder
            </button>
            <button
              className="button primary compact"
              type="button"
              onClick={() => uploadInput.current?.click()}
              disabled={busy}
            >
              <Upload size={17} /> Upload
            </button>
            <input
              ref={uploadInput}
              className="visually-hidden"
              type="file"
              multiple
              onChange={(event) => void uploadFiles(event.target.files)}
            />
          </div>
        </div>

        <nav className="file-breadcrumbs" aria-label="Current folder">
          <button type="button" onClick={() => openPath("/")}>
            <House size={15} />
            Shares
          </button>
          {parts.map((part, index) => {
            const target = `/${parts.slice(0, index + 1).join("/")}`;
            return (
              <span key={target}>
                <ChevronRight size={14} />
                <button
                  type="button"
                  translate="no"
                  onClick={() => openPath(target)}
                >
                  {part}
                </button>
              </span>
            );
          })}
        </nav>

        {error && (
          <div className="file-notice is-error">
            <AlertTriangle size={16} />
            <span>{error}</span>
            <button type="button" onClick={refresh}>
              Retry
            </button>
          </div>
        )}
        {message && !error && (
          <div className="file-notice is-success">
            <Check size={16} /> {message}
          </div>
        )}

        <div className="file-list" aria-busy={loading}>
          <div className="file-list-head">
            <span>Name</span>
            <span>Size</span>
            <span>Modified</span>
            <span>Mode</span>
            <span />
          </div>
          {loading ? (
            Array.from({ length: 4 }, (_, index) => (
              <div className="file-row file-row-skeleton" key={index}>
                <span className="file-skeleton-bar" />
              </div>
            ))
          ) : listing?.files.length ? (
            listing.files.map((entry) => (
              <div className="file-row" key={entry.path}>
                <button
                  className="file-name"
                  type="button"
                  onClick={() => {
                    if (entry.type === "directory") openPath(entry.path);
                    else window.location.assign(api.downloadUrl(entry.path));
                  }}
                >
                  <span className={`file-icon is-${entry.type}`}>
                    {entry.type === "directory" ? (
                      <FolderOpen size={20} />
                    ) : (
                      <FileIcon size={20} />
                    )}
                  </span>
                  <span>
                    <strong translate="no">{entry.name}</strong>
                    <small>{entry.type}</small>
                  </span>
                </button>
                <span className="file-size">
                  {entry.type === "directory" ? "—" : formatBytes(entry.size)}
                </span>
                <span className="file-modified">
                  {entry.modifiedAt
                    ? new Date(entry.modifiedAt).toLocaleString()
                    : "—"}
                </span>
                <code className="file-mode">{entry.permissions}</code>
                <div className="file-actions">
                  {entry.type !== "directory" && (
                    <a
                      className="icon-button"
                      href={api.downloadUrl(entry.path)}
                      download
                      title="Download"
                      aria-label={`Download ${entry.name}`}
                    >
                      <Download size={16} />
                    </a>
                  )}
                  <button
                    className="icon-button"
                    type="button"
                    onClick={() => openDialog({ kind: "rename", entry })}
                    title="Rename"
                    aria-label={`Rename ${entry.name}`}
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    className="icon-button danger"
                    type="button"
                    onClick={() => openDialog({ kind: "delete", entry })}
                    title="Delete"
                    aria-label={`Delete ${entry.name}`}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))
          ) : (
            <Empty
              icon={FolderOpen}
              title="This folder is empty"
              text="Upload a file or create a folder to get started."
            />
          )}
        </div>
        {listing && listing.totalItems > 0 && (
          <footer className="file-pagination">
            <div className="file-page-size">
              <span>
                {(listing.page - 1) * listing.pageSize + 1}–
                {Math.min(listing.page * listing.pageSize, listing.totalItems)}{" "}
                / {listing.totalItems}
              </span>
              <label>
                Items per page
                <input
                  value={pageSizeInput}
                  onChange={(event) => setPageSizeInput(event.target.value)}
                  onBlur={applyPageSize}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      applyPageSize();
                      event.currentTarget.blur();
                    }
                    if (event.key === "Escape") {
                      setPageSizeInput(String(pageSize));
                      event.currentTarget.blur();
                    }
                  }}
                  type="number"
                  min="10"
                  max="100"
                  step="1"
                  inputMode="numeric"
                  list="file-page-size-options"
                  disabled={loading || busy}
                  aria-label="Items per page"
                />
                <datalist id="file-page-size-options">
                  <option value="10" />
                  <option value="25" />
                  <option value="50" />
                  <option value="100" />
                </datalist>
              </label>
            </div>
            <nav className="file-pages" aria-label="Pagination">
              <button
                className="icon-button"
                type="button"
                onClick={() => setPage((current) => current - 1)}
                disabled={loading || busy || listing.page === 1}
                title="Previous page"
                aria-label="Previous page"
              >
                <ChevronLeft size={16} />
              </button>
              {pageJumpOpen ? (
                <form className="file-page-jump" onSubmit={jumpToPage}>
                  <input
                    autoFocus
                    value={pageJumpInput}
                    onChange={(event) => setPageJumpInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setPageJumpOpen(false);
                    }}
                    type="number"
                    min="1"
                    max={listing.totalPages}
                    step="1"
                    inputMode="numeric"
                    aria-label="Go to page"
                  />
                  <button className="button compact" disabled={loading || busy}>
                    Go
                  </button>
                </form>
              ) : (
                <div className="file-page-numbers">
                  {pageNumbers.map((pageNumber, index) => (
                    <span key={pageNumber}>
                      {index > 0 &&
                        pageNumber - (pageNumbers[index - 1] ?? 0) > 1 && (
                          <button
                            className="file-page-gap"
                            type="button"
                            onClick={() => {
                              const previousPage = pageNumbers[index - 1] ?? 1;
                              setPageJumpInput(
                                String(
                                  Math.floor((previousPage + pageNumber) / 2),
                                ),
                              );
                              setPageJumpOpen(true);
                            }}
                            aria-label="Go to page"
                          >
                            …
                          </button>
                        )}
                      <button
                        className={pageNumber === listing.page ? "active" : ""}
                        type="button"
                        onClick={() => setPage(pageNumber)}
                        disabled={loading || busy}
                        aria-label={`Page ${pageNumber}`}
                        aria-current={
                          pageNumber === listing.page ? "page" : undefined
                        }
                      >
                        {pageNumber}
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <button
                className="icon-button"
                type="button"
                onClick={() => setPage((current) => current + 1)}
                disabled={
                  loading || busy || listing.page === listing.totalPages
                }
                title="Next page"
                aria-label="Next page"
              >
                <ChevronRight size={16} />
              </button>
            </nav>
          </footer>
        )}

        {dialog && (
          <div
            className="modal-backdrop file-dialog-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.currentTarget === event.target && !busy)
                setDialog(null);
            }}
          >
            <form
              className="confirm-modal glass-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="file-dialog-title"
              onSubmit={submitDialog}
            >
              <div
                className={`confirm-icon ${dialog.kind === "delete" ? "is-danger" : ""}`}
              >
                {dialog.kind === "delete" ? (
                  <Trash2 size={24} />
                ) : dialog.kind === "folder" ? (
                  <FolderPlus size={24} />
                ) : (
                  <Pencil size={24} />
                )}
              </div>
              <h2 id="file-dialog-title">
                {dialog.kind === "delete"
                  ? "Delete this item?"
                  : dialog.kind === "folder"
                    ? "Create a folder"
                    : "Rename item"}
              </h2>
              {dialog.kind === "delete" ? (
                <p>
                  <strong translate="no">{dialog.entry.name}</strong> and all of
                  its contents will be permanently deleted.
                </p>
              ) : (
                <label>
                  <span>
                    {dialog.kind === "folder" ? "Folder name" : "New name"}
                  </span>
                  <input
                    autoFocus
                    value={dialogValue}
                    onChange={(event) => setDialogValue(event.target.value)}
                    required
                  />
                </label>
              )}
              <div className="modal-actions">
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => setDialog(null)}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  className={`button ${dialog.kind === "delete" ? "danger-button" : "primary"}`}
                  disabled={
                    busy || (dialog.kind !== "delete" && !dialogValue.trim())
                  }
                >
                  {busy && <RefreshCw className="spin" size={16} />}
                  {dialog.kind === "delete"
                    ? "Delete"
                    : dialog.kind === "folder"
                      ? "Create"
                      : "Rename"}
                </button>
              </div>
            </form>
          </div>
        )}
      </section>
    </Localized>
  );
}

function toShareBrowserPath(rootPath: string, shareName?: string) {
  const normalizedRoot = `/${rootPath.split("/").filter(Boolean).join("/")}`;
  const shareRoot = "/mnt/user";
  const target = shareName ? `${shareRoot}/${shareName}` : shareRoot;
  if (normalizedRoot === "/") return target;
  if (target === normalizedRoot) return "/";
  if (target.startsWith(`${normalizedRoot}/`)) {
    return target.slice(normalizedRoot.length);
  }
  return "/";
}

function SharesView({
  shares,
  error,
  sshEnabled,
  sshRootPath,
  serverId,
  onOpenSettings,
}: {
  shares: Share[];
  error?: string;
  sshEnabled: boolean;
  sshRootPath: string;
  serverId: string;
  onOpenSettings: () => void;
}) {
  const [search, setSearch] = useState("");
  const [filesOpen, setFilesOpen] = useState(false);
  const [filePath, setFilePath] = useState("/");
  const fileBrowserAnchor = useRef<HTMLDivElement>(null);
  const shown = shares.filter((share) =>
    share.name?.toLowerCase().includes(search.toLowerCase()),
  );
  const browse = (share?: Share) => {
    if (!sshEnabled) {
      onOpenSettings();
      return;
    }
    setFilePath(toShareBrowserPath(sshRootPath, share?.name));
    setFilesOpen(true);
  };
  useEffect(() => {
    if (!filesOpen) return;
    const frame = window.requestAnimationFrame(() => {
      fileBrowserAnchor.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [filePath, filesOpen]);
  return (
    <Localized>
      <div className="content-stack view-enter">
        <section className="page-hero glass-card">
          <div>
            <span className="eyebrow">USER SHARES</span>
            <h1>Your data, organized.</h1>
            <p>{shares.length} shared spaces on your array.</p>
          </div>
          <HeroVisual icon={Folder} tone="shares" />
        </section>
        <div className="toolbar">
          <label className="search">
            <Search size={17} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Search shares…"
              placeholder="Search shares…"
            />
          </label>
          <button
            className="button secondary compact shares-file-toggle"
            type="button"
            onClick={() => {
              if (!sshEnabled) onOpenSettings();
              else if (filesOpen) setFilesOpen(false);
              else browse();
            }}
          >
            <FolderOpen size={17} />
            {sshEnabled
              ? filesOpen
                ? "Hide files"
                : "Browse files"
              : "Enable file access"}
          </button>
        </div>
        {filesOpen && sshEnabled && (
          <div className="shares-file-browser" ref={fileBrowserAnchor}>
            <ShareFileBrowser
              key={`${serverId}:${filePath}`}
              initialPath={filePath}
              serverId={serverId}
            />
          </div>
        )}
        <div className="share-grid">
          {shown.map((share) => {
            const used = numeric(share.used);
            const free = numeric(share.free);
            const usage = percent(used, used + free || share.size);
            return (
              <article className="share-card glass-card" key={share.id}>
                <div className="share-top">
                  <span className="share-icon">
                    <Folder size={21} />
                  </span>
                  <span
                    className={`share-location ${share.cache ? "cache" : "array"}`}
                  >
                    {share.cache ? <Zap size={13} /> : <HardDrive size={13} />}
                    {share.cache ? "Cache" : "Array"}
                  </span>
                </div>
                <h3>{share.name ?? "Unnamed"}</h3>
                <p>{share.comment || "Unraid user share"}</p>
                <div className="share-capacity">
                  <span>{formatBytes(share.used, "kib")} used</span>
                  <b>{Math.round(usage)}%</b>
                </div>
                <Progress value={usage} />
                <div className="share-footer">
                  <span>{formatBytes(share.free, "kib")} free</span>
                  <span>{share.allocator ?? "—"}</span>
                  {sshEnabled && (
                    <button
                      className="share-browse"
                      type="button"
                      onClick={() => browse(share)}
                    >
                      <FolderOpen size={14} /> Browse
                    </button>
                  )}
                </div>
              </article>
            );
          })}
          {!shown.length && (
            <GlassCard>
              <Empty
                icon={Folder}
                title="No shares"
                text={error ?? "No share matches your search."}
              />
            </GlassCard>
          )}
        </div>
      </div>
    </Localized>
  );
}

type LoginScreenProps = {
  busy: boolean;
  error: string | null;
  onLogin: (password: string) => Promise<void>;
};

function LoginScreen({ busy, error, onLogin }: LoginScreenProps) {
  const [password, setPassword] = useState("");

  return (
    <Localized>
      <main className="auth-shell">
        <div className="ambient ambient-one" aria-hidden />
        <div className="ambient ambient-two" aria-hidden />
        <div className="ambient ambient-three" aria-hidden />
        <section className="auth-card glass-card">
          <div className="auth-brand">
            <img src="/icon.svg" alt="" />
            <div>
              <strong>Unraid</strong>
              <small>CONTROL CENTER</small>
            </div>
          </div>
          <div className="auth-visual" aria-hidden>
            <div className="auth-orbit auth-orbit-one" />
            <div className="auth-orbit auth-orbit-two" />
            <div className="auth-lock">
              <ShieldCheck size={38} strokeWidth={1.6} />
            </div>
          </div>
          <span className="eyebrow">LOCAL AUTHENTICATION</span>
          <h1>Private access.</h1>
          <p>Enter the local password configured on this server to continue.</p>
          <form
            className="auth-form"
            onSubmit={(event) => {
              event.preventDefault();
              void onLogin(password);
            }}
          >
            <label>
              <span>Password</span>
              <div className="auth-input">
                <KeyRound size={17} aria-hidden />
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  autoFocus
                  required
                  disabled={busy}
                />
              </div>
            </label>
            {error && (
              <div className="auth-error" role="alert">
                <AlertTriangle size={16} />
                <span>{error}</span>
              </div>
            )}
            <button
              className="button primary auth-submit"
              type="submit"
              disabled={busy || !password}
            >
              {busy ? (
                <RefreshCw className="spin" size={17} />
              ) : (
                <LogIn size={17} />
              )}
              Unlock
            </button>
          </form>
          <div className="auth-trust">
            <ShieldCheck size={16} />
            <span>
              HttpOnly session · Password is never stored by the application
            </span>
          </div>
        </section>
      </main>
    </Localized>
  );
}

function ControlApp({ onLogout }: { onLogout: () => Promise<void> }) {
  const { language, setLanguage, t } = useI18n();
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [data, setData] = useState<Dashboard | null>(null);
  const [view, setView] = useState<View>(
    initialView && VALID_VIEWS.includes(initialView)
      ? initialView
      : "dashboard",
  );
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [addingServer, setAddingServer] = useState(false);
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const [serverToDelete, setServerToDelete] = useState<ServerSummary | null>(
    null,
  );
  const [serverDeleteBusy, setServerDeleteBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    tone: "success" | "error";
  } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [pollSeconds, setPollSeconds] = useState(() => {
    const stored = Number(localStorage.getItem("unraid-poll-seconds"));
    return Number.isInteger(stored) && stored >= 5 && stored <= 60 ? stored : 8;
  });
  const [light, setLight] = useState(
    () => localStorage.getItem("unraid-theme") === "light",
  );
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(
    null,
  );
  const [browserOnline, setBrowserOnline] = useState(navigator.onLine);

  const loadDashboard = useCallback(async (quiet = false) => {
    quiet ? setRefreshing(true) : setLoading(true);
    try {
      setData(await api.dashboard());
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "The server is not responding",
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void api
      .config()
      .then((value) => {
        setConfig(value);
        if (!value.configured) setLoading(false);
      })
      .catch((configError) => {
        setError(
          configError instanceof Error
            ? configError.message
            : "API unavailable",
        );
        setConfig({ configured: false, activeServerId: null, servers: [] });
        setLoading(false);
      });
  }, []);
  useEffect(() => {
    localStorage.setItem("unraid-poll-seconds", String(pollSeconds));
  }, [pollSeconds]);

  useEffect(() => {
    if (!config?.configured) return;
    void loadDashboard();
    const timer = window.setInterval(
      () => void loadDashboard(true),
      pollSeconds * 1000,
    );
    return () => window.clearInterval(timer);
  }, [config?.configured, config?.activeServerId, loadDashboard, pollSeconds]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    window.history.replaceState(null, "", url);
    document.title =
      view === "dashboard" ? "Unraid" : `Unraid · ${t(VIEW_META[view].label)}`;
  }, [view, language]);

  useEffect(() => {
    const install = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPrompt);
    };
    const online = () => setBrowserOnline(true);
    const offline = () => setBrowserOnline(false);
    window.addEventListener("beforeinstallprompt", install);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("beforeinstallprompt", install);
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);

  const runAction = async () => {
    if (!pending) return;
    setActionBusy(true);
    try {
      await api.action(pending);
      setToast({
        message: "Action completed successfully.",
        tone: "success",
      });
      setPending(null);
      await loadDashboard(true);
    } catch (actionError) {
      const message =
        actionError instanceof Error
          ? actionError.message
          : "The action failed";
      setToast({
        message: message.replace(/^Forbidden resource\b/i, "Forbidden action"),
        tone: "error",
      });
    } finally {
      setActionBusy(false);
      window.setTimeout(() => setToast(null), 3500);
    }
  };
  const deleteServer = async () => {
    if (!serverToDelete) return;
    setServerDeleteBusy(true);
    try {
      const wasActive = config?.activeServerId === serverToDelete.id;
      const next = await api.disconnect(serverToDelete.id);
      setConfig(next);
      if (wasActive) setData(null);
      setToast({ message: "Server removed.", tone: "success" });
      if (next.configured) setSettingsOpen(true);
    } catch (deleteError) {
      setToast({
        message:
          deleteError instanceof Error
            ? deleteError.message
            : "The server could not be removed",
        tone: "error",
      });
      setSettingsOpen(true);
    } finally {
      setServerDeleteBusy(false);
      setServerToDelete(null);
      window.setTimeout(() => setToast(null), 3500);
    }
  };

  const toggleTheme = () => {
    setLight((current) => {
      localStorage.setItem("unraid-theme", current ? "dark" : "light");
      return !current;
    });
  };

  if (!config)
    return (
      <main className="boot">
        <img src="/icon.svg" alt="Unraid" />
        <RefreshCw className="spin" size={20} />
      </main>
    );
  const editingServer = config.servers.find(
    (server) => server.id === editingServerId,
  );
  if (editingServer)
    return (
      <Setup
        server={editingServer}
        onCancel={() => setEditingServerId(null)}
        onComplete={(next) => {
          setConfig(next);
          setData(null);
          setEditingServerId(null);
          void loadDashboard();
        }}
      />
    );
  if (addingServer)
    return (
      <Setup
        onCancel={() => setAddingServer(false)}
        onComplete={(next) => {
          setConfig(next);
          setData(null);
          setAddingServer(false);
        }}
      />
    );
  if (!config.configured) return <Setup onComplete={setConfig} />;

  const containers = data?.docker.docker?.containers ?? [];
  const vms = data?.vms.vms?.domains ?? [];
  const shares = data?.shares.shares ?? [];
  const alerts = data?.notifications.notifications?.warningsAndAlerts ?? [];
  const unreadTotal =
    data?.notifications.notifications?.overview.unread.total ?? 0;

  return (
    <Localized>
      <main className={`app ${light ? "theme-light" : "theme-dark"}`}>
        <div className="ambient ambient-a" />
        <div className="ambient ambient-b" />
        <div className="app-shell">
          <aside className="sidebar glass-panel">
            <div className="brand">
              <img src="/icon.svg" alt="" />
              <div>
                <strong>Unraid</strong>
                <small>CONTROL CENTER</small>
              </div>
            </div>
            <nav aria-label="Primary navigation">
              {VALID_VIEWS.map((item) => {
                const ItemIcon = VIEW_META[item].icon;
                return (
                  <button
                    key={item}
                    className={view === item ? "active" : ""}
                    onClick={() => setView(item)}
                    title={VIEW_META[item].label}
                    aria-current={view === item ? "page" : undefined}
                  >
                    <span>
                      <ItemIcon size={19} />
                    </span>
                    {VIEW_META[item].label}
                    <i />
                  </button>
                );
              })}
            </nav>
            <div className="sidebar-foot">
              <div className="secure-note">
                <ShieldCheck size={17} />
                <span>
                  <strong>Local connection</strong>
                  <small>Encrypted & private</small>
                </span>
              </div>
            </div>
          </aside>

          <section className="workspace">
            <header className="topbar">
              <div className="top-actions glass-panel">
                <button
                  className="icon-button notification-button"
                  type="button"
                  onClick={() => setNotificationsOpen((open) => !open)}
                  aria-label="Notifications"
                  title="Notifications"
                  aria-expanded={notificationsOpen}
                >
                  <Bell size={18} />
                  {unreadTotal > 0 && (
                    <span className="notification-badge">
                      {unreadTotal > 99 ? "99+" : unreadTotal}
                    </span>
                  )}
                </button>
                <button
                  className="icon-button"
                  onClick={() => void loadDashboard(true)}
                  aria-label="Refresh"
                  title="Refresh"
                >
                  <RefreshCw className={refreshing ? "spin" : ""} size={18} />
                </button>
                <button
                  className="settings-button"
                  type="button"
                  onClick={() => setSettingsOpen(true)}
                  aria-label="Settings"
                  title="Settings"
                >
                  <Settings size={18} />
                </button>
              </div>
            </header>
            {notificationsOpen && (
              <div
                className="notification-layer"
                onMouseDown={(event) => {
                  if (event.target === event.currentTarget)
                    setNotificationsOpen(false);
                }}
              >
                <section
                  className="notification-panel glass-card"
                  role="dialog"
                  aria-modal="false"
                  aria-labelledby="notifications-title"
                >
                  <header>
                    <div>
                      <span className="eyebrow">ALERT CENTER</span>
                      <h2 id="notifications-title">Notifications</h2>
                      <small>
                        {`${unreadTotal} notification${unreadTotal === 1 ? "" : "s"}`}
                      </small>
                    </div>
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => setNotificationsOpen(false)}
                      aria-label="Close notifications"
                      title="Close notifications"
                    >
                      <X size={17} />
                    </button>
                  </header>
                  <div className="notification-list timeline">
                    {alerts.map((alert) => (
                      <article
                        key={alert.id}
                        className={`timeline-item importance-${alert.importance.toLowerCase()}`}
                      >
                        <span className="timeline-dot">
                          <AlertTriangle size={14} />
                        </span>
                        <div>
                          <strong>{alert.title}</strong>
                          <p>{alert.subject || alert.description}</p>
                          <small>
                            {alert.formattedTimestamp ??
                              alert.timestamp ??
                              "Just now"}
                          </small>
                        </div>
                        <button
                          className="icon-button"
                          type="button"
                          title="Archive"
                          aria-label={`Archive ${alert.title}`}
                          onClick={() =>
                            setPending({
                              target: "notification",
                              action: "archive",
                              id: alert.id,
                              label: alert.title,
                            })
                          }
                        >
                          <Archive size={16} />
                        </button>
                      </article>
                    ))}
                    {!alerts.length && (
                      <div className="all-clear">
                        <span>
                          <Check size={19} />
                        </span>
                        <div>
                          <strong>All clear</strong>
                          <p>No alerts need your attention.</p>
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              </div>
            )}

            <div className="content">
              {error && (
                <div className="offline-banner">
                  <CloudOff size={17} />
                  <span>
                    <strong>Offline data.</strong> {error}
                  </span>
                  <button onClick={() => void loadDashboard()}>
                    Try again
                  </button>
                </div>
              )}
              {loading && !data ? (
                <div className="skeleton-grid">
                  {Array.from({ length: 6 }, (_, index) => (
                    <div key={index} className="skeleton glass-card" />
                  ))}
                </div>
              ) : data ? (
                <>
                  {view === "dashboard" && (
                    <DashboardView
                      data={data}
                      online={browserOnline && !error}
                    />
                  )}
                  {view === "storage" && (
                    <StorageView
                      array={data.array.array}
                      error={data.array.error}
                      diskIo={data.diskIo}
                      requestAction={setPending}
                    />
                  )}
                  {view === "docker" && (
                    <DockerView
                      containers={containers}
                      stats={data.dockerStats.containers ?? []}
                      error={data.docker.error}
                      requestAction={setPending}
                    />
                  )}
                  {view === "vms" && (
                    <VmsView
                      vms={vms}
                      error={data.vms.error}
                      requestAction={setPending}
                    />
                  )}
                  {view === "shares" && (
                    <SharesView
                      shares={shares}
                      error={data.shares.error}
                      sshEnabled={Boolean(config.ssh?.enabled)}
                      sshRootPath={config.ssh?.rootPath ?? "/"}
                      serverId={config.activeServerId ?? ""}
                      onOpenSettings={() => {
                        setSettingsOpen(false);
                        setEditingServerId(config.activeServerId);
                      }}
                    />
                  )}
                  {view === "logs" && (
                    <LogsView
                      sshEnabled={Boolean(config.ssh?.enabled)}
                      onOpenSettings={() => {
                        setSettingsOpen(false);
                        setEditingServerId(config.activeServerId);
                      }}
                    />
                  )}
                </>
              ) : null}
            </div>
          </section>

          <nav
            className="mobile-nav glass-panel"
            aria-label="Mobile navigation"
          >
            {VALID_VIEWS.map((item) => {
              const ItemIcon = VIEW_META[item].icon;
              return (
                <button
                  key={item}
                  className={view === item ? "active" : ""}
                  onClick={() => setView(item)}
                  title={VIEW_META[item].label}
                >
                  <ItemIcon size={20} />
                  <span>{VIEW_META[item].label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {settingsOpen && (
          <div
            className="modal-backdrop"
            role="presentation"
            onMouseDown={(event) => {
              if (event.currentTarget === event.target) setSettingsOpen(false);
            }}
          >
            <section
              className="modal glass-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="settings-title"
            >
              <button
                className="modal-close icon-button"
                onClick={() => setSettingsOpen(false)}
                aria-label="Close"
              >
                <X size={18} />
              </button>
              <span className="eyebrow">PREFERENCES</span>
              <h2 id="settings-title">Settings</h2>
              <div className="settings-servers">
                <div className="settings-section-title">
                  <strong>Servers</strong>
                  <span>{config.servers.length}</span>
                </div>
                {config.servers.map((server) => (
                  <div
                    className={`settings-server ${server.id === config.activeServerId ? "active" : ""}`}
                    key={server.id}
                  >
                    <img src="/icon.svg" alt="" />
                    <button
                      className="server-identity"
                      onClick={() => {
                        if (server.id === config.activeServerId) return;
                        setData(null);
                        void api.activate(server.id).then(setConfig);
                      }}
                    >
                      <strong>{server.name}</strong>
                      <span>{server.baseUrl}</span>
                    </button>
                    <div className="server-actions">
                      {server.id === config.activeServerId && (
                        <Status value={error ? "OFFLINE" : "ONLINE"} />
                      )}
                      <button
                        className="icon-button"
                        aria-label={`Edit ${server.name}`}
                        title={`Edit ${server.name}`}
                        onClick={() => {
                          setSettingsOpen(false);
                          setEditingServerId(server.id);
                        }}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        className="icon-button danger"
                        aria-label={`Remove ${server.name}`}
                        title={`Remove ${server.name}`}
                        onClick={() => {
                          setSettingsOpen(false);
                          setServerToDelete(server);
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  className="button secondary add-server"
                  onClick={() => {
                    setSettingsOpen(false);
                    setAddingServer(true);
                  }}
                >
                  <Server size={16} />
                  Add server
                </button>
              </div>
              <label className="range-label">
                <div>
                  <span>Automatic refresh</span>
                  <strong>{pollSeconds} seconds</strong>
                </div>
                <input
                  type="range"
                  min="5"
                  max="60"
                  step="1"
                  value={pollSeconds}
                  onChange={(event) =>
                    setPollSeconds(Number(event.target.value))
                  }
                />
              </label>
              <label className="setting-row language-setting">
                <span className="setting-icon">
                  <Languages size={18} />
                </span>
                <div>
                  <strong>Language</strong>
                  <small translate="no">{LANGUAGE_LABELS[language]}</small>
                </div>
                <select
                  value={language}
                  onChange={(event) =>
                    setLanguage(event.target.value as Language)
                  }
                  aria-label="Language"
                >
                  {LANGUAGE_CODES.map((code) => (
                    <option value={code} key={code} translate="no">
                      {LANGUAGE_LABELS[code]}
                    </option>
                  ))}
                </select>
              </label>
              <button className="setting-row" onClick={toggleTheme}>
                <span className="setting-icon">
                  {light ? <Moon size={18} /> : <Sun size={18} />}
                </span>
                <div>
                  <strong>Appearance</strong>
                  <small>{light ? "Light theme" : "Dark theme"}</small>
                </div>
                <ChevronRight size={17} />
              </button>
              {installPrompt && (
                <button
                  className="setting-row"
                  onClick={() =>
                    void installPrompt
                      .prompt()
                      .then(() => setInstallPrompt(null))
                  }
                >
                  <span className="setting-icon">
                    <Download size={18} />
                  </span>
                  <div>
                    <strong>Install Unraid</strong>
                    <small>Add the app to this device</small>
                  </div>
                  <ChevronRight size={17} />
                </button>
              )}
              <button
                className="setting-row logout-setting"
                onClick={() => {
                  void onLogout().catch((logoutError) => {
                    setToast({
                      message:
                        logoutError instanceof Error
                          ? logoutError.message
                          : "Could not log out",
                      tone: "error",
                    });
                    window.setTimeout(() => setToast(null), 3500);
                  });
                }}
              >
                <span className="setting-icon">
                  <LogOut size={18} />
                </span>
                <div>
                  <strong>Log out</strong>
                  <small>End this local session</small>
                </div>
                <ChevronRight size={17} />
              </button>
              <div className="settings-security">
                <ShieldCheck size={19} />
                <div>
                  <strong>Secrets encrypted on this server</strong>
                  <small>No API key is ever sent to the browser.</small>
                </div>
              </div>
              <footer className="settings-version">
                <img src="/icon.svg" alt="" />
                <div>
                  <span>Unraid Control</span>
                  <small>
                    Version <b>{packageInfo.version}</b>
                  </small>
                </div>
              </footer>
            </section>
          </div>
        )}

        {serverToDelete && (
          <div className="modal-backdrop">
            <section
              className="modal confirm-modal glass-card"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="delete-server-title"
            >
              <span className="confirm-icon is-danger">
                <Trash2 size={24} />
              </span>
              <h2 id="delete-server-title">Delete server</h2>
              <p>
                Do you really want to delete{" "}
                <strong>{serverToDelete.name}</strong>? Its encrypted
                credentials will be permanently removed.
              </p>
              <div className="modal-actions">
                <button
                  className="button secondary"
                  onClick={() => {
                    setServerToDelete(null);
                    setSettingsOpen(true);
                  }}
                  disabled={serverDeleteBusy}
                >
                  Cancel
                </button>
                <button
                  className="button danger-button"
                  onClick={() => void deleteServer()}
                  disabled={serverDeleteBusy}
                >
                  {serverDeleteBusy && <RefreshCw className="spin" size={16} />}
                  Delete
                </button>
              </div>
            </section>
          </div>
        )}

        {pending && (
          <div className="modal-backdrop">
            <section
              className="modal confirm-modal glass-card"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="confirm-title"
            >
              <span
                className={`confirm-icon ${pending.dangerous ? "is-danger" : ""}`}
              >
                {pending.dangerous ? (
                  <AlertTriangle size={24} />
                ) : (
                  <Zap size={24} />
                )}
              </span>
              <h2 id="confirm-title">Confirm action</h2>
              <p>
                Do you really want to <strong>{pending.action}</strong>{" "}
                {pending.label} ?
              </p>
              <div className="modal-actions">
                <button
                  className="button secondary"
                  onClick={() => setPending(null)}
                  disabled={actionBusy}
                >
                  Cancel
                </button>
                <button
                  className={`button ${pending.dangerous ? "danger-button" : "primary"}`}
                  onClick={() => void runAction()}
                  disabled={actionBusy}
                >
                  {actionBusy && <RefreshCw className="spin" size={16} />}
                  Confirm
                </button>
              </div>
            </section>
          </div>
        )}
        {toast && (
          <div className={`toast toast-${toast.tone}`} role="status">
            {toast.tone === "error" ? (
              <AlertTriangle size={17} />
            ) : (
              <Check size={17} />
            )}
            {toast.message}
          </div>
        )}
      </main>
    </Localized>
  );
}

async function clearPrivateCaches() {
  if (!("caches" in window)) return;
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name === "unraid-last-dashboard")
      .map((name) => caches.delete(name)),
  );
}

function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const requireAuthentication = useCallback(() => {
    setAuth({ authenticated: false });
    void clearPrivateCaches();
  }, []);

  useEffect(() => {
    void api
      .authStatus()
      .then(setAuth)
      .catch((statusError) => {
        setAuthError(
          statusError instanceof Error
            ? statusError.message
            : "API unavailable",
        );
        requireAuthentication();
      });
  }, [requireAuthentication]);

  useEffect(() => {
    window.addEventListener(AUTH_REQUIRED_EVENT, requireAuthentication);
    return () =>
      window.removeEventListener(AUTH_REQUIRED_EVENT, requireAuthentication);
  }, [requireAuthentication]);

  if (!auth) {
    return (
      <main className="boot">
        <img src="/icon.svg" alt="Unraid" />
        <RefreshCw className="spin" size={20} />
      </main>
    );
  }

  if (!auth.authenticated) {
    return (
      <LoginScreen
        busy={authBusy}
        error={authError}
        onLogin={async (password) => {
          setAuthBusy(true);
          setAuthError(null);
          try {
            setAuth(await api.login(password));
          } catch (loginError) {
            setAuthError(
              loginError instanceof Error
                ? loginError.message
                : "Authentication failed",
            );
          } finally {
            setAuthBusy(false);
          }
        }}
      />
    );
  }

  return (
    <ControlApp
      onLogout={async () => {
        await api.logout();
        requireAuthentication();
      }}
    />
  );
}

export default App;
