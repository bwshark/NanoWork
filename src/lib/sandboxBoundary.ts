/*
 * FR-8.5 沙箱边界：当前真正生效的隔离手段，与明确没做的部分。
 *
 * ## 为什么要有这个模块（而不是只在文档里写一段）
 *
 * PRD §11.3 把 V1 的沙箱写成「引擎自带 tools/sandbox.py + 工作目录限制 + 网络出口
 * 白名单 + 删除走回收站」。逐条核对代码后，说法与代码并不是一回事：
 * 沙箱后端确实有（agent/tools/sandbox.py），但只有 bwrap 一个后端、只支持 Linux、
 * 默认关闭（tools.exec.sandbox 空串）——Windows 上配了也只打一条警告然后裸跑；
 * 「网络出口白名单」则完全没有（只有 SSRF 防护）。
 *
 * 这种「文档说得很像有」的状态最危险：用户据此认为「助手跑在容器里」，于是在
 * 完全访问模式下把整个项目目录交给它；出了问题再回头查，才发现隔离从来只是
 * 工具边界上的策略，不是操作系统的隔离边界。
 *
 * 所以本期（V1.7 对 FR-8.5 的收口口径）不做 native 沙箱，只做一件事：
 * 把「已有什么 / 缺什么 / 缺口归哪个版本」写死成一份可被界面与用例共同消费的表。
 * 表在这里是唯一来源，设置页只负责渲染 —— 免得文案与事实各说一套。
 *
 * ⚠️ 改这张表时请先回代码核对（security/、electron/windowPreferences.ts、
 * electron/main.ts 的 webPreferences）。表里每一句都能指向落点，这是它存在的意义。
 * ⚠️ 这里的字符串是直接渲染的纯文本：不要写 markdown 标记（星号 / 反引号），
 * 界面不会解析，用户看到的就是原字符。
 */

/** 某一层的状态。 */
export type SandboxLayerStatus = 'on' | 'partial' | 'off';

export interface SandboxLayer {
  /** 稳定 id（用例与文档引用它，不要改名） */
  id: string;
  /** 层次名（界面左侧标题） */
  layer: string;
  /** 归属：谁提供的这一层 */
  owner: 'electron' | 'engine' | 'both';
  /** on = 完整生效 / partial = 生效但有明确缺口 / off = 根本没有 */
  status: SandboxLayerStatus;
  /** 现在真的有的东西（可指向代码落点） */
  enforced: string;
  /** 恰好缺的那一块；on 状态为空串 */
  gap: string;
}

/** 状态中文标签（渲染用）。 */
export const SANDBOX_STATUS_LABELS: Record<SandboxLayerStatus, string> = {
  on: '已生效',
  partial: '部分生效',
  off: '没有',
};

/** 一句话总结（界面顶部与文档共用）。把「不是操作系统级隔离」放在最前，那是最大的误读点。 */
export const SANDBOX_BOUNDARY_SUMMARY =
  'V1 的沙箱是策略边界，不是操作系统级隔离：没有容器、没有独立用户、没有目录 ACL。' +
  '下面五项是本机实际生效的手段，以及各自恰好缺的那一块。';

/** 边界表（顺序即界面顺序：从「谁在跑」到「能不能碰系统」）。 */
export const SANDBOX_LAYERS: readonly SandboxLayer[] = [
  {
    id: 'renderer-shell',
    layer: '渲染层进程外壳',
    owner: 'electron',
    status: 'on',
    enforced:
      '主窗口与全部辅助窗口 contextIsolation: true / nodeIntegration: false / sandbox: true；' +
      'webSecurity: false 只有主窗口显式认领（理由：file:// 页面要直连本地网关），' +
      'image-decoder 是唯一的 sandbox: false，且强制独立 partition（不与主窗口共享会话）。',
    gap: '',
  },
  {
    id: 'tool-gateway',
    layer: '工具网关（要不要执行、要不要问人）',
    owner: 'engine',
    status: 'on',
    enforced:
      'decide_tier 三档（放行 / 沙箱内 / 拒绝）：只读放行、删除类走回收站、其余一律拒绝（含 mcp__* 与未知工具）；' +
      '逐条批准、执行模式（Ask/Plan/Craft）、Agent 工具白名单与黑名单（黑名单恒压白名单）、插件钩子只能收紧；' +
      '每一次决策写 audit/tool-gateway.ndjson。',
    gap: '',
  },
  {
    id: 'filesystem',
    layer: '文件系统（能读写哪里）',
    owner: 'engine',
    status: 'partial',
    enforced:
      '限定工作区模式下路径被钉在工作区内；完全访问模式默认拒绝写与删（除非路径规则放行）；' +
      '凭据目录与私钥文件无条件不可访问（连读都禁，白名单也放不开）；删除一律走系统回收站且失败不降级；' +
      '写入前有 file-history/<hash>.bak 快照可回滚。',
    gap:
      '这些约束只在经过引擎工具时成立。模型用命令执行（exec）起的进程默认不受路径隔离约束——' +
      '命令能碰什么取决于命令本身，引擎对它只有一层 best-effort 的关键字守卫（拦删除类动词、内网 URL）。' +
      '唯一例外是 Linux 上显式开启 bwrap（tools.exec.sandbox 设为 bwrap），此时 bind 根参与路径校验；本机是 Windows，没有这个后端。',
  },
  {
    id: 'network',
    layer: '网络出口',
    owner: 'engine',
    status: 'partial',
    enforced:
      'SSRF 防护：默认拦截内网与回环地址，ssrf_whitelist 可按 CIDR 豁免，DNS 解析结果被固定以防重绑定攻击。',
    gap:
      '没有域名出口白名单（PRD §11.3 写的那条尚未实现）。引擎不判断「这个域名该不该被访问」，' +
      '只判断「它是不是内网地址」。',
  },
  {
    id: 'os-isolation',
    layer: '操作系统级隔离',
    owner: 'engine',
    status: 'partial',
    enforced:
      'Linux 侧有 bwrap 后端（agent/tools/sandbox.py）：命令跑在独立命名空间里，只有工作区可写、' +
      '配置目录被 tmpfs 遮住、媒体目录只读挂载。进程回收另有 Windows Job Object（agent/tools/_windows_job.py，' +
      '网关退出时杀掉子进程树——解决的是泄漏，不是隔离）。',
    gap:
      'bwrap 默认关闭（tools.exec.sandbox 空串）且只有 Linux 可用：Windows 上没有后端，配了只打一条 ' +
      '「not supported on Windows; running unsandboxed」然后裸跑——本机是 Windows，因此这一层实际等同没有。' +
      '也没有容器 / 独立用户 / 目录 ACL / AppContainer，归属 V3（gVisor-Firecracker 一次性容器 + 租户网络策略）；' +
      '本期明确不做 native 沙箱：B5 的结论是「没有真实诉求就不为对齐而做」。',
  },
];

/** 卡片底部那句结论：用户真正的决策点是「要不要开完全访问」，不写这句，上面的表会被读成「放开也没事」。 */
export const SANDBOX_RISK_NOTE =
  '结论：最高一档的隔离来自你的判断，不是系统。完全访问模式等于把工作区交给助手，' +
  '而命令执行没有文件系统隔离——不要在含有生产凭据的目录里开它。';
