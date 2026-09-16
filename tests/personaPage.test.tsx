/**
 * 人格页（FR-4.3 身份文件 + 提示词外置）。
 *
 * 这里锁四件事，都是「看起来能跑但会静默出错」的地方：
 *
 * 1. **引导态横幅只在 BOOTSTRAP.md 非空时出现**，点「完成引导」真的删掉该文件——
 *    否则之后每个新会话都会重新进入引导态；
 * 2. **「恢复默认」删文件而不是写空文件**，且「未写过」与「空文件」在 UI 上是两种状态；
 * 3. **提示词槽位保存写到磁盘覆盖路径**，恢复默认把它删掉回内置正文；
 * 4. **风格模板缺内容质量护栏时给出警告**——风格可以改，事实与准确性不能跟着改。
 *
 * 种子数据走服务 API 而非裸写 localStorage：Web 存储适配器会 JSON 序列化取值，
 * 裸写字符串会在读取时被 `JSON.parse` 打回 null（见 tests/memoryPageScope.test.tsx 的注释）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { PersonaPage } from '@/pages/persona/PersonaPage';
import { IdentityService } from '@/lib/identity';
import { PromptLibrary } from '@/lib/promptLibrary';
import { platform } from '@/platform';
import { IDENTITY_STORAGE_KEYS } from '@/lib/constants';
import {
  buttonByText,
  byAria,
  click,
  dialogRoot,
  flush,
  mount,
  setInputValue,
  unmount,
} from './helpers/reactMount';

const SOUL_KEY = IDENTITY_STORAGE_KEYS.soul;
const IDENTITY_KEY = IDENTITY_STORAGE_KEYS.identity;
const BOOTSTRAP_KEY = IDENTITY_STORAGE_KEYS.bootstrap;

/** 身份文件的「有没有」要问磁盘：`IdentityService.save('')` 与 `remove` 都让正文为空 */
async function fileExists(key: string): Promise<boolean> {
  return (await platform.storage.get<string>(key)) !== null;
}

beforeEach(() => {
  unmount();
  // 两个服务都是单例，内存快照必须逐例重置，否则上一例的读盘结果会漏进来
  IdentityService.__resetForTest();
  PromptLibrary.__resetForTest();
});

describe('PersonaPage 身份文件', () => {
  it('四个身份文件都列出，未写过的显示「未写过」', async () => {
    const host = mount(<PersonaPage />);
    await flush();

    for (const filename of ['SOUL.md', 'IDENTITY.md', 'USER.md', 'BOOTSTRAP.md']) {
      expect(host.textContent).toContain(filename);
    }
    expect(host.textContent).toContain('未写过');
    expect(host.textContent).not.toContain('当前处于一次性引导态');
  });

  it('BOOTSTRAP.md 非空时进入引导态，完成后删除该文件', async () => {
    await IdentityService.save('bootstrap', '你是新生的助手，请先完成自我设定。');
    IdentityService.__resetForTest();

    const host = mount(<PersonaPage />);
    await flush();

    expect(host.textContent).toContain('当前处于一次性引导态');

    click(buttonByText(host, '完成引导'));
    await flush();

    expect(await fileExists(BOOTSTRAP_KEY)).toBe(false);
    expect(host.textContent).not.toContain('当前处于一次性引导态');
  });

  it('BOOTSTRAP.md 存在但为空时不进入引导态', async () => {
    // 空文件是用户自己关掉了这段流程，再把人困在里面是错的
    await IdentityService.save('bootstrap', '   ');
    IdentityService.__resetForTest();

    const host = mount(<PersonaPage />);
    await flush();

    expect(host.textContent).not.toContain('当前处于一次性引导态');
  });

  it('「恢复默认」删除磁盘文件（而不是写空文件）', async () => {
    const soul = '我的原则：先读代码再改代码。';
    await IdentityService.save('soul', soul);
    IdentityService.__resetForTest();

    const host = mount(<PersonaPage />);
    await flush();
    expect(host.textContent).toContain(`${soul.length} 字符`);

    click(byAria('恢复默认 SOUL.md', host));
    await flush();

    expect(await fileExists(SOUL_KEY)).toBe(false);
    expect(host.textContent).toContain('未写过');
  });

  it('空文件与未写过是两种状态', async () => {
    await IdentityService.save('soul', '');
    IdentityService.__resetForTest();

    const host = mount(<PersonaPage />);
    await flush();

    expect(host.textContent).toContain('空文件');
    expect(host.textContent).toContain('文件存在但内容为空');
    // 文件确实在（空内容 ≠ 删除）
    expect(await fileExists(SOUL_KEY)).toBe(true);
  });

  it('编辑身份文件后保存写入真实文件', async () => {
    const host = mount(<PersonaPage />);
    await flush();

    click(byAria('编辑 IDENTITY.md', host));
    await flush();

    const identityText = '我是谁：一个只读优先的工程助手。';
    setInputValue(dialogRoot().querySelector('textarea'), identityText);
    click(buttonByText(document.body, '保存'));
    await flush();

    expect(await platform.storage.get<string>(IDENTITY_KEY)).toBe(identityText);
    expect(host.textContent).toContain(`${identityText.length} 字符`);
  });
});

