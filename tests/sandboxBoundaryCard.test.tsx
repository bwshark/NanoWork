/**
 * FR-8.5 沙箱边界卡片：**界面必须把缺口也渲染出来**。
 *
 * 只测纯数据模块不够——卡片完全可以只渲染 `enforced` 而丢掉 `gap`，
 * 界面于是变成一份「我们有沙箱」的宣传页。所以这里钉两件事：
 * ① 每一层都出现在界面上；② 有缺口的层必须出现「缺口：」字样。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { platform } from '@/platform';
import { SecuritySection } from '@/components/settings/sections/SecuritySection';
import { SANDBOX_LAYERS } from '@/lib/sandboxBoundary';
import { useToolsPolicyStore } from '@/stores/toolsPolicyStore';
import { flush, mount, unmount } from './helpers/reactMount';

// `act(...)` 需要 React 认识这是一次测试环境；本仓约定由用例自己声明（见 useSyncStatus.test.ts），
// 否则并发跑时会被别的文件留下的全局值影响，出现「not configured to support act」噪声。
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  // 写策略在 Web 环境下读不到引擎配置 → 卡片上方会出 info 提示；这跟边界表无关，
  // 但 store 的 loading 状态会让首帧内容不稳，故预置成「已加载、不可用」。
  useToolsPolicyStore.setState({ policy: null, policyAvailable: false, policyLoading: false });
  vi.spyOn(platform, 'getNanobotTools').mockResolvedValue(null);
});

afterEach(() => {
  unmount();
  vi.restoreAllMocks();
});

describe('沙箱边界卡片', () => {
  it('每一层都渲染出来', async () => {
    const host = mount(<SecuritySection />);
    await flush();
    for (const layer of SANDBOX_LAYERS) {
      const node = host.querySelector(`[data-testid="sandbox-layer-${layer.id}"]`);
      expect(node, `${layer.id} 未渲染`).toBeTruthy();
      expect(node!.textContent).toContain(layer.layer);
    }
  });

  it('有缺口的层把「缺口：」渲染出来，且没有缺口的层不渲染该行', async () => {
    const host = mount(<SecuritySection />);
    await flush();
    for (const layer of SANDBOX_LAYERS) {
      const gap = host.querySelector(`[data-testid="sandbox-gap-${layer.id}"]`);
      if (layer.status === 'on') {
        expect(gap, `${layer.id} 是 on 却渲染了缺口行`).toBeNull();
      } else {
        expect(gap, `${layer.id} 的缺口行没渲染`).toBeTruthy();
        expect(gap!.textContent).toContain('缺口：');
      }
    }
  });

  it('卡片明确写出「没有容器 / 不是操作系统级隔离」这类结论', async () => {
    const host = mount(<SecuritySection />);
    await flush();
    const text = host.textContent ?? '';
    expect(text).toContain('沙箱边界');
    expect(text).toContain('没有容器');
    expect(text).toContain('完全访问');
    // 界面不解析 markdown：数据里混进星号 / 反引号会原样显示给用户。
    // 只检查本卡片自己的节点——同一分区里其它卡片的文案不归这组用例管。
    const cardText = SANDBOX_LAYERS.map(
      (l) =>
        host.querySelector(`[data-testid="sandbox-layer-${l.id}"]`)?.textContent ?? '',
    ).join('\n');
    expect(cardText).not.toBe('');
    expect(cardText).not.toContain('**');
    expect(cardText).not.toContain('`');
  });
});
