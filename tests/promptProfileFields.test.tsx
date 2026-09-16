/**
 * 领域 / 风格选择器（design §13.1）。
 *
 * 三个调用点（设置页 + 两个 Agent 编辑弹窗）共用这一个组件，所以要锁的是它的
 * **语义契约**，而不是视觉：
 *
 * 1. 「跟随全局」必须把**继承结果**写出来（跟随全局（工程）），只写「默认」等于没说；
 * 2. 设置页（`allowInherit=false`）不能出现「跟随全局」——全局层没有上一层可跟；
 * 3. **未知槽位 id 原样展示**，绝不静默替换成默认值。存储里留着一个已被移除的
 *    key 是真实场景（版本降级 / 手工改过存储），把它显示成「通用」会让人以为
 *    自己选的就是通用，而装配时拿到的是空串。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { PromptProfileFields } from '@/components/prompts/PromptProfileFields';
import { flush, mount, unmount } from './helpers/reactMount';

const noop = () => undefined;

beforeEach(() => {
  unmount();
});

describe('PromptProfileFields', () => {
  it('未设置时展示「跟随全局」及继承到的标签', async () => {
    const host = mount(
      <PromptProfileFields
        allowInherit
        globalDomain="code"
        globalStyle="style-efficient"
        onDomainChange={noop}
        onStyleChange={noop}
      />,
    );
    await flush();

    expect(host.textContent).toContain('跟随全局（工程）');
    expect(host.textContent).toContain('跟随全局（高效）');
    expect(host.textContent).not.toContain('未选择');
  });

  it('全局值缺失时「跟随全局」回退到默认标签', async () => {
    const host = mount(
      <PromptProfileFields
        allowInherit
        onDomainChange={noop}
        onStyleChange={noop}
      />,
    );
    await flush();

    expect(host.textContent).toContain('跟随全局（通用）');
    expect(host.textContent).toContain('跟随全局（专业）');
  });

  it('设置页（allowInherit=false）不出现「跟随全局」', async () => {
    const host = mount(
      <PromptProfileFields
        domain="general"
        style="style-professional"
        onDomainChange={noop}
        onStyleChange={noop}
      />,
    );
    await flush();

    expect(host.textContent).not.toContain('跟随全局');
    expect(host.textContent).toContain('通用');
    expect(host.textContent).toContain('专业');
  });

  it('显式选中时不展示继承标签', async () => {
    const host = mount(
      <PromptProfileFields
        domain="design"
        style="style-direct"
        allowInherit
        globalDomain="code"
        globalStyle="style-efficient"
        onDomainChange={noop}
        onStyleChange={noop}
      />,
    );
    await flush();

    expect(host.textContent).not.toContain('跟随全局');
    expect(host.textContent).toContain('设计');
    expect(host.textContent).toContain('直白');
  });

  it('未知槽位 id 原样展示，不静默替换成默认值', async () => {
    const host = mount(
      <PromptProfileFields
        domain="legacy-domain"
        style="legacy-style"
        onDomainChange={noop}
        onStyleChange={noop}
      />,
    );
    await flush();

    expect(host.textContent).toContain('legacy-domain');
    expect(host.textContent).toContain('legacy-style');
    expect(host.textContent).not.toContain('未选择');
  });
});