describe('PersonaPage 提示词模板', () => {
  it('槽位默认展示为内置默认，保存后标记为已自定义', async () => {
    const host = mount(<PersonaPage />);
    await flush();

    click(buttonByText(host, '提示词模板'));
    await flush();

    expect(host.textContent).toContain('内置默认');

    click(byAria('编辑提示词 专业', host));
    await flush();

    const textarea = dialogRoot().querySelector('textarea') as HTMLTextAreaElement;
    // 预填的是最终生效正文（内置默认），不是空白
    expect(textarea.value).toContain('语气风格：专业');

    setInputValue(
      textarea,
      '语气风格：专业。\n\n- 只说事实。\n- 只改变信息的表达方式，不改变信息本身。',
    );
    click(buttonByText(document.body, '保存'));
    await flush();

    expect(await PromptLibrary.readRaw('style', 'style-professional')).toContain(
      '只说事实',
    );
    expect(host.textContent).toContain('已自定义');
  });

  it('恢复默认把覆盖删掉，回到内置正文', async () => {
    await PromptLibrary.save('style', 'style-professional', '我家自定义的风格');
    PromptLibrary.__resetForTest();

    const host = mount(<PersonaPage />);
    await flush();
    click(buttonByText(host, '提示词模板'));
    await flush();

    expect(host.textContent).toContain('已自定义');

    click(byAria('恢复默认提示词 专业', host));
    await flush();

    expect(await PromptLibrary.readRaw('style', 'style-professional')).toBeNull();
    // 删除覆盖 ≠ 正文变空：resolveSync 回退到内置默认
    expect(PromptLibrary.resolveSync('style', 'style-professional')).toContain(
      '语气风格：专业',
    );
  });

  it('风格模板缺少内容质量护栏时给出警告', async () => {
    const host = mount(<PersonaPage />);
    await flush();
    click(buttonByText(host, '提示词模板'));
    await flush();

    click(byAria('编辑提示词 专业', host));
    await flush();

    // 把护栏那一行删掉——风格是用户的自由，但不该无声无息地去掉这道拦截
    setInputValue(
      dialogRoot().querySelector('textarea'),
      '语气风格：专业。\n\n- 措辞要严谨。',
    );

    expect(dialogRoot().textContent).toContain('缺少内容质量护栏');
  });

  it('用户级覆盖从磁盘读入，加载后即显示为已自定义', async () => {
    await PromptLibrary.save(
      'style',
      'style-professional',
      '语气风格：专业。\n\n- 只改变信息的表达方式，不改变信息本身。',
    );
    PromptLibrary.__resetForTest();

    const host = mount(<PersonaPage />);
    await flush();
    click(buttonByText(host, '提示词模板'));
    await flush();

    // 页签上的计数来自 PromptLibrary 快照（磁盘覆盖数），不是写死的
    expect(host.textContent).toContain('1 项自定义');
  });
});
