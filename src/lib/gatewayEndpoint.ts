/**
 * 本地网关地址的解析与判定。
 *
 * 为什么需要这层：网关端口**不再是写死的常量**。主进程在首选端口不可用时会自动顺延
 * 探测（见 `electron/main.ts` 的 `resolveGatewayPort`），因此实际监听端口只有主进程
 * 知道；渲染层必须能把 `settings.gatewayEndpoint` 同步到真实端口上，否则界面会一直
 * 探测一个没人监听的端口（表现为「网关离线」但子进程明明活着）。
 *
 * 这里只放**纯函数**：不碰 storage、不碰 IPC，便于单测直接钉住判据。
 */

/** 视为「本机网关」的主机名（IPv6 在 URL 里带方括号） */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '0.0.0.0', '::1', '[::1]'];

/** 网关地址的路径前缀（OpenAI 兼容 API 前缀） */
export const GATEWAY_API_PATH = '/v1';

/**
 * 判定地址是否指向本机网关。
 *
 * 同步端口前必须过这一道：用户完全可以把网关地址填成内网另一台机器
 * （如 `http://10.0.0.8:8900/v1`），那种地址与「本机主进程拉起的子进程」无关，
 * 覆盖它等于把用户的配置改坏。无法解析的地址一律判为「非本机」。
 * @param endpoint 完整网关地址（形如 `http://127.0.0.1:8900/v1`）
 * @returns 是否为本机地址
 */
export function isLocalGatewayEndpoint(endpoint: string): boolean {
  const url = parseGatewayEndpoint(endpoint);
  if (!url) return false;
  return LOOPBACK_HOSTS.includes(url.hostname.toLowerCase());
}

/**
 * 由主机与端口拼出标准网关地址。
 * @param host 主机（主进程实际监听地址）
 * @param port 端口（主进程实际监听端口）
 * @returns 形如 `http://127.0.0.1:18900/v1`
 */
export function localGatewayEndpoint(host: string, port: number): string {
  return `http://${host}:${port}${GATEWAY_API_PATH}`;
}

/**
 * 取地址中的端口；解析失败或无显式端口时返回 null。
 * 无显式端口（如 `http://127.0.0.1/v1`）解析出的是空串，不能当 0 或 80 处理——
 * 那会让「端口漂移」的判定误以为已经对齐。
 * @param endpoint 完整网关地址
 * @returns 端口号或 null
 */
export function gatewayPortOf(endpoint: string): number | null {
  const url = parseGatewayEndpoint(endpoint);
  if (!url || url.port === '') return null;
  const port = Number(url.port);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/** 解析网关地址；非法地址返回 null 而不是抛错（调用方多为渲染路径，不该因脏数据崩） */
function parseGatewayEndpoint(endpoint: string): URL | null {
  if (typeof endpoint !== 'string' || endpoint.trim() === '') return null;
  try {
    return new URL(endpoint.trim());
  } catch {
    return null;
  }
}

/** 主进程回报的网关监听信息（只取决策需要的字段，便于单测直接构造） */
export interface GatewayListenInfo {
  /** 子进程是否在跑 */
  running: boolean;
  /** 实际监听主机 */
  host: string | null;
  /** 实际监听端口 */
  port: number | null;
}

/**
 * 算出网关地址应该改成什么；**不需要改时返回 `null`**。
 *
 * 决策集中在纯函数里（而不是散在组件的轮询回调中）的原因：这几条判据一旦写错，
 * 症状是「地址被改坏」或「永远不同步」，而两者在 jsdom 里都看不出来——只有把判据本身
 * 钉住才能守住。组件那边只剩「拿到非 null 就写入 store」一行。
 *
 * 三条判据（缺一不可）：
 * 1. `running` 为真 —— 子进程没跑时端口是历史值，照它改会把地址指向空处；
 * 2. `port` 已知 —— 尚未解析出端口时同样不能改；
 * 3. 当前地址是**本机**地址 —— 用户填的内网/远程网关与本地子进程无关，覆盖它等于改坏配置。
 * @param current 当前网关地址（`settings.gatewayEndpoint`）
 * @param info 主进程回报的实际监听信息
 * @returns 需要改成的新地址；已对齐或不该改时返回 null
 */
export function nextGatewayEndpoint(current: string, info: GatewayListenInfo): string | null {
  if (!info.running || info.port === null) return null;
  if (!isLocalGatewayEndpoint(current)) return null;
  const next = localGatewayEndpoint(info.host ?? '127.0.0.1', info.port);
  return next === current ? null : next;
}

