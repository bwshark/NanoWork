/**
 * 连接器凭据保险库（Electron 主进程）。
 *
 * ## 它解决什么问题
 *
 * 凭据原先有两份**明文**落盘：渲染层的持久化镜像 `~/.nanowork/mcp.json`
 * （zustand persist 把 `auth` 一并写下去）和引擎消费的 `nanobot.config.json`
 * （`env` / `Authorization` 头）。前者是本应用自己的存储，完全没必要留明文。
 *
 * 本模块把"密钥值"收敛到一个加密文件：
 *
 * ```
 * ~/.nanowork/connectors/.credentials.v3.json
 * { "version": 3, "servers": { "<serverName>": { "keys": [...], "blob": "<base64>" } } }
 * ```
 *
 * `blob` 是 `safeStorage.encryptString(JSON.stringify(secrets))` 的 base64——
 * 用的是 Electron 的 `safeStorage`，其密钥由操作系统凭据库保管（macOS Keychain
 * / Windows DPAPI / Linux libsecret），**即 PRD §12.7 里 `.master.key` 的角色**：
 * 我们不需要自己造一个主密钥，也不需要把它放在磁盘上。
 *
 * ## 三条纪律
 *
 * 1. **fail-closed**：`safeStorage` 不可用（Linux 无 keyring、测试环境等）时
 *    **拒绝写入**，而不是退回明文。写不进去会显式报错，界面据此提示用户；
 *    悄悄降级成明文是最糟的结果——用户以为加密了。
 * 2. **只增不减的语义边界**：`write` 是"整条 server 的密钥集合替换"。
 *    传空对象等于删除该条（避免留下一个空壳让界面以为"已设置"）。
 * 3. **文件权限收紧到 0600**。即便内容已加密，也没有理由让同机其他用户读到
 *    密文与密钥名的清单（密钥名本身已泄露"用了哪种认证"）。
 *
 * ## 为什么用依赖注入而不是直接 import electron
 *
 * `safeStorage` 只在 Electron 运行时存在。把 `cipher` 作为参数注入后，
 * 本模块不 import `electron`，可以直接被 vitest 覆盖（对齐
 * `electron/storageRoutes.ts` 的做法），也能在主进程里用真实 `safeStorage` 装配。
 */
import { existsSync, promises as fs } from 'node:fs';
import { dirname } from 'node:path';

/** 保险库文件格式版本 */
export const CREDENTIAL_VAULT_VERSION = 3;

/** 加密实现（主进程传入 `safeStorage` 适配器；测试传入可预测的伪实现） */
export interface CredentialCipher {
  /** 当前环境是否可用加密；`false` 时保险库整体不可写 */
  available(): boolean;
  /** 明文 → 密文 */
  encrypt(plain: string): Buffer;
  /** 密文 → 明文；解密失败应抛错 */
  decrypt(blob: Buffer): string;
}

export interface CredentialVaultOptions {
  /** 保险库文件的绝对路径 */
  filePath: string;
  cipher: CredentialCipher;
}

/** 单个 server 的密钥记录 */
interface ServerRecord {
  keys: string[];
  blob: string;
}

interface VaultFile {
  version: number;
  servers: Record<string, ServerRecord>;
}

/** 保险库可用性与落点（供界面提示） */
export interface CredentialVaultStatus {
  available: boolean;
  path: string;
}

function emptyVault(): VaultFile {
  return { version: CREDENTIAL_VAULT_VERSION, servers: {} };
}

/** 只保留非空字符串值；其余一律丢弃（配置来自用户输入与回读，不可信） */
function sanitizeSecrets(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === 'string' && value !== '' && key !== '') out[key] = value;
  }
  return out;
}

