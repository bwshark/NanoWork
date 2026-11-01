/**
 * 专家页的「随包专家」提示条。
 *
 * 这条链路有三处静默失败点，用例只盯它们：
 *
 * 1. **判重按名字**：导入后条目必须消失，否则用户会连点出三份同名专家；
 * 2. **导入走 `importAgent`**：不能改掉全局活跃专家（用户只是在"收下"别人给的专家）；
 * 3. **非桌面端不渲染**：Web 端没有插件目录，给一个永远空的条带是噪音。
 */

import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const platformMock = vi.hoisted(() => ({ env: 'electron' as 'electron' | 'web' }));

vi.mock('@/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform')>();
  return {
    ...actual,
    platform: {
      ...actual.platform,
      get env() {
        return platformMock.env;
      },
      scanPlugins: async () => ({ plugins: [], skipped: [], pluginsRoot: 'C:/u/.nanowork/plugins' }),
      extensionsScan: async () => ({
        extensions: [],
        skipped: [],
        extensionsRoot: '',
      }),
      extensionServiceStatuses: async () => [],
    },
  };
});

import { click, flush, mount, unmount } from '../helpers/reactMount';
import { ImportableExpertsBar } from '@/components/agents/ImportableExpertsBar';
import { useAgentsStore } from '@/stores/agentsStore';
import { useExpertGroupsStore } from '@/stores/expertGroupsStore';
import { usePluginsStore } from '@/stores/pluginsStore';
import type { PluginView } from '@/types/plugin';

function pluginView(experts: Array<{ name: string; type: 'agent' | 'team' }>): PluginView {
  return {
    plugin: {
      manifest: {
        name: 'demo-plugin',
        displayName: '演示插件',
        version: '1.0.0',
        versionDeclared: true,
        description: '',
        repository: '',
        category: 'Development',
        main: 'SKILL.md',
        permissions: { tools: [], network: [] },
        engineRange: '',
        schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.json',
        manifestRelPath: 'plugin.json',
      },
      root: 'C:/u/.nanowork/plugins/demo-plugin',
      resources: [],
      expertPackages: experts.map((expert) => ({
        name: expert.name.toLowerCase(),
        displayName: expert.name,
        description: '演示',
        expertType: expert.type,
        agents:
          expert.type === 'team'
            ? [
                { agentName: 'lead', name: `${expert.name}团长`, profession: '主理人', systemPrompt: 'a' },
                { agentName: 'member', name: `${expert.name}成员`, profession: '成员', systemPrompt: 'b' },
              ]
            : [
                {
                  agentName: expert.name.toLowerCase(),
                  name: expert.name,
                  profession: '工程师',
                  systemPrompt: '你是' + expert.name,
                },
              ],
      })),
    },
    activation: 'unknown',
    intended: true,
    drift: 'unknown',
    engineIncompatible: false,
    hooks: { active: 0, events: {}, dropped: 0 },
    source: { market: null, version: '1.0.0' },
  };
}

const render = () =>
  mount(
    <MemoryRouter>
      <ImportableExpertsBar />
    </MemoryRouter>,
  );

beforeEach(() => {
  platformMock.env = 'electron';
  useAgentsStore.setState({ agents: [], tombstones: {}, activeAgentId: null });
  useExpertGroupsStore.setState({ groups: [], tombstones: {}, activeGroupId: null });
  usePluginsStore.setState({ installed: [], loaded: true });
  unmount();
});

describe('ImportableExpertsBar', () => {
  it('列出未导入的随包专家，点 Chip 直接导入', async () => {
    usePluginsStore.setState({ installed: [pluginView([{ name: '机器学习专家', type: 'agent' }])] });
    const host = render();
    await flush();

    expect(host.textContent).toContain('插件带来 1 位专家');

    const chip = [...host.querySelectorAll('.MuiChip-root')].find((el) =>
      (el.textContent ?? '').includes('机器学习专家'),
    );
    click(chip);
    await flush();

    const agents = useAgentsStore.getState().agents;
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('机器学习专家');
  });

  it('⭐ 导入后按同名判重：条带消失，不会再点一次', async () => {
    usePluginsStore.setState({ installed: [pluginView([{ name: '机器学习专家', type: 'agent' }])] });
    const first = render();
    await flush();
    click(
      [...first.querySelectorAll('.MuiChip-root')].find((el) =>
        (el.textContent ?? '').includes('机器学习专家'),
      ),
    );
    await flush();

    // 重新挂载：store 里已有同名专家 → 提示条不该再出现
    const second = render();
    await flush();
    expect(second.textContent ?? '').not.toContain('插件带来');
    expect(useAgentsStore.getState().agents).toHaveLength(1);
  });

  it('「全部导入」把团队包落成「N 位成员 + 1 个团」', async () => {
    usePluginsStore.setState({
      installed: [pluginView([{ name: '选品作战团', type: 'team' }])],
    });
    const host = render();
    await flush();

    const all = [...host.querySelectorAll('button')].find((el) =>
      (el.textContent ?? '').includes('全部导入'),
    );
    click(all);
    await flush();

    expect(useAgentsStore.getState().agents).toHaveLength(2);
    expect(useExpertGroupsStore.getState().groups).toHaveLength(1);
    expect(useExpertGroupsStore.getState().groups[0].memberIds).toHaveLength(2);
  });

  it('导入不动全局活跃专家（只是收下，不是换成他去用）', async () => {
    useAgentsStore.setState((s) => ({ ...s, activeAgentId: 'builtin:general' }));
    usePluginsStore.setState({ installed: [pluginView([{ name: '法务专家', type: 'agent' }])] });
    const host = render();
    await flush();
    click(
      [...host.querySelectorAll('button')].find((el) => (el.textContent ?? '').includes('全部导入')),
    );
    await flush();
    expect(useAgentsStore.getState().activeAgentId).toBe('builtin:general');
  });

  it('Web 端不渲染（浏览器里没有插件目录，给空条带是噪音）', async () => {
    platformMock.env = 'web';
    usePluginsStore.setState({ installed: [pluginView([{ name: '甲', type: 'agent' }])] });
    const host = render();
    await flush();
    expect(host.textContent ?? '').not.toContain('插件带来');
  });

  it('没有随包专家时什么都不渲染', async () => {
    usePluginsStore.setState({ installed: [pluginView([])] });
    const host = render();
    await flush();
    expect(host.textContent ?? '').toBe('');
  });
});
