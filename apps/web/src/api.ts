import type {
  Dashboard,
  FileListing,
  LogSnapshot,
  PendingAction,
  ServerConfig,
  ServerLogSource,
  ServerLogSourceOption,
  SshSettingsInput,
  SshTestResult,
} from "./types";

export const AUTH_REQUIRED_EVENT = "unraid-auth-required";

export type AuthStatus = {
  authenticated: boolean;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: init?.body
      ? { "content-type": "application/json", ...init.headers }
      : init?.headers,
  });
  if (!response.ok) {
    const payload = (await response
      .json()
      .catch(() => ({ error: `HTTP ${response.status}` }))) as {
      error?: string;
    };
    if (response.status === 401 && !path.startsWith("/api/auth/")) {
      window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    }
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

type ServerPayload = {
  name: string;
  baseUrl: string;
  apiKey?: string;
  allowSelfSigned: boolean;
  ssh?: SshSettingsInput;
};

export const api = {
  authStatus: () => request<AuthStatus>("/api/auth/status"),
  login: (password: string) =>
    request<AuthStatus>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  logout: () =>
    request<void>("/api/auth/logout", {
      method: "POST",
    }),
  config: () => request<ServerConfig>("/api/config"),
  dashboard: () => request<Dashboard>("/api/dashboard"),
  test: (config: ServerPayload, serverId?: string) =>
    request<{ ok: true; hostname?: string }>("/api/config/test", {
      method: "POST",
      body: JSON.stringify({ ...config, serverId }),
    }),
  save: (config: ServerPayload & { apiKey: string }) =>
    request<ServerConfig>("/api/config", {
      method: "POST",
      body: JSON.stringify(config),
    }),
  activate: (id: string) =>
    request<ServerConfig>("/api/config/active", {
      method: "PATCH",
      body: JSON.stringify({ id }),
    }),
  update: (id: string, config: ServerPayload) =>
    request<ServerConfig>(`/api/config/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(config),
    }),
  disconnect: (id: string) =>
    request<ServerConfig>(`/api/config/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  testSsh: (config: SshSettingsInput, serverId?: string) =>
    request<SshTestResult>("/api/ssh/test", {
      method: "POST",
      body: JSON.stringify({ ...config, serverId }),
    }),
  files: (path: string, page = 1, pageSize = 10) =>
    request<FileListing>(
      `/api/files?path=${encodeURIComponent(path)}&page=${page}&pageSize=${pageSize}`,
    ),
  createFolder: (path: string) =>
    request<{ ok: true }>("/api/files/folder", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  renameFile: (from: string, to: string) =>
    request<{ ok: true }>("/api/files", {
      method: "PATCH",
      body: JSON.stringify({ from, to }),
    }),
  deleteFile: (path: string) =>
    request<{ ok: true }>(`/api/files?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    }),
  uploadFile: (path: string, file: File) =>
    request<{ ok: true }>(
      `/api/files/upload?path=${encodeURIComponent(path)}`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: file,
      },
    ),
  downloadUrl: (path: string) =>
    `/api/files/download?path=${encodeURIComponent(path)}`,
  serverLogSources: () =>
    request<ServerLogSourceOption[]>("/api/logs/server/sources"),
  serverLogs: (lines = 250, source: ServerLogSource = "system") =>
    request<LogSnapshot>(
      `/api/logs/server?lines=${lines}&source=${encodeURIComponent(source)}`,
    ),
  dockerLogs: (containerId: string, lines = 250) =>
    request<LogSnapshot>(
      `/api/logs/docker/${encodeURIComponent(containerId)}?lines=${lines}`,
    ),
  vmIconUrl: (vmId: string) => `/api/vms/${encodeURIComponent(vmId)}/icon`,
  action: (action: PendingAction) =>
    request<{ ok: true }>("/api/action", {
      method: "POST",
      body: JSON.stringify({
        target: action.target,
        action: action.action,
        id: action.id,
      }),
    }),
};
