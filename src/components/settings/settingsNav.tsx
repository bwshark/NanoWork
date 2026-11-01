import type { ReactNode } from 'react';
import BookmarksOutlinedIcon from '@mui/icons-material/BookmarksOutlined';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import CloudOutlinedIcon from '@mui/icons-material/CloudOutlined';
import ExtensionIcon from '@mui/icons-material/Extension';
import HubIcon from '@mui/icons-material/Hub';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import KeyboardAltOutlinedIcon from '@mui/icons-material/KeyboardAltOutlined';
import PortraitOutlinedIcon from '@mui/icons-material/PortraitOutlined';
import RecordVoiceOverOutlinedIcon from '@mui/icons-material/RecordVoiceOverOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import SmartphoneIcon from '@mui/icons-material/Smartphone';
import StorageIcon from '@mui/icons-material/Storage';
import TuneIcon from '@mui/icons-material/Tune';
import WidgetsOutlinedIcon from '@mui/icons-material/WidgetsOutlined';
import type { SettingsSectionId } from '@/stores/settingsUiStore';

/**
 * 设置弹窗左侧菜单的数据模型（声明式，弹窗只负责渲染，不内联业务判断）。
 *
 * 分组对齐 WorkBuddy 的设置窗口：**顶部无标题组**（通用类）→「功能」→
 * 「数据与安全」→ **底部无标题组**（关于）。分组标题存在的意义是回答
 * 「这一项属于配置哪一类」，而不是凑数——所以没有标题的第一组里只放
 * 真正全局的东西（通用 / 连接 —— 连哪个网关、怎么唤起）。
 */
export interface SettingsNavItem {
  id: SettingsSectionId;
  label: string;
  icon: ReactNode;
}

export interface SettingsNavGroup {
  /** 分组标题；省略 = 无标题组（顶部通用组与底部关于组） */
  label?: string;
  items: SettingsNavItem[];
}

/**
 * 左侧菜单定义——**唯一事实源**。
 *
 * 分区标题（右侧内容区顶部）直接取这里的 `label`，不再各自写一遍：
 * 两处各写一份字面量，改一处漏一处就会出现「菜单叫助理设置、标题叫助理」。
 */
export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    items: [
      { id: 'general', label: '通用', icon: <TuneIcon /> },
      // 快捷键紧挨通用：它和主题、托盘一样属于「这台机器上我怎么用」的偏好，
      // 而不是「助手是谁 / 装了哪些包」那种能力配置，所以不放进下面的「功能」组。
      { id: 'shortcuts', label: '快捷键', icon: <KeyboardAltOutlinedIcon /> },
      // 只管网关地址与语音输入：模型另有独立分区（下面「功能」组），
      // 混在一个入口里会让「改网关」和「加模型」互相挤占版面
      { id: 'connection', label: '连接', icon: <HubIcon /> },
    ],
  },
  {
    label: '功能',
    items: [
      // 「记忆 / 人格 / 助理 / 插件」原先挂在侧边栏，现整体收进设置：
      // 它们改的是「助手是谁、记得什么、怎么被外部触达、装了哪些包」，
      // 都属于配置而非日常操作，和「新建任务 / 定时任务 / 扩展」不同类。
      { id: 'memory', label: '记忆', icon: <BookmarksOutlinedIcon /> },
      { id: 'persona', label: '人格', icon: <PortraitOutlinedIcon /> },
      // 模型紧挨「助理设置」：两者回答的是同一个问题「这个助手用哪个脑子想」，
      // 人格管怎么说、模型管用什么算
      { id: 'models', label: '模型', icon: <SmartToyOutlinedIcon /> },
      // 语音紧跟模型：模型回答「怎么想」，语音回答「怎么听进去、怎么念出来」。
      // 独立成区而不是挂在「连接」里——那里是网关（本机进程），语音是直连
      // 第三方服务商的另一套凭据，混在一起时「改网关」和「配麦克风」互相挤版面，
      // 而合成（TTS）压根没地方放，用户只能去配置文件里手写。
      { id: 'voice', label: '语音', icon: <RecordVoiceOverOutlinedIcon /> },
      { id: 'assistant', label: '助理设置', icon: <SmartphoneIcon /> },
      { id: 'plugins', label: '插件', icon: <ExtensionIcon /> },
      // 扩展紧挨插件：两者都是"往宿主里装东西"，但一个改 AI 的技能与工具面、
      // 一个给应用加界面与后台服务。放一起便于对照，名字也要能一眼分开。
      { id: 'extensions', label: '扩展', icon: <WidgetsOutlinedIcon /> },
    ],
  },
  {
    label: '数据与安全',
    items: [
      // 「账户」放「数据管理」之前：它回答的是「数据同步到哪个账户」，
      // 是「数据管理」的前置身份，同属「数据与安全」一类。
      { id: 'account', label: '账户', icon: <CloudOutlinedIcon /> },
      { id: 'data', label: '数据管理', icon: <StorageIcon /> },
      // 「安全」紧挨「数据管理」：两者回答的都是**边界**——一个说东西存在哪、
      // 一个说助手能写到哪 / 哪些地方碰都不许碰。放在数据管理之前，是因为
      // 「能写哪里」是「东西存在哪」的前置约束，读起来是「先定边界，再定落点」。
      { id: 'security', label: '安全', icon: <ShieldOutlinedIcon /> },
      // 用量紧挨「数据管理」：两者看的都是**本机已发生的事实**（存了什么 / 跑了多少），
      // 与上面「功能」组那种「开了什么能力」不是一回事。
      { id: 'usage', label: '用量', icon: <InsightsOutlinedIcon /> },
      // 诊断与「用量」同类（也是本机事实的查看），但它回答的是「东西在哪、怎么带走」，
      // 是排障入口而不是报表，所以排在用量之后、账户之前。
      { id: 'diagnostics', label: '诊断', icon: <BugReportOutlinedIcon /> },
    ],
  },
  {
    items: [{ id: 'about', label: '关于', icon: <InfoOutlinedIcon /> }],
  },
];

/** id → 菜单项 的扁平索引，供分区标题等按 id 反查 */
export const SETTINGS_NAV_ITEMS: Record<SettingsSectionId, SettingsNavItem> =
  SETTINGS_NAV.reduce(
    (acc, group) => {
      for (const item of group.items) acc[item.id] = item;
      return acc;
    },
    {} as Record<SettingsSectionId, SettingsNavItem>,
  );
