/**
 * 网关端口的落地：把「能用」的端口写回配置（P1）。
 *
 * ## 要解决的具体故障
 *
 * `gateway` 启动时会同时占两个端口：health（`gateway.port`，默认 18790）与 WebUI /
 * websocket 频道（`channels.websocket.port`，默认 9900）。**只要有一个被占，引擎直接
 * 拒绝启动**，原话是 `nanobot cannot start because one of its local ports is already in use`
 * —— 而应用侧只会显示「网关离线」，用户完全不知道是端口冲突。
 *
 * serve 那条链路早就有 `resolveGatewayPort()` 做顺延（并已被端口保留区间坑过），
 * 网关这条一直写死常量。本模块把同样的处理补上，并且**写回配置文件**：端口只存在于
 * 两个地方（进程实参与 `waitForPort` 探测），两份值一旦不同步就会出现「进程在跑但
 * 就绪探测永远等不到」。
 *
 * ## 为什么写配置而不是传命令行
 *
 * `gateway` 子命令只接受 `--port`（WebUI），**没有** `--gateway-port`
 * （实测：`No such option: --gateway-port`）。health 端口只能通过配置改，所以只能写文件。
 *
 * ## 顺序约束
 *
 * 必须在 spawn **之前**调用：引擎启动时读一次配置就固定了端口，跑起来之后再改文件
 * 不会生效，只会让两侧认知分叉。
 */

import { existsSync, promises as fs } from 'node:fs';
import { canBindPort, resolveGatewayPort } from './gatewayPort';

/** 默认端口（与引擎配置默认值一致）。只作为"配置里没写"时的兜底。 */
export const DEFAULT_GATEWAY_HEALTH_PORT = 18790;
export const DEFAULT_GATEWAY_WEBUI_PORT = 9900;

export interface ServicePortsIO {
  exists(path: string): boolean;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
}

export interface EnsureServicePortsOptions {
  /** 引擎配置文件路径（与 `engineConfigPath()` 同源） */
  configPath: string;
  host: string;
  defaults?: { gateway: number; webui: number };
  io?: ServicePortsIO;
  canBind?: (host: string, port: number) => Promise<boolean>;
  resolvePort?: (host: string, preferred: number) => Promise<number>;
}

export interface ResolvedServicePorts {
  gatewayPort: number;
  webuiPort: number;
  /** 是否改写了配置文件（端口全部可用时为 false，避免无谓落盘） */
  changed: boolean;
  /** 无法写回配置时的说明（端口仍可用，只是下次启动要重新协商） */
  warning?: string;
}

type Json = Record<string, unknown>;

const defaultIO: ServicePortsIO = {
  exists: existsSync,
  readFile: (path) => fs.readFile(path, 'utf-8'),
  writeFile: (path, data) => fs.writeFile(path, data, 'utf-8'),
};

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPort(node: unknown): number | null {
  if (!isPlainObject(node)) return null;
  const value = node.port;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536
    ? value
    : null;
}

/**
 * 确保两个端口都能绑定，并把最终端口写回配置。
 *
 * 幂等：端口可用时**不写文件**。因此重复调用不会让配置的 mtime 一直变。
 */
export async function ensureServicePorts(
  options: EnsureServicePortsOptions,
): Promise<ResolvedServicePorts> {
  const io = options.io ?? defaultIO;
  const canBind = options.canBind ?? canBindPort;
  const resolvePort = options.resolvePort ?? resolveGatewayPort;
  const defaults = options.defaults ?? {
    gateway: DEFAULT_GATEWAY_HEALTH_PORT,
    webui: DEFAULT_GATEWAY_WEBUI_PORT,
  };

  let config: Json | null = null;
  let raw: string | null = null;
  if (io.exists(options.configPath)) {
    try {
      raw = await io.readFile(options.configPath);
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      config = isPlainObject(parsed) ? parsed : null;
    } catch {
      // 配置坏了不在这里修（自检会报），按默认端口继续
      config = null;
    }
  }

  const currentGateway = readPort(config?.gateway) ?? defaults.gateway;
  const channels = config?.channels;
  const websocket = isPlainObject(channels) ? channels.websocket : undefined;
  const currentWebui = readPort(websocket) ?? defaults.webui;

  const gatewayPort = (await canBind(options.host, currentGateway))
    ? currentGateway
    : await resolvePort(options.host, currentGateway);
  const webuiPort = (await canBind(options.host, currentWebui))
    ? currentWebui
    : await resolvePort(options.host, currentWebui);

  const changed = gatewayPort !== currentGateway || webuiPort !== currentWebui;
  if (!changed || config === null) {
    return {
      gatewayPort,
      webuiPort,
      changed: false,
      ...(config === null && changed
        ? { warning: '配置文件不可用，端口顺延结果无法写回；下次启动会重新协商' }
        : {}),
    };
  }

  // 写回：只动这两个数字，其余键原样保留
  const next: Json = { ...config };
  if (gatewayPort !== currentGateway) {
    next.gateway = { ...(isPlainObject(config.gateway) ? config.gateway : {}), port: gatewayPort };
  }
  if (webuiPort !== currentWebui) {
    const nextChannels = isPlainObject(config.channels) ? { ...config.channels } : {};
    nextChannels.websocket = {
      ...(isPlainObject(nextChannels.websocket) ? nextChannels.websocket : {}),
      port: webuiPort,
    };
    next.channels = nextChannels;
  }

  try {
    await io.writeFile(options.configPath, `${JSON.stringify(next, null, 2)}\n`);
    return { gatewayPort, webuiPort, changed: true };
  } catch (error) {
    // 写不进去也要让本次启动用正确端口：端口本身是有效的，只是下次要重新协商
    return {
      gatewayPort,
      webuiPort,
      changed: false,
      warning: `端口顺延结果写回失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
