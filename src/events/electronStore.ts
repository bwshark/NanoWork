import { isElectron } from '@/platform/env';
import type { ElectronAPI } from '@/platform/types';
import { listSessionEntries } from './indexFile';
import type { EventStore, EventStoreCapabilities } from './store';

/**
 * Electron 事件存储：桌面端实现（真实文件）。
 *
 * 本模块是**薄转发层**——所有落盘逻辑（JSONL 编码、索引投影、路径安全、
 * 容错解析）都在主进程的 `electron/eventStore.ts`。这里只把 preload 桥
 * （`window.electronAPI`）的方法名对齐到 `EventStore` 契约。
 *
 * 为什么单独一层而不是直接用桥：契约是两个实现共用的（Web 也要满足），
 * 有了它，Phase D 的 UI 读写路径才能完全无视「跑在哪个平台」。
 *
 * 边界规则：`src/events/electronStore.ts` 与 `webStore.ts` 是渲染层里
 * **仅有的两处**可以直接碰平台细节的地方；其余代码一律经 `getEventStore()`。
 */

const CAPABILITIES: EventStoreCapabilities = {
  fileBacked: true,
  fileHistory: true,
};

/** 取 preload 桥；非 Electron 或桥未就绪时抛错（工厂保证只在 Electron 下构造） */
function bridge(): ElectronAPI {
  const api = window.electronAPI;
  if (!isElectron() || !api) {
    throw new Error('[events] Electron 桥不可用：window.electronAPI 缺失');
  }
  return api;
}

export function createElectronEventStore(): EventStore {
  // 一律用 async 包装：桥缺失时抛错会变成 **rejected promise** 而不是同步抛出，
  // 这样契约的「永远返回 Promise」对调用方成立（Web 实现同理）。
  async function readIndex() {
    return bridge().readSessionIndex();
  }

  return {
    capabilities: CAPABILITIES,
    async append(params) {
      return bridge().eventsAppend(params);
    },
    async readEvents(sessionId, workdir) {
      return bridge().eventsRead(sessionId, workdir);
    },
    async removeSession(sessionId, workdir) {
      return bridge().eventsRemove(sessionId, workdir);
    },
    async readMeta(sessionId, workdir) {
      return bridge().readSessionMeta(sessionId, workdir);
    },
    async writeMeta(meta) {
      return bridge().writeSessionMeta(meta);
    },
    async listMetas() {
      return bridge().listSessionMetas();
    },
    readIndex,
    async listSessions() {
      return listSessionEntries(await readIndex());
    },
    async rebuildIndex() {
      return bridge().rebuildSessionIndex();
    },
    async putBackup(hash, content) {
      return bridge().putFileBackup(hash, content);
    },
    async getBackup(hash) {
      return bridge().getFileBackup(hash);
    },
  };
}
