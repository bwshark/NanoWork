import { contextBridge, ipcRenderer } from 'electron';
import type {
  ChannelConnectAction,
  DesktopConfig,
  ElectronAPI,
  PlatformName,
} from '../src/platform/types';

/**
 * preload：通过 contextBridge 安全地暴露 window.electronAPI。
 * 渲染层只经此桥访问存储与通知，绝不直接 require('electron')。
 */
const api: ElectronAPI = {
  storageGet: (key: string) => ipcRenderer.invoke('storage:get', key),
  storageSet: (key: string, value: string) => ipcRenderer.invoke('storage:set', key, value),
  storageRemove: (key: string) => ipcRenderer.invoke('storage:remove', key),
  storageClear: () => ipcRenderer.invoke('storage:clear'),
  // —— 事件流桥（D2）——
  eventsAppend: (params) => ipcRenderer.invoke('events:append', params),
  eventsRead: (sessionId: string, workdir?: string | null) =>
    ipcRenderer.invoke('events:read', sessionId, workdir),
  eventsRemove: (sessionId: string, workdir?: string | null) =>
    ipcRenderer.invoke('events:remove', sessionId, workdir),
  readSessionMeta: (sessionId: string, workdir?: string | null) =>
    ipcRenderer.invoke('meta:read', sessionId, workdir),
  writeSessionMeta: (meta) => ipcRenderer.invoke('meta:write', meta),
  listSessionMetas: () => ipcRenderer.invoke('meta:list'),
  readSessionIndex: () => ipcRenderer.invoke('index:read'),
  rebuildSessionIndex: () => ipcRenderer.invoke('index:rebuild'),
  putFileBackup: (hash: string, content: string) =>
    ipcRenderer.invoke('file-backup:put', hash, content),
  getFileBackup: (hash: string) => ipcRenderer.invoke('file-backup:get', hash),
  notify: (title: string, body: string) => ipcRenderer.send('app:notify', title, body),
  writeTextFile: (path: string, content: string) =>
    ipcRenderer.invoke('fs:writeTextFile', path, content),
  nanobotStart: () => ipcRenderer.invoke('nanobot:start'),
  nanobotStop: () => ipcRenderer.invoke('nanobot:stop'),
  nanobotStatus: () => ipcRenderer.invoke('nanobot:status'),
  nanobotSyncChannels: (channelsJson: string) =>
    ipcRenderer.invoke('nanobot:syncChannels', channelsJson),
  nanobotGetChannels: () => ipcRenderer.invoke('nanobot:getChannels'),
  nanobotSyncMcp: (mcpJson: string) =>
    ipcRenderer.invoke('nanobot:syncMcp', mcpJson),
  nanobotGetMcp: () => ipcRenderer.invoke('nanobot:getMcp'),
  nanobotSyncTasks: (tasksJson: string) =>
    ipcRenderer.invoke('nanobot:syncTasks', tasksJson),
  nanobotListCronRuns: () => ipcRenderer.invoke('nanobot:listCronRuns'),
  nanobotGetCronSession: (taskId: string) =>
    ipcRenderer.invoke('nanobot:getCronSession', taskId),
  nanobotDeleteCronHistory: (taskId: string) =>
    ipcRenderer.invoke('nanobot:deleteCronHistory', taskId),
  nanobotListChannelSessions: () => ipcRenderer.invoke('nanobot:listChannelSessions'),
  nanobotGetChannelSession: (key: string) =>
    ipcRenderer.invoke('nanobot:getChannelSession', key),
  nanobotSendChannelMessage: (params) =>
    ipcRenderer.invoke('nanobot:sendChannelMessage', params),
  nanobotChannelConnect: (action: ChannelConnectAction, channel: string, params: Record<string, string>) =>
    ipcRenderer.invoke('nanobot:channelConnect', action, channel, params),
  nanobotRestartGateway: (engineChannel?: string) =>
    ipcRenderer.invoke('nanobot:restartGateway', engineChannel),
  nanobotDisconnectChannel: (kind: string) =>
    ipcRenderer.invoke('nanobot:disconnectChannel', kind),
  /** 在系统文件管理器中打开路径（资源管理器/Finder） */
  openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
  /** 读取本地文件为 base64（复制消息粘贴恢复附件用） */
  readFileAsBase64: (path: string) =>
    ipcRenderer.invoke('fs:readFileAsBase64', path),
  loadUserSkills: () => ipcRenderer.invoke('skills:loadUser'),
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  // ——— 窗口控制（自绘标题栏）———
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowToggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
  windowClose: () => ipcRenderer.send('window:close'),
  windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  windowReload: () => ipcRenderer.send('window:reload'),
  windowToggleDevTools: () => ipcRenderer.send('window:toggle-devtools'),
  windowToggleFullScreen: () => ipcRenderer.send('window:toggle-fullscreen'),
  getPlatform: () => process.platform as PlatformName,
  onWindowMaximizeChange: (cb: (maximized: boolean) => void) =>
    ipcRenderer.on('window:maximize-change', (_e, maximized: boolean) => cb(maximized)),
  appGetInfo: () => ipcRenderer.invoke('app:getInfo'),
  // —— 桌面端集成：系统托盘 & 全局快捷键 ——
  appGetDesktopConfig: () => ipcRenderer.invoke('app:getDesktopConfig'),
  appSetDesktopConfig: (patch) => ipcRenderer.invoke('app:setDesktopConfig', patch),
  appShowWindow: () => ipcRenderer.send('app:showWindow'),
  appQuit: () => ipcRenderer.send('app:quit'),
  onAppNavigate: (cb: (path: string) => void) => {
    const listener = (_e: unknown, path: string) => cb(path);
    ipcRenderer.on('app:navigate', listener);
    return () => ipcRenderer.removeListener('app:navigate', listener);
  },
  onAppOpenAbout: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on('app:open-about', listener);
    return () => ipcRenderer.removeListener('app:open-about', listener);
  },
  onDesktopConfigChange: (cb: (config: DesktopConfig) => void) => {
    const listener = (_e: unknown, config: DesktopConfig) => cb(config);
    ipcRenderer.on('app:desktop-config-changed', listener);
    return () => ipcRenderer.removeListener('app:desktop-config-changed', listener);
  },
};

contextBridge.exposeInMainWorld('electronAPI', api);