export class CredentialVault {
  private readonly filePath: string;
  private readonly cipher: CredentialCipher;
  /** 串行化写操作：并发写同一文件会互相覆盖（tmp + rename 也救不了） */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: CredentialVaultOptions) {
    this.filePath = options.filePath;
    this.cipher = options.cipher;
  }

  status(): CredentialVaultStatus {
    return { available: this.cipher.available(), path: this.filePath };
  }

  /** 读取整库；文件缺失 / 损坏一律当作空库（不抛，不删） */
  private async load(): Promise<VaultFile> {
    if (!existsSync(this.filePath)) return emptyVault();
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return emptyVault();
      const payload = parsed as Record<string, unknown>;
      const servers: Record<string, ServerRecord> = {};
      const rawServers =
        payload.servers && typeof payload.servers === 'object'
          ? (payload.servers as Record<string, unknown>)
          : {};
      for (const [name, value] of Object.entries(rawServers)) {
        if (!name || !value || typeof value !== 'object') continue;
        const record = value as Record<string, unknown>;
        if (typeof record.blob !== 'string' || record.blob === '') continue;
        servers[name] = {
          keys: Array.isArray(record.keys)
            ? record.keys.filter((key): key is string => typeof key === 'string')
            : [],
          blob: record.blob,
        };
      }
      return { version: CREDENTIAL_VAULT_VERSION, servers };
    } catch {
      // 损坏的保险库不能当成"没有密钥"之外的处理：明文密钥已经不在这里了，
      // 删掉文件只会让用户彻底找不回；留着等人工检查更安全。
      return emptyVault();
    }
  }

  private async save(vault: VaultFile): Promise<void> {
    await fs.mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(vault, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await fs.rename(tmp, this.filePath);
  }

  /** 串行执行，保证并发调用不会互相覆盖 */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    // 吞掉错误避免污染后续队列（调用方仍能从返回的 promise 拿到拒绝）
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * 密钥名的清单（**不含值**）。
   *
   * 界面只需要知道"这个 server 配了哪几个凭据"，用来显示"已设置"。
   * 值永远不回传给渲染层——回传等于把加密白做了。
   */
  async keyNames(): Promise<Record<string, string[]>> {
    const vault = await this.load();
    const out: Record<string, string[]> = {};
    for (const [name, record] of Object.entries(vault.servers)) {
      out[name] = [...record.keys];
    }
    return out;
  }

  /**
   * 取某个 server 的明文密钥。**仅供主进程内部使用**
   * （探针与 config.json 注入），不得经 IPC 回传渲染层。
   */
  async read(serverName: string): Promise<Record<string, string>> {
    if (!serverName) return {};
    const vault = await this.load();
    const record = vault.servers[serverName];
    if (!record) return {};
    if (!this.cipher.available()) return {};
    try {
      const plain = this.cipher.decrypt(Buffer.from(record.blob, 'base64'));
      return sanitizeSecrets(JSON.parse(plain));
    } catch {
      // 解密失败（换了机器 / 系统凭据被重置）→ 视为未设置，让用户重新填写。
      // 这里**不删除**记录：删除会让"临时不可解密"变成永久丢失。
      return {};
    }
  }

  /** 整条替换某个 server 的密钥集合；空对象等于删除该条 */
  async write(serverName: string, secrets: unknown): Promise<void> {
    if (!serverName) throw new Error('缺少 server 名，无法写入凭据');
    const clean = sanitizeSecrets(secrets);
    return this.serialize(async () => {
      if (Object.keys(clean).length === 0) {
        const vault = await this.load();
        if (!(serverName in vault.servers)) return;
        delete vault.servers[serverName];
        await this.save(vault);
        return;
      }
      if (!this.cipher.available()) {
        throw new Error('当前环境没有可用的系统凭据库，凭据未被保存（拒绝降级为明文）');
      }
      const blob = this.cipher.encrypt(JSON.stringify(clean)).toString('base64');
      const vault = await this.load();
      vault.servers[serverName] = { keys: Object.keys(clean).sort(), blob };
      await this.save(vault);
    });
  }

  /** 删除某个 server 的全部密钥（幂等） */
  async remove(serverName: string): Promise<void> {
    if (!serverName) return;
    return this.serialize(async () => {
      const vault = await this.load();
      if (!(serverName in vault.servers)) return;
      delete vault.servers[serverName];
      await this.save(vault);
    });
  }
}

/**
 * 用 Electron `safeStorage` 构造 cipher。
 *
 * 放在这里（而不是 main.ts）是为了让"可用性判断 + base64/Buffer 转换"只有一处，
 * 主进程只负责把 `safeStorage` 递进来。
 */
export function safeStorageCipher(safeStorage: {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(blob: Buffer): string;
}): CredentialCipher {
  return {
    available: () => {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (blob) => safeStorage.decryptString(blob),
  };
}
