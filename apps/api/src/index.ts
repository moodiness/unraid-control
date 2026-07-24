import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { Agent, request } from "undici";
import { z } from "zod";
import { calculateDiskIoRates } from "./diskIo.js";
import {
  completeSshConfig,
  createFolder,
  deleteFile,
  downloadFile,
  listFiles,
  listServerLogSources,
  readDockerStats,
  readDiskIoCounters,
  readDockerLogs,
  readServerLogs,
  readVmIcon,
  SERVER_LOG_SOURCE_IDS,
  renameFile,
  SshConfigInput,
  testSsh,
  uploadFile,
  type SshConfig,
} from "./sshFiles.js";
import {
  INTROSPECTION_QUERY,
  adaptQueryToSchema,
  removeUnavailableCapabilities,
  schemaFromIntrospection,
  schemaFromSdl,
  type SchemaSnapshot,
  type SchemaIntrospection,
} from "./graphqlSchema.js";
import {
  AUTH_COOKIE_NAME,
  AUTH_SESSION_TTL_MS,
  createLocalAuth,
} from "./localAuth.js";

const port = Number(process.env.PORT ?? 3001);
const dataDir = resolve(process.env.DATA_DIR ?? join(process.cwd(), "data"));
const configFile = join(dataDir, "server.enc.json");
const keyFile = join(dataDir, ".array-key");
const auditFile = join(dataDir, "audit.log");
const webDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../web/dist",
);
const localAuth = createLocalAuth(process.env.LOCAL_AUTH_PASSWORD ?? "");

const ServerInput = z.object({
  name: z.string().trim().min(1).max(48),
  baseUrl: z
    .string()
    .url()
    .refine(
      (value) => ["http:", "https:"].includes(new URL(value).protocol),
      "HTTP(S) URL required",
    ),
  apiKey: z.string().trim().min(8).max(512),
  allowSelfSigned: z.boolean().default(false),
  ssh: SshConfigInput.optional(),
});
const ServerUpdateInput = ServerInput.extend({
  apiKey: ServerInput.shape.apiKey.optional(),
});

type ServerConfig = z.infer<typeof ServerInput>;
type StoredServer = ServerConfig & { id: string };
type ServerStore = {
  version: 1;
  activeServerId: string | null;
  servers: StoredServer[];
};
type JsonRecord = Record<string, unknown>;
type EncryptedEnvelope = { iv: string; tag: string; ciphertext: string };

const normalizeBaseUrl = (value: string) =>
  value
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/graphql$/, "");
const endpointFor = (config: ServerConfig) =>
  `${normalizeBaseUrl(config.baseUrl)}/graphql`;

async function encryptionKey(): Promise<Buffer> {
  await mkdir(dataDir, { recursive: true });
  const fromEnv = process.env.ARRAY_ENCRYPTION_KEY?.trim();
  if (fromEnv) {
    const decoded = Buffer.from(
      fromEnv,
      /^[a-f\d]{64}$/i.test(fromEnv) ? "hex" : "base64",
    );
    if (decoded.length !== 32)
      throw new Error("ARRAY_ENCRYPTION_KEY must encode exactly 32 bytes");
    return decoded;
  }
  if (existsSync(keyFile))
    return Buffer.from((await readFile(keyFile, "utf8")).trim(), "base64");
  const key = randomBytes(32);
  await writeFile(keyFile, key.toString("base64"), { mode: 0o600 });
  return key;
}

async function saveStore(store: ServerStore) {
  const key = await encryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(store)),
    cipher.final(),
  ]);
  const envelope: EncryptedEnvelope = {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  await writeFile(configFile, JSON.stringify(envelope), { mode: 0o600 });
}

async function loadStore(): Promise<ServerStore> {
  if (!existsSync(configFile))
    return { version: 1, activeServerId: null, servers: [] };
  const envelope = JSON.parse(
    await readFile(configFile, "utf8"),
  ) as EncryptedEnvelope;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    await encryptionKey(),
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const store = JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8"),
  ) as ServerStore;
  return {
    version: 1,
    activeServerId: store.activeServerId,
    servers: store.servers.map((server) => ({
      ...ServerInput.parse(server),
      id: z.string().uuid().parse(server.id),
    })),
  };
}

const agents = new Map<boolean, Agent>();
function dispatcher(allowSelfSigned: boolean) {
  let agent = agents.get(allowSelfSigned);
  if (!agent) {
    agent = new Agent({ connect: { rejectUnauthorized: !allowSelfSigned } });
    agents.set(allowSelfSigned, agent);
  }
  return agent;
}

