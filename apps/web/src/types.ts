export type View =
  "dashboard" | "storage" | "docker" | "vms" | "shares" | "logs";

export type SshSettings = {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  authType: "password" | "privateKey";
  rootPath: string;
  hostFingerprint?: string;
  configured: boolean;
};
export type SshSettingsInput = Omit<SshSettings, "configured"> & {
  password?: string;
  privateKey?: string;
  passphrase?: string;
};
export type ServerSummary = {
  id: string;
  name: string;
  baseUrl: string;
  allowSelfSigned: boolean;
  ssh?: SshSettings;
};
export type ServerConfig = {
  configured: boolean;
  activeServerId: string | null;
  name?: string;
  baseUrl?: string;
  allowSelfSigned?: boolean;
  ssh?: SshSettings;
  servers: ServerSummary[];
};
export type FileEntry = {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink";
  size: number;
  modifiedAt: string | null;
  permissions: string;
};
export type FileListing = {
  path: string;
  rootPath: string;
  files: FileEntry[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};
export type ServerLogSource =
  | "system"
  | "kernel"
  | "journal"
  | "nginx-error"
  | "nginx-access"
  | "libvirt"
  | "php-fpm";
export type ServerLogSourceOption = {
  id: ServerLogSource;
  label: string;
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
  fetchedAt: string;
};

export type SystemInfo = {
  time: string;
  cpu: {
    brand?: string;
    manufacturer?: string;
    cores?: number;
    threads?: number;
    speed?: number;
  };
  os: {
    hostname?: string;
    distro?: string;
    release?: string;
    kernel?: string;
    arch?: string;
    uptime?: string;
  };
  system: { manufacturer?: string; model?: string };
  versions?: { core?: { unraid?: string } };
};

export type HardwareInfo = {
  cpu?: {
    vendor?: string;
    family?: string;
    model?: string;
    stepping?: number;
    revision?: string;
    voltage?: string;
    speedmin?: number;
    speedmax?: number;
    processors?: number;
    socket?: string;
    packages?: {
      totalPower?: number;
      power?: number[];
      temp?: number[];
    };
  };
  baseboard?: {
    manufacturer?: string;
    model?: string;
    version?: string;
    memMax?: number;
    memSlots?: number;
  };
  memory?: {
    layout?: Array<{
      size: string | number;
      bank?: string;
      type?: string;
      clockSpeed?: number;
      manufacturer?: string;
      formFactor?: string;
      voltageConfigured?: number;
    }>;
  };
  system?: {
    version?: string;
    virtual?: boolean;
  };
  versions?: {
    core?: { unraid?: string; api?: string; kernel?: string };
    packages?: Record<string, string | undefined>;
  };
  devices?: {
    gpu?: Array<{
      id: string;
      type?: string;
      typeid: string;
      blacklisted: boolean;
      class: string;
      productid: string;
      vendorname?: string;
    }>;
    network?: Array<{
      id: string;
      iface: string;
      model?: string;
      vendor?: string;
      mac?: string;
      virtual?: boolean;
      speed?: string;
      dhcp?: boolean;
    }>;
    pci?: Array<{
      id: string;
      type?: string;
      typeid: string;
      vendorname?: string;
      vendorid: string;
      productname?: string;
      productid: string;
      blacklisted: string;
      class: string;
    }>;
    usb?: Array<{
      id: string;
      name: string;
      bus?: string;
      device?: string;
    }>;
  };
};

export type AccessUrl = {
  type: "LAN" | "WIREGUARD" | "WAN" | "MDNS" | "OTHER" | "DEFAULT";
  name?: string;
  ipv4?: string;
  ipv6?: string;
};

export type NetworkInterfaceInfo = {
  id: string;
  name: string;
  description?: string;
  macAddress?: string;
  mtu?: number;
  speed?: number;
  duplex?: string;
  internal?: boolean;
  virtual?: boolean;
  operstate?: string;
  type?: string;
  vlanId?: number;
  ipv4Addresses: Array<{ address: string; netmask: string }>;
  ipv6Addresses: Array<{ address: string; prefixLength?: number }>;
  status?: string;
  protocol?: string;
  ipAddress?: string;
  netmask?: string;
  gateway?: string;
  useDhcp?: boolean;
  ipv6Address?: string;
  ipv6Netmask?: string;
  ipv6Gateway?: string;
  useDhcp6?: boolean;
};

export type TelemetryMetrics = {
  network?: Array<{
    id: string;
    name: string;
    operstate?: string;
    bytesReceived: string | number;
    bytesSent: string | number;
    packetsReceived: string | number;
    packetsSent: string | number;
    receiveErrors: string | number;
    transmitErrors: string | number;
    receiveDropped: string | number;
    transmitDropped: string | number;
    rxSec: number;
    txSec: number;
    utilizationPercent?: number;
    lastUpdated: string;
  }>;
  temperature?: {
    sensors: Array<{
      id: string;
      name: string;
      type: string;
      location?: string;
      current: {
        value: number;
        unit: string;
        timestamp: string;
        status: string;
      };
      min?: { value: number; unit: string; timestamp: string; status: string };
      max?: { value: number; unit: string; timestamp: string; status: string };
      warning?: number;
      critical?: number;
    }>;
  };
};

export type Metrics = {
  cpu?: { percentTotal: number };
  memory?: {
    total: string | number;
    used: string | number;
    free: string | number;
    available: string | number;
    buffcache: string | number;
    active?: string | number;
    percentTotal: number;
    swapTotal: string | number;
    swapUsed: string | number;
    percentSwapTotal: number;
    swapFree?: string | number;
  };
};

export type Disk = {
  id: string;
  idx: number;
  name?: string;
  device?: string;
  size?: string | number;
  status?: string;
  rotational?: boolean;
  temp?: number;
  numErrors?: string | number;
  fsSize?: string | number;
  fsFree?: string | number;
  fsUsed?: string | number;
  type: string;
  fsType?: string;
  transport?: string;
  isSpinning?: boolean;
};

export type ArrayInfo = {
  state: string;
  capacity: {
    kilobytes: { free: string; used: string; total: string };
    disks: { free: string; used: string; total: string };
  };
  parityCheckStatus: {
    date?: string;
    duration?: number;
    speed?: string;
    status: string;
    errors?: number;
    progress?: number;
    correcting?: boolean;
    paused?: boolean;
    running?: boolean;
  };
  boot?: Disk;
  parities: Disk[];
  disks: Disk[];
  caches: Disk[];
};

export type Container = {
  id: string;
  names: string[];
  image: string;
  imageId?: string;
  command?: string;
  created: number;
  ports: Array<{
    ip?: string;
    privatePort: number;
    publicPort?: number;
    type: string;
  }>;
  templatePorts?: Array<{
    ip?: string;
    privatePort: number;
    publicPort?: number;
    type: string;
  }>;
  lanIpPorts?: string[];
  sizeRootFs?: string | number;
  sizeRw?: string | number;
  sizeLog?: string | number;
  labels?: Record<string, unknown>;
  state: string;
  status: string;
  hostConfig?: { networkMode: string };
  networkSettings?: Record<string, unknown>;
  mounts?: Array<Record<string, unknown>>;
  autoStart: boolean;
  autoStartOrder?: number;
  autoStartWait?: number;
  projectUrl?: string;
  iconUrl?: string;
  webUiUrl?: string;
  isOrphaned: boolean;
  isUpdateAvailable?: boolean;
};

export type Vm = { id: string; name?: string; state: string };
export type Share = {
  id: string;
  name?: string;
  free?: string | number;
  used?: string | number;
  size?: string | number;
  include?: string[];
  exclude?: string[];
  cache?: boolean;
  comment?: string;
  allocator?: string;
};
export type Notification = {
  id: string;
  title: string;
  subject: string;
  description: string;
  importance: "ALERT" | "WARNING" | "INFO";
  link?: string;
  type: string;
  timestamp?: string;
  formattedTimestamp?: string;
};

export type Dashboard = {
  fetchedAt: string;
  server: { name: string; baseUrl: string };
  system: { info?: SystemInfo; metrics?: Metrics; error?: string };
  hardware: { info?: HardwareInfo; error?: string };
  network: { network?: { accessUrls?: AccessUrl[] }; error?: string };
  networkInfo: {
    info?: {
      networkInterfaces?: NetworkInterfaceInfo[];
      primaryNetwork?: NetworkInterfaceInfo;
    };
    error?: string;
  };
  telemetry: { metrics?: TelemetryMetrics; error?: string };
  registration: {
    registration?: {
      type?: string;
      state?: string;
      expiration?: string;
      updateExpiration?: string;
    };
    error?: string;
  };
  publicIp: { address?: string; error?: string };
  array: { array?: ArrayInfo; error?: string };
  docker: { docker?: { containers: Container[] }; error?: string };
  dockerStats: {
    containers?: Array<{
      id: string;
      name: string;
      cpuPercent: number;
      memUsage: string;
      memPercent: number;
      netIO: string;
      blockIO: string;
    }>;
    error?: string;
  };
  diskIo: {
    sampledAt?: string;
    sampleDurationMs?: number;
    devices?: Array<{
      device: string;
      readBytesPerSecond: number | null;
      writeBytesPerSecond: number | null;
    }>;
    error?: string;
  };
  graphqlSchema: {
    adaptive: boolean;
    source: "server" | "official" | "static";
    schemaRef?: string;
    fetchedAt: string;
    expiresAt: string;
    version?: string;
    error?: string;
    warning?: string;
  };
  vms: { vms?: { domains?: Vm[] }; error?: string };
  shares: { shares?: Share[]; error?: string };
  notifications: {
    notifications?: {
      overview: {
        unread: { info: number; warning: number; alert: number; total: number };
      };
      warningsAndAlerts: Notification[];
    };
    error?: string;
  };
};

export type PendingAction = {
  target: "docker" | "vm" | "array" | "notification";
  action: string;
  id?: string;
  label: string;
  dangerous?: boolean;
};
