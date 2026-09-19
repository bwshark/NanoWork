import { create } from 'zustand';
import { platform } from '@/platform';
import type { StorageInfo } from '@/platform/types';
import { useSettingsStore } from './settingsStore';

/**
 * 本地存储信息缓存。
 *
 * 做成 store 而不是「设置卡片里的一个 useState」，有两个具体原因：
 *
 * 1. **默认工作空间路径要在会话创建时同步可用**。`createSession` 是同步函数，
 *    不可能在那里 `await` 主进程；而内置默认路径（`<home>/NanoWork`）只有主进程
 *    算得出来。于是必须在别处先把结果取回来缓存，创建会话时同步读。
 * 2. **缓存目录体积是递归统计出来的**，一次要遍历几十万个条目。设置卡片每次
 *    挂载各算一次，会让「反复开关设置」变成反复扫盘。
 */
interface StorageInfoState {
  /** 主进程返回的存储信息；未取到（Web 端 / 首次刷新前）为 null */
  info: StorageInfo | null;
  /** 是否正在取（防止卡片挂载与启动引导并发触发两次全盘统计） */
  loading: boolean;
  /**
   * 失败原因。Web 端 platform.storageInfo 返回 null 不算错误——那里没有
   * 「应用缓存目录」这个概念，如实标注「不可用」即可。
   */
  error: string | null;
  /** 重新读取（打开设置卡片、切换工作空间路径后调用） */
  refresh: () => Promise<void>;
}

export const useStorageInfoStore = create<StorageInfoState>((set, get) => ({
  info: null,
  loading: false,
  error: null,
  refresh: async () => {
    // 去重：并发触发没有意义，还会让主进程同时跑两遍目录统计
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      // 只有「用户没自定义工作空间路径」时才让主进程把内置默认目录建出来。
      // 用户自定义的路径由目录选择器保证存在，不需要我们代劳；
      // 若他后来手动删了它，更不该由应用悄悄重建。
      const custom = useSettingsStore.getState().settings.defaultWorkspacePath?.trim();
      const info = await platform.storageInfo(!custom);
      set({
        info,
        loading: false,
        error: info ? null : '当前环境不支持读取本地存储信息',
      });
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },
}));

/**
 * 解析「默认工作空间」的**有效**路径：用户设置 > 内置默认。
 *
 * 返回 `undefined` 只发生在「用户没配 + 主进程还没回过话」这一个小窗口里
 * （应用刚启动的第一帧）。宁可在这里返回 undefined，也不要编一个猜出来的路径：
 * 真写进会话，事后没有任何办法判断它是猜的还是用户选的。
 *
 * 那这个窗口怎么补？**在发消息时兜底**（`sendMessage` 里的
 * `session.workdir ?? resolveDefaultWorkspacePath()`）。会话的 `workdir` 一旦落盘
 * 就不再回填——回填会触发事件流目录搬迁（`setSessionWorkdir` 的副作用），
 * 为了一个几十毫秒的窗口去搬目录，风险远大于收益。
 */
export function resolveDefaultWorkspacePath(): string | undefined {
  const custom = useSettingsStore.getState().settings.defaultWorkspacePath?.trim();
  if (custom) return custom;
  return useStorageInfoStore.getState().info?.defaultWorkspaceDir;
}