function unraidConnectionError(error: unknown): Error {
  const detail = error as {
    code?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  const code = detail.code ?? detail.cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN")
    return new Error(
      "Unraid host cannot be resolved from Docker. Use the local IP address instead of a .local name.",
    );
  if (code === "ECONNREFUSED")
    return new Error(
      "Connection refused. Use the same host and port as the Unraid WebGUI, and check that the API is enabled.",
    );
  if (
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "CERT_HAS_EXPIRED"
  )
    return new Error(
      "TLS certificate rejected. Enable the self-signed certificate option.",
    );
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ABORT_ERR")
    return new Error(
      "Connection timed out. Check the Unraid WebGUI address and Docker network access.",
    );
  return new Error(
    `Unable to reach Unraid: ${detail.cause?.message ?? detail.message ?? "unknown connection error"}`,
  );
}

async function graphQL<T = JsonRecord>(
  config: ServerConfig,
  query: string,
  variables: JsonRecord = {},
): Promise<T> {
  let response;
  try {
    response = await request(endpointFor(config), {
      method: "POST",
      dispatcher: dispatcher(config.allowSelfSigned),
      signal: AbortSignal.timeout(12_000),
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (error) {
    throw unraidConnectionError(error);
  }
  const payload = (await response.body.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (payload.errors?.length)
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  if (response.statusCode < 200 || response.statusCode >= 300)
    throw new Error(`Unraid returned HTTP ${response.statusCode}`);
  if (!payload.data) throw new Error("Unraid returned no data");
  return payload.data;
}

const QUERIES = {
  system: `query System { info { time cpu { brand manufacturer cores threads speed } os { hostname distro release kernel arch uptime } system { manufacturer model } versions { core { unraid } } } metrics { cpu { percentTotal } memory { total used free available active buffcache percentTotal swapTotal swapUsed swapFree percentSwapTotal } } }`,
  hardware: `query Hardware { info { cpu { vendor family model stepping revision voltage speedmin speedmax processors socket packages { totalPower power temp } } baseboard { manufacturer model version memMax memSlots } memory { layout { size bank type clockSpeed manufacturer formFactor } } system { version virtual } versions { core { unraid api kernel } packages { openssl node npm pm2 git nginx php docker } } devices { gpu { id vendorname } network { id iface model vendor mac virtual speed dhcp } pci { id vendorname productname } usb { id name bus device } } } }`,
  network: `query Network { network { accessUrls { type name ipv4 ipv6 } } }`,
  networkInfo: `query NetworkInfo { info { networkInterfaces { id name description macAddress mtu speed duplex internal virtual operstate type vlanId ipv4Addresses { address netmask } ipv6Addresses { address prefixLength } status protocol ipAddress netmask gateway useDhcp ipv6Address ipv6Netmask ipv6Gateway useDhcp6 } primaryNetwork { id name description macAddress mtu speed duplex internal virtual operstate type vlanId ipv4Addresses { address netmask } ipv6Addresses { address prefixLength } status protocol ipAddress netmask gateway useDhcp ipv6Address ipv6Netmask ipv6Gateway useDhcp6 } } }`,
  telemetry: `query Telemetry { metrics { network { id name operstate bytesReceived bytesSent packetsReceived packetsSent receiveErrors transmitErrors receiveDropped transmitDropped rxSec txSec utilizationPercent lastUpdated } temperature { sensors { id name type location current { value unit timestamp status } min { value unit timestamp status } max { value unit timestamp status } warning critical } } } }`,
  registration: `query Registration { registration { type state expiration updateExpiration } }`,
  array: `query Storage { array { state capacity { kilobytes { free used total } disks { free used total } } parityCheckStatus { date duration speed status errors progress correcting paused running } boot { id idx name device size status rotational temp numErrors fsSize fsFree fsUsed type fsType transport isSpinning } parities { id idx name device size status rotational temp numErrors fsSize fsFree fsUsed type fsType transport isSpinning } disks { id idx name device size status rotational temp numErrors fsSize fsFree fsUsed type fsType transport isSpinning } caches { id idx name device size status rotational temp numErrors fsSize fsFree fsUsed type fsType transport isSpinning } } }`,
  docker: `query Containers { docker { containers { id names image imageId command created ports { ip privatePort publicPort type } templatePorts { ip privatePort publicPort type } lanIpPorts sizeRootFs sizeRw sizeLog labels state status hostConfig { networkMode } networkSettings mounts autoStart autoStartOrder autoStartWait projectUrl iconUrl webUiUrl isOrphaned isUpdateAvailable } } }`,
  vms: `query VirtualMachines { vms { domains { id name state } } }`,
  shares: `query Shares { shares { id name free used size include exclude cache comment allocator } }`,
  notifications: `query Alerts { notifications { overview { unread { info warning alert total } archive { info warning alert total } } warningsAndAlerts { id title subject description importance link type timestamp formattedTimestamp } } }`,
} as const;
type QueryKey = keyof typeof QUERIES;
type CompatibleQueries = Record<QueryKey, string | null>;
type SchemaCapabilities = {
  endpoint: string;
  expires: number;
  fetchedAt: string;
  adaptive: boolean;
  source: "server" | "official" | "static";
  queries: CompatibleQueries;
  schema?: SchemaSnapshot;
  schemaRef?: string;
  version?: string;
  warning?: string;
  error?: string;
};

const schemaCapabilitiesCache = new Map<string, SchemaCapabilities>();
const SCHEMA_CACHE_TTL = 6 * 60 * 60_000;
const SCHEMA_FAILURE_TTL = 5 * 60_000;
const officialSchemaOverride =
  process.env.UNRAID_SCHEMA_URL?.trim() || undefined;
const officialSchemaCache = new Map<
  string,
  { expires: number; source: string }
>();

function staticQueries(): CompatibleQueries {
  return { ...QUERIES };
}

function compatibleQueries(schema: SchemaSnapshot): CompatibleQueries {
  return Object.fromEntries(
    (Object.entries(QUERIES) as Array<[QueryKey, string]>).map(
      ([key, query]) => [key, adaptQueryToSchema(query, schema)],
    ),
  ) as CompatibleQueries;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}

async function serverApiVersion(config: StoredServer) {
  try {
    const data = await graphQL<{
      info?: { versions?: { core?: { api?: string } } };
    }>(config, `query ApiVersion { info { versions { core { api } } } }`);
    return data.info?.versions?.core?.api?.match(/\d+\.\d+\.\d+/)?.[0];
  } catch {
    return undefined;
  }
}

function officialSchemaLocation(ref: string) {
  return (
    officialSchemaOverride ??
    `https://raw.githubusercontent.com/unraid/api/${ref}/api/generated-schema.graphql`
  );
}

async function fetchOfficialSchema(ref: string) {
  const location = officialSchemaLocation(ref);
  const cached = officialSchemaCache.get(location);
  if (cached && cached.expires > Date.now()) {
    return schemaFromSdl(cached.source);
  }
  const response = await request(location, {
    method: "GET",
    signal: AbortSignal.timeout(10_000),
    headers: { "user-agent": "unraid-control" },
  });
  const source = await response.body.text();
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Official schema returned HTTP ${response.statusCode}`);
  }
  officialSchemaCache.set(location, {
    expires: Date.now() + SCHEMA_CACHE_TTL,
    source,
  });
  return schemaFromSdl(source);
}

async function officialSchema(apiVersion?: string) {
  if (officialSchemaOverride) {
    return { schema: await fetchOfficialSchema("custom"), ref: "custom" };
  }
  if (apiVersion) {
    try {
      return {
        schema: await fetchOfficialSchema(`v${apiVersion}`),
        ref: `v${apiVersion}`,
      };
    } catch {
      // A development API build may not have a matching tag yet.
    }
  }
  return { schema: await fetchOfficialSchema("main"), ref: "main" };
}

async function schemaCapabilities(
  config: StoredServer,
): Promise<SchemaCapabilities> {
  const endpoint = endpointFor(config);
  const cached = schemaCapabilitiesCache.get(config.id);
  if (cached && cached.endpoint === endpoint && cached.expires > Date.now()) {
    return cached;
  }

  const fetchedAt = new Date().toISOString();
  let introspectionError: unknown;
  try {
    const introspection = await graphQL<SchemaIntrospection>(
      config,
      INTROSPECTION_QUERY,
    );
    const schema = schemaFromIntrospection(introspection);
    const value: SchemaCapabilities = {
      endpoint,
      expires: Date.now() + SCHEMA_CACHE_TTL,
      fetchedAt,
      adaptive: true,
      source: "server",
      queries: compatibleQueries(schema),
      schema,
      schemaRef: "runtime",
      version: cached?.version,
    };
    schemaCapabilitiesCache.set(config.id, value);
    return value;
  } catch (error) {
    introspectionError = error;
  }

  try {
    const apiVersion = await serverApiVersion(config);
    const official = await officialSchema(apiVersion);
    const value: SchemaCapabilities = {
      endpoint,
      expires: Date.now() + SCHEMA_CACHE_TTL,
      fetchedAt,
      adaptive: true,
      source: "official",
      queries: compatibleQueries(official.schema),
      schema: official.schema,
      schemaRef: official.ref,
      version: cached?.version,
      warning: `NAS introspection unavailable: ${errorText(introspectionError)}`,
    };
    schemaCapabilitiesCache.set(config.id, value);
    return value;
  } catch (officialError) {
    const value: SchemaCapabilities = {
      endpoint,
      expires: Date.now() + SCHEMA_FAILURE_TTL,
      fetchedAt,
      adaptive: false,
      source: "static",
      queries: staticQueries(),
      version: cached?.version,
      error: `Schema discovery failed: ${errorText(introspectionError)}; ${errorText(officialError)}`,
    };
    schemaCapabilitiesCache.set(config.id, value);
    return value;
  }
}
async function runCompatibleQuery(
  config: StoredServer,
  key: QueryKey,
  capabilities: SchemaCapabilities,
): Promise<JsonRecord> {
  let query = capabilities.queries[key];
  if (!query) return { unsupported: true };
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await graphQL(config, query);
    } catch (error) {
      if (
        !capabilities.schema ||
        !removeUnavailableCapabilities(capabilities.schema, errorText(error))
      ) {
        throw error;
      }
      query = adaptQueryToSchema(QUERIES[key], capabilities.schema);
      capabilities.queries[key] = query;
      if (!query) return { unsupported: true };
    }
  }
  throw new Error("GraphQL schema changed repeatedly while querying the NAS");
}

function schemaVersionFrom(sections: JsonRecord) {
  const hardware = sections.hardware as
    | {
        info?: {
          versions?: {
            core?: { unraid?: unknown; api?: unknown };
          };
        };
      }
    | undefined;
  const system = sections.system as
    { info?: { versions?: { core?: { unraid?: unknown } } } } | undefined;
  const unraid =
    hardware?.info?.versions?.core?.unraid ??
    system?.info?.versions?.core?.unraid;
  const api = hardware?.info?.versions?.core?.api;
  const values = [unraid, api]
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map(String);
  return values.length ? values.join("|") : undefined;
}

function refreshSchemaWhenVersionChanges(
  config: StoredServer,
  sections: JsonRecord,
) {
  const cached = schemaCapabilitiesCache.get(config.id);
  const version = schemaVersionFrom(sections);
  if (!cached || !version) return;
  if (cached.version && cached.version !== version) cached.expires = 0;
  cached.version = version;
}

let dashboardCache: {
  serverId: string;
  expires: number;
  value: JsonRecord;
} | null = null;
let publicIpCache:
  { expires: number; value: { address?: string; error?: string } } | undefined;
const dockerStatsCache = new Map<
  string,
  {
    expires: number;
    value: {
      containers?: Awaited<ReturnType<typeof readDockerStats>>;
      error?: string;
    };
  }
>();
const diskIoSamples = new Map<
  string,
  {
    sampledAt: number;
    counters: Awaited<ReturnType<typeof readDiskIoCounters>>;
  }
>();

async function diskIo(config: StoredServer) {
  if (!config.ssh?.enabled) {
    return { error: "SSH is required for live disk statistics" };
  }
  try {
    const counters = await readDiskIoCounters(config.ssh);
    const sampledAt = Date.now();
    const previous = diskIoSamples.get(config.id);
    const sampleDurationMs = previous
      ? sampledAt - previous.sampledAt
      : undefined;
    const devices = calculateDiskIoRates(
      previous?.counters,
      counters,
      sampleDurationMs ?? 0,
    );
    diskIoSamples.set(config.id, { sampledAt, counters });
    return {
      sampledAt: new Date(sampledAt).toISOString(),
      sampleDurationMs,
      devices,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unavailable",
    };
  }
}

async function dockerStats(config: StoredServer) {
  const cached = dockerStatsCache.get(config.id);
  if (cached && cached.expires > Date.now()) return cached.value;
  if (!config.ssh?.enabled) {
    return { error: "SSH is required for live container statistics" };
  }
  try {
    const value = { containers: await readDockerStats(config.ssh) };
    dockerStatsCache.set(config.id, {
      expires: Date.now() + 5_000,
      value,
    });
    return value;
  } catch (error) {
    const value = {
      error: error instanceof Error ? error.message : "Unavailable",
    };
    dockerStatsCache.set(config.id, {
      expires: Date.now() + 15_000,
      value,
    });
    return value;
  }
}

async function publicInternetAddress() {
  if (publicIpCache && publicIpCache.expires > Date.now()) {
    return publicIpCache.value;
  }
  try {
    const response = await request("https://api.ipify.org?format=json", {
      headersTimeout: 3_000,
      bodyTimeout: 3_000,
    });
    if (response.statusCode !== 200) {
      throw new Error(`Public IP service returned HTTP ${response.statusCode}`);
    }
    const payload = (await response.body.json()) as { ip?: string };
    if (!payload.ip || !isIP(payload.ip)) {
      throw new Error("Public IP service returned an invalid address");
    }
    const value = { address: payload.ip };
    publicIpCache = { expires: Date.now() + 10 * 60_000, value };
    return value;
  } catch (error) {
    const value = {
      error: error instanceof Error ? error.message : "Unavailable",
    };
    publicIpCache = { expires: Date.now() + 60_000, value };
    return value;
  }
}

async function dashboard(config: StoredServer): Promise<JsonRecord> {
  if (
    dashboardCache?.serverId === config.id &&
    dashboardCache.expires > Date.now()
  )
    return dashboardCache.value;
  const publicIpPromise = publicInternetAddress();
  const dockerStatsPromise = dockerStats(config);
  const diskIoPromise = diskIo(config);
  const capabilities = await schemaCapabilities(config);
  const entries = await Promise.all(
    (Object.keys(QUERIES) as QueryKey[]).map(async (key) => {
      try {
        return [
          key,
          await runCompatibleQuery(config, key, capabilities),
        ] as const;
      } catch (error) {
        return [
          key,
          { error: error instanceof Error ? error.message : "Unavailable" },
        ] as const;
      }
    }),
  );
  const sections = Object.fromEntries(entries) as JsonRecord;
  refreshSchemaWhenVersionChanges(config, sections);
  const value: JsonRecord = {
    fetchedAt: new Date().toISOString(),
    server: {
      id: config.id,
      name: config.name,
      baseUrl: normalizeBaseUrl(config.baseUrl),
    },
    ...sections,
    publicIp: await publicIpPromise,
    dockerStats: await dockerStatsPromise,
    diskIo: await diskIoPromise,
    graphqlSchema: {
      adaptive: capabilities.adaptive,
      source: capabilities.source,
      schemaRef: capabilities.schemaRef,
      fetchedAt: capabilities.fetchedAt,
      expiresAt: new Date(capabilities.expires).toISOString(),
      version: capabilities.version,
      error: capabilities.error,
      warning: capabilities.warning,
    },
  };
  dashboardCache = { serverId: config.id, expires: Date.now() + 3_000, value };
  return value;
}

const dockerActions: Record<string, true> = {
  start: true,
  stop: true,
  pause: true,
  unpause: true,
  restart: true,
};
const vmActions: Record<string, true> = {
  start: true,
  stop: true,
  pause: true,
  resume: true,
  forceStop: true,
  reboot: true,
  reset: true,
};
const arrayActions: Record<string, true> = { start: true, stop: true };
const ActionInput = z.object({
  target: z.enum(["docker", "vm", "array", "notification"]),
  action: z.string().min(1).max(32),
  id: z.string().min(1).max(256).optional(),
});

async function runAction(
  config: StoredServer,
  input: z.infer<typeof ActionInput>,
) {
  const id = input.id;
  if (input.target === "docker") {
    if (!id || !dockerActions[input.action])
      throw new Error("Unsupported Docker action");
    const mutate = (action: string) =>
      graphQL(
        config,
        `mutation DockerAction($id: PrefixedID!) { docker { ${action}(id: $id) { id state status } } }`,
        { id },
      );
    if (input.action === "restart") {
      await mutate("stop");
      return mutate("start");
    }
    return mutate(input.action);
  }
  if (input.target === "vm") {
    if (!id || !vmActions[input.action])
      throw new Error("Unsupported VM action");
    return graphQL(
      config,
      `mutation VmAction($id: PrefixedID!) { vm { ${input.action}(id: $id) } }`,
      { id },
    );
  }
  if (input.target === "array") {
    if (!arrayActions[input.action])
      throw new Error("Unsupported array action");
    const desiredState = input.action === "start" ? "START" : "STOP";
    return graphQL(
      config,
      `mutation ArrayAction { array { setState(input: { desiredState: ${desiredState} }) { state } } }`,
    );
  }
  if (!id || input.action !== "archive")
    throw new Error("Unsupported notification action");
  return graphQL(
    config,
    `mutation Archive($id: PrefixedID!) { archiveNotification(id: $id) { id type } }`,
    { id },
  );
}

const app = express();
app.set("trust proxy", process.env.TRUST_PROXY === "true" ? 1 : false);
app.disable("x-powered-by");
app.use(
  helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }),
);
app.use(express.json({ limit: "32kb", type: "application/json" }));

function sameOrigin(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("sec-fetch-site") === "cross-site")
    return res.status(403).json({ error: "Cross-site request rejected" });
  const origin = req.get("origin");
  if (origin && new URL(origin).host !== req.get("host"))
    return res.status(403).json({ error: "Origin rejected" });
  next();
}
app.use("/api", sameOrigin);

const writeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const logLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});
const asyncRoute =
  (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    void handler(req, res).catch(next);

function publicSsh(ssh: SshConfig | undefined) {
  if (!ssh) return undefined;
  return {
    enabled: ssh.enabled,
    host: ssh.host,
    port: ssh.port,
    username: ssh.username,
    authType: ssh.authType,
    rootPath: ssh.rootPath,
    hostFingerprint: ssh.hostFingerprint,
    configured: Boolean(
      ssh.enabled &&
      ssh.hostFingerprint &&
      (ssh.authType === "password" ? ssh.password : ssh.privateKey),
    ),
  };
}

function publicConfig(store: ServerStore) {
  const active =
    store.servers.find((server) => server.id === store.activeServerId) ?? null;
  return {
    configured: Boolean(active),
    activeServerId: active?.id ?? null,
    name: active?.name,
    baseUrl: active ? normalizeBaseUrl(active.baseUrl) : undefined,
    allowSelfSigned: active?.allowSelfSigned,
    ssh: publicSsh(active?.ssh),
    servers: store.servers.map(
      ({ id, name, baseUrl, allowSelfSigned, ssh }) => ({
        id,
        name,
        baseUrl: normalizeBaseUrl(baseUrl),
        allowSelfSigned,
        ssh: publicSsh(ssh),
      }),
    ),
  };
}

const FilePathInput = z.string().min(1).max(2_048);
const FileRenameInput = z.object({
  from: FilePathInput,
  to: FilePathInput,
});
const FilePageInput = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(10),
});
const SshTestInput = SshConfigInput.extend({
  serverId: z.string().uuid().optional(),
});
const LogQueryInput = z.object({
  lines: z.coerce.number().int().min(1).max(10_000).default(250),
});
const ServerLogQueryInput = LogQueryInput.extend({
  source: z.enum(SERVER_LOG_SOURCE_IDS).default("system"),
});
const ContainerLogParams = z.object({
  id: z
    .string()
    .regex(/^(?:[a-f0-9]{12,64}:)?[a-f0-9]{12,64}$/i, "Invalid container ID")
    .transform((id) => id.slice(id.lastIndexOf(":") + 1)),
});
const VmIconParams = z.object({
  id: z
    .string()
    .transform((id) => id.slice(id.lastIndexOf(":") + 1))
    .pipe(
      z
        .string()
        .regex(
          /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i,
          "Invalid VM ID",
        ),
    ),
});
const maxUploadBytes = Number(
  process.env.MAX_UPLOAD_BYTES ?? 2 * 1_024 * 1_024 * 1_024,
);

async function activeSsh() {
  const store = await loadStore();
  const server = store.servers.find(
    (candidate) => candidate.id === store.activeServerId,
  );
  if (!server) throw new Error("Setup required");
  if (!server.ssh?.enabled)
    throw new Error("Configure SSH file access for this server first");
  return { serverId: server.id, ssh: server.ssh };
}

async function auditFileAction(serverId: string, action: string, path: string) {
  await appendFile(
    auditFile,
    `${JSON.stringify({ at: new Date().toISOString(), serverId, target: "files", action, path })}\n`,
  );
}

const LoginInput = z.object({
  password: z.string().min(1).max(1_024),
});

function cookieValue(req: Request, name: string) {
  const prefix = `${name}=`;
  const encoded = req
    .get("cookie")
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

function hasValidSession(req: Request) {
  return localAuth.verifySession(cookieValue(req, AUTH_COOKIE_NAME));
}

function authCookieOptions(req: Request) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: req.secure,
    path: "/",
  };
}

function requireLocalAuth(req: Request, res: Response, next: NextFunction) {
  if (hasValidSession(req)) return next();
  res.set("cache-control", "no-store");
  res.status(401).json({ error: "Authentication required" });
}

app.get("/api/auth/status", (req, res) => {
  res.set("cache-control", "no-store");
  res.json({ authenticated: hasValidSession(req) });
});
app.post("/api/auth/login", authLimiter, (req, res) => {
  const { password } = LoginInput.parse(req.body);
  if (!localAuth.verifyPassword(password)) {
    res.set("cache-control", "no-store");
    res.status(401).json({ error: "Invalid password" });
    return;
  }
  res.cookie(AUTH_COOKIE_NAME, localAuth.createSession(), {
    ...authCookieOptions(req),
    maxAge: AUTH_SESSION_TTL_MS,
  });
  res.set("cache-control", "no-store");
  res.json({ authenticated: true });
});
app.post("/api/auth/logout", (req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, authCookieOptions(req));
  res.set("cache-control", "no-store");
  res.status(204).end();
});

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api", requireLocalAuth);
app.get(
  "/api/config",
  asyncRoute(async (_req, res) => {
    res.json(publicConfig(await loadStore()));
  }),
);
app.post(
  "/api/config/test",
  writeLimiter,
  asyncRoute(async (req, res) => {
    const config = ServerInput.parse(req.body);
    const data = await graphQL<{ info: { os: { hostname: string | null } } }>(
      config,
      `query Test { info { os { hostname } } }`,
    );
    res.json({ ok: true, hostname: data.info.os.hostname });
  }),
);
app.post(
  "/api/ssh/test",
  writeLimiter,
  asyncRoute(async (req, res) => {
    const { serverId, ...input } = SshTestInput.parse(req.body);
    const store = serverId ? await loadStore() : undefined;
    const current = store?.servers.find(
      (server) => server.id === serverId,
    )?.ssh;
    const config: SshConfig = {
      ...input,
      password: input.password || current?.password,
      privateKey: input.privateKey || current?.privateKey,
      passphrase: input.passphrase || current?.passphrase,
    };
    if (config.authType === "password" && !config.password)
      throw new Error("An SSH password is required");
    if (config.authType === "privateKey" && !config.privateKey)
      throw new Error("An SSH private key is required");
    const result = await testSsh(config);
    res.json({ ok: true, fingerprint: result.fingerprint });
  }),
);
app.post(
  "/api/config",
  writeLimiter,
  asyncRoute(async (req, res) => {
    const input = ServerInput.parse(req.body);
    const config = {
      ...input,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      ssh: completeSshConfig(input.ssh),
    };
    await graphQL(config, `query Test { online }`);
    const store = await loadStore();
    if (
      store.servers.some(
        (server) => normalizeBaseUrl(server.baseUrl) === config.baseUrl,
      )
    ) {
      return void res
        .status(409)
        .json({ error: "This server is already configured" });
    }
    const server: StoredServer = { ...config, id: randomUUID() };
    store.servers.push(server);
    store.activeServerId = server.id;
    await saveStore(store);
    dashboardCache = null;
    res.status(201).json(publicConfig(store));
  }),
);
app.patch(
  "/api/config/active",
  writeLimiter,
  asyncRoute(async (req, res) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.body).id;
    const store = await loadStore();
    if (!store.servers.some((server) => server.id === id))
      return void res.status(404).json({ error: "Server not found" });
    store.activeServerId = id;
    await saveStore(store);
    dashboardCache = null;
    res.json(publicConfig(store));
  }),
);
app.patch(
  "/api/config/:id",
  writeLimiter,
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const input = ServerUpdateInput.parse(req.body);
    const store = await loadStore();
    const index = store.servers.findIndex((server) => server.id === id);
    if (index === -1)
      return void res.status(404).json({ error: "Server not found" });

    const current = store.servers[index]!;
    const next: StoredServer = {
      ...current,
      ...input,
      id,
      baseUrl: normalizeBaseUrl(input.baseUrl),
      apiKey: input.apiKey ?? current.apiKey,
      ssh: input.ssh ? completeSshConfig(input.ssh, current.ssh) : current.ssh,
    };
    if (
      store.servers.some(
        (server) =>
          server.id !== id && normalizeBaseUrl(server.baseUrl) === next.baseUrl,
      )
    ) {
      return void res
        .status(409)
        .json({ error: "This server is already configured" });
    }

    const connectionChanged =
      next.baseUrl !== current.baseUrl ||
      next.apiKey !== current.apiKey ||
      next.allowSelfSigned !== current.allowSelfSigned;
    if (connectionChanged) await graphQL(next, `query Test { online }`);
    if (connectionChanged) schemaCapabilitiesCache.delete(id);

    store.servers[index] = next;
    await saveStore(store);
    dashboardCache = null;
    diskIoSamples.delete(id);
    res.json(publicConfig(store));
  }),
);
app.delete(
  "/api/config/:id",
  writeLimiter,
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const store = await loadStore();
    store.servers = store.servers.filter((server) => server.id !== id);
    schemaCapabilitiesCache.delete(id);
    diskIoSamples.delete(id);
    if (store.activeServerId === id)
      store.activeServerId = store.servers[0]?.id ?? null;
    await saveStore(store);
    dashboardCache = null;
    res.json(publicConfig(store));
  }),
);
app.get(
  "/api/logs/server/sources",
  logLimiter,
  asyncRoute(async (_req, res) => {
    const { ssh } = await activeSsh();
    res.set("cache-control", "private, max-age=60");
    res.json(await listServerLogSources(ssh));
  }),
);

app.get(
  "/api/logs/server",
  logLimiter,
  asyncRoute(async (req, res) => {
    const { ssh } = await activeSsh();
    const { lines, source } = ServerLogQueryInput.parse(req.query);
    res.set("cache-control", "no-store");
    res.json({
      ...(await readServerLogs(ssh, lines, source)),
      fetchedAt: new Date().toISOString(),
    });
  }),
);
app.get(
  "/api/logs/docker/:id",
  logLimiter,
  asyncRoute(async (req, res) => {
    const { ssh } = await activeSsh();
    const { id } = ContainerLogParams.parse(req.params);
    const { lines } = LogQueryInput.parse(req.query);
    res.set("cache-control", "no-store");
    res.json({
      ...(await readDockerLogs(ssh, id, lines)),
      fetchedAt: new Date().toISOString(),
    });
  }),
);
app.get(
  "/api/vms/:id/icon",
  logLimiter,
  asyncRoute(async (req, res) => {
    const { ssh } = await activeSsh();
    const { id } = VmIconParams.parse(req.params);
    const icon = await readVmIcon(ssh, id);
    if (!icon) {
      res.status(404).end();
      return;
    }
    res.set("cache-control", "private, max-age=3600");
    res.type(icon.contentType).send(icon.content);
  }),
);

app.get(
  "/api/files",
  asyncRoute(async (req, res) => {
    const { ssh } = await activeSsh();
    const path = FilePathInput.parse(req.query.path ?? "/");
    const { page, pageSize } = FilePageInput.parse(req.query);
    res.set("cache-control", "no-store");
    res.json(await listFiles(ssh, path, page, pageSize));
  }),
);
app.post(
  "/api/files/folder",
  writeLimiter,
  asyncRoute(async (req, res) => {
    const { serverId, ssh } = await activeSsh();
    const path = z.object({ path: FilePathInput }).parse(req.body).path;
    await createFolder(ssh, path);
    await auditFileAction(serverId, "mkdir", path);
    res.status(201).json({ ok: true });
  }),
);
app.patch(
  "/api/files",
  writeLimiter,
  asyncRoute(async (req, res) => {
    const { serverId, ssh } = await activeSsh();
    const { from, to } = FileRenameInput.parse(req.body);
    await renameFile(ssh, from, to);
    await auditFileAction(serverId, "rename", `${from} -> ${to}`);
    res.json({ ok: true });
  }),
);
app.delete(
  "/api/files",
  writeLimiter,
  asyncRoute(async (req, res) => {
    const { serverId, ssh } = await activeSsh();
    const path = FilePathInput.parse(req.query.path);
    await deleteFile(ssh, path);
    await auditFileAction(serverId, "delete", path);
    res.json({ ok: true });
  }),
);
app.post(
  "/api/files/upload",
  writeLimiter,
  asyncRoute(async (req, res) => {
    const contentLength = Number(req.get("content-length"));
    if (!Number.isFinite(contentLength))
      return void res.status(411).json({ error: "Content-Length is required" });
    if (contentLength > maxUploadBytes)
      return void res.status(413).json({ error: "Upload is too large" });
    const { serverId, ssh } = await activeSsh();
    const path = FilePathInput.parse(req.query.path);
    await uploadFile(ssh, path, req);
    await auditFileAction(serverId, "upload", path);
    res.status(201).json({ ok: true });
  }),
);
app.get(
  "/api/files/download",
  asyncRoute(async (req, res) => {
    const { ssh } = await activeSsh();
    const path = FilePathInput.parse(req.query.path);
    const file = await downloadFile(ssh, path);
    res.set({
      "cache-control": "no-store",
      "content-length": String(file.size),
      "content-type": "application/octet-stream",
    });
    res.attachment(file.name);
    file.stream.once("error", (error: Error) => {
      file.client.end();
      res.destroy(error);
    });
    file.stream.once("close", () => file.client.end());
    file.stream.pipe(res);
  }),
);
app.get(
  "/api/dashboard",
  asyncRoute(async (_req, res) => {
    const store = await loadStore();
    const config = store.servers.find(
      (server) => server.id === store.activeServerId,
    );
    if (!config) return void res.status(428).json({ error: "Setup required" });
    res.set("cache-control", "no-store");
    res.json(await dashboard(config));
  }),
);
app.post(
  "/api/action",
  writeLimiter,
  asyncRoute(async (req, res) => {
    const store = await loadStore();
    const config = store.servers.find(
      (server) => server.id === store.activeServerId,
    );
    if (!config) return void res.status(428).json({ error: "Setup required" });
    const input = ActionInput.parse(req.body);
    const result = await runAction(config, input);
    dashboardCache = null;
    await appendFile(
      auditFile,
      `${JSON.stringify({ at: new Date().toISOString(), serverId: config.id, target: input.target, action: input.action, id: input.id ?? null })}\n`,
    );
    res.json({ ok: true, result });
  }),
);

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message =
    error instanceof z.ZodError
      ? error.issues.map((issue) => issue.message).join(", ")
      : error instanceof Error
        ? error.message
        : "Unexpected error";
  console.error(error);
  res.status(error instanceof z.ZodError ? 400 : 502).json({ error: message });
});
if (existsSync(webDir)) {
  app.use(
    express.static(webDir, {
      index: false,
      setHeaders: (res, filePath) => {
        const normalizedPath = filePath.replaceAll("\\", "/");
        if (normalizedPath.endsWith("/sw.js")) {
          res.setHeader("cache-control", "no-cache, no-store, must-revalidate");
          return;
        }
        const immutable =
          normalizedPath.includes("/assets/") ||
          /\/workbox-[^/]+\.js$/.test(normalizedPath);
        res.setHeader(
          "cache-control",
          immutable
            ? "public, max-age=31536000, immutable"
            : "no-cache, must-revalidate",
        );
      },
    }),
  );
  app.get("/{*path}", (_req, res) => {
    res.set("cache-control", "no-store");
    res.sendFile(join(webDir, "index.html"));
  });
}

await mkdir(dataDir, { recursive: true });
app.listen(port, "0.0.0.0", () =>
  console.log(`Unraid API listening on http://0.0.0.0:${port}`),
);
