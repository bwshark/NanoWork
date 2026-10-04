import { useEffect, useMemo } from 'react';
import {
  resolveModelCapabilities,
  type ResolvedCapabilities,
} from '@/lib/modelCapability';
import { useModelsStore } from '@/stores/modelsStore';
import { useSessionsStore } from '@/stores/sessionsStore';

/**
 * 当前会话生效模型的能力（FR-9.3）。
 *
 * ## 为什么要在这里补读一次 `loadManaged`
 *
 * 预设元数据此前只有设置页会用（`ModelsSection` 进入时读一次），而能力门控发生在
 * **聊天页**——用户完全可能一次都没打开过设置。不补读的话，门控在「刚装好、直接开聊」
 * 的场景下永远拿不到元数据，只能落到宽松默认（那样门控形同虚设，且完全没有迹象）。
 *
 * 补读是**幂等且自限**的：只在 `managed` 为空时触发一次。Web 端 / 引擎读不到配置时
 * `managed` 会一直是空数组，于是每次挂载都会再试一次——这是可接受的代价
 * （一次本地 IPC / 一次 null），换来的是「配置后来可读了就能自动生效」。
 * `loadManaged` 默认复用飞行中的请求，因此并发的组件挂载不会打多次 IPC。
 *
 * ## Auto 的语义
 *
 * 会话没选模型时（`undefined`）实际生效的是引擎的默认预设，解析交给
 * `resolveModelCapabilities`（它按 `isDefault` 找），本钩子只负责把值取对。
 */
export function useActiveModelCapabilities(): ResolvedCapabilities {
  const managed = useModelsStore((s) => s.managed);
  const loadManaged = useModelsStore((s) => s.loadManaged);
  const activeId = useSessionsStore((s) => s.activeId);
  const model = useSessionsStore((s) =>
    activeId ? s.sessions.find((x) => x.id === activeId)?.model : undefined,
  );

  useEffect(() => {
    if (managed.length === 0) void loadManaged();
  }, [managed.length, loadManaged]);

  return useMemo(() => resolveModelCapabilities(managed, model), [managed, model]);
}
