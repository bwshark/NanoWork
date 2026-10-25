import { join, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_ID_STORAGE_KEY,
  knownRouteFiles,
  memoryDir,
  miscDir,
  promptsDir,
  productDir,
  resolveRoute,
  resolveWriteTarget,
  sanitizeSegment,
  serializeRouteValue,
  unwrapLegacyValue,
  type StorageRoots,
} from '../../electron/storageRoutes';
import {
  IDENTITY_FILENAMES,
  IDENTITY_STORAGE_KEYS,
  MEMORY_KEY_PREFIX,
  PROMPT_KEY_PREFIX,
  STORAGE_KEYS,
  USER_MEMORY_KEY,
} from '@/lib/core/constants';
import { LOCAL_MEMORY_SCOPE_KEY } from '@/lib/memory/memoryPlatformIo';

/**
 * 持久化落点路由单测。
 *
 * 覆盖两类容易出错、且出错代价很高的东西：
 * 1. **归属**——用户资产必须落 ① `~/.nanowork/`，运行时数据才落 ② userData；
 *    搞反了在卸载/换机时表现为「配置丢失」或「用户资产被当缓存清掉」。
 * 2. **路径安全**——workspace key 来自路径哈希或用户输入，直接拼路径会越界。
 *
 * 同时把「写进去 → 落盘 → 读回」的往返钉死，避免日后改动适配器的序列化行为时
 * 静默改变落盘形态。
 */

const HOME = resolve('/tmp/nw-home');
const USER_DATA = resolve('/tmp/nw-userdata');
const roots: StorageRoots = { home: HOME, electronUserData: USER_DATA };
const PRODUCT_DIR = join(HOME, '.nanowork');

describe('resolveRoute：落点归属', () => {
  it.each([
    [STORAGE_KEYS.settings, 'settings.json'],
    [STORAGE_KEYS.mcp, 'mcp.json'],
    [STORAGE_KEYS.channels, 'channels.json'],
    [STORAGE_KEYS.agents, join('experts', 'agents.json')],
    [STORAGE_KEYS.expertGroups, join('experts', 'groups.json')],
    [STORAGE_KEYS.skills, join('skills', 'index.json')],
    // 技能覆盖表（用户意图）与索引并列但职责不同；分开落盘是为了让 V1.5 的同步层
    // 直接把它当集合读，不必再过滤掉索引里的事实字段
    [STORAGE_KEYS.skillOverrides, join('skills', 'overrides.json')],
  ])('用户资产 %s 落在 ① %s', (key, rel) => {
    const route = resolveRoute(key, roots);
    expect(route.scope).toBe('user');
    expect(route.filePath).toBe(join(PRODUCT_DIR, rel));
    expect(route.format).toBe('json');
    // 用户资产人工可读可改，一律缩进美化
    expect(route.pretty).toBe(true);
  });

  it.each([
    [STORAGE_KEYS.legacySessions, 'sessions.json'],
    [STORAGE_KEYS.tasks, 'tasks.json'],
    [STORAGE_KEYS.artifacts, 'artifacts.json'],
  ])('运行时数据 %s 落在 ② %s（不占 ① 的位置）', (key, rel) => {
    const route = resolveRoute(key, roots);
    expect(route.scope).toBe('runtime');
    expect(route.filePath).toBe(join(USER_DATA, rel));
    // 体积敏感，紧凑写
    expect(route.pretty).toBe(false);
  });

  it('设备 ID 落 ② 的裸文本文件', () => {
    const route = resolveRoute(DEVICE_ID_STORAGE_KEY, roots);
    expect(route.filePath).toBe(join(USER_DATA, 'device-id.txt'));
    expect(route.format).toBe('text');
  });

  /**
   * 回归：`nanowork.ui.activeSession` 的值是裸 session id，曾因未登记而掉进
   * misc 兜底的 json 路由，`JSON.parse('<uuid>')` 抛错导致写盘整条失败
   * （症状：控制台 "Error occurred in handler for 'storage:set'"，
   * 且「重启记住上次会话」静默失效）。
   */
  it('「上次打开的会话」落 ② 的裸文本文件（值是 session id，不是 JSON）', () => {
    const route = resolveRoute(STORAGE_KEYS.activeSession, roots);
    expect(route.filePath).toBe(join(USER_DATA, 'active-session.txt'));
    expect(route.format).toBe('text');
    expect(route.scope).toBe('runtime');

    // 裸 id 原样落盘、原样读回——不再经过 JSON.parse
    const id = '1234abcd-5678-4def-9012-3456789abcde';
    expect(serializeRouteValue(id, route)).toBe(id);
    expect(serializeRouteValue('', route)).toBe('');
  });

  /**
   * 回归：`nanowork.memoryScope` 的值是**裸字符串** `u_<hex>`（本机用户记忆作用域），
   * 曾因未登记而掉进 misc 兜底的 json 路由 → `JSON.parse('u_6fa1…')` 抛
   * `Unexpected token 'u'` → 写入整条失败（症状：控制台 "Error occurred in handler for
   * 'storage:set'" + 每次启动生成新 scope → 用户级画像/偏好留在旧目录读不回来）。
   */
  it('用户记忆作用域落 ② 的裸文本文件（值是 u_<hex>，不是 JSON）', () => {
    const route = resolveRoute(STORAGE_KEYS.localMemoryScope, roots);
    expect(route.filePath).toBe(join(USER_DATA, 'memory-scope.txt'));
    expect(route.format).toBe('text');
    expect(route.scope).toBe('runtime');

    // 裸 scope id 原样落盘、原样读回——不再经过 JSON.parse
    const scope = 'u_6fa17947348a';
    expect(serializeRouteValue(scope, route)).toBe(scope);

    // 渲染层用的是同一个常量：这条断言把「key 定义在哪」也钉住——
    // 本次事故的成因正是它在 `memory/memoryPlatformIo.ts` 里就地定义，绕开了本表的不变量
    expect(LOCAL_MEMORY_SCOPE_KEY).toBe(STORAGE_KEYS.localMemoryScope);
  });

  it('记忆索引落 ① memory/index.json，工作区记忆落 ① memory/<ws>.md', () => {
    const index = resolveRoute(`${MEMORY_KEY_PREFIX}index`, roots);
    expect(index.filePath).toBe(join(memoryDir(roots), 'index.json'));
    expect(index.format).toBe('json');

    const memory = resolveRoute(`${MEMORY_KEY_PREFIX}default`, roots);
    expect(memory.filePath).toBe(join(memoryDir(roots), 'default.md'));
    expect(memory.format).toBe('text');
    expect(memory.scope).toBe('user');
  });

  it('未登记的 key 兜底到 ② misc/，不丢数据也不污染 ①', () => {
    const route = resolveRoute('nanowork.someFutureStore', roots);
    expect(route.filePath).toBe(join(miscDir(roots), 'nanowork.someFutureStore.json'));
    expect(route.scope).toBe('runtime');
  });

  /**
   * 反回归：`STORAGE_KEYS` 里每个 key 都必须有显式落点。
   * 掉进 misc 兜底意味着「落点形态靠猜」——json 兜底会把裸文本值写崩（见
   * activeSession 的回归用例），所以未登记要在单测里直接暴露。
   */
  it('STORAGE_KEYS 全部显式登记，没有一个掉进 misc 兜底', () => {
    const unregistered = Object.values(STORAGE_KEYS).filter((key) =>
      resolveRoute(key, roots).filePath.startsWith(miscDir(roots) + sep),
    );
    expect(unregistered).toEqual([]);
  });

  it('所有落点都在两个根之内（没有任何 key 逃逸）', () => {
    const keys = [
      ...Object.values(STORAGE_KEYS),
      DEVICE_ID_STORAGE_KEY,
      `${MEMORY_KEY_PREFIX}index`,
      `${MEMORY_KEY_PREFIX}default`,
      'nanowork.unknown',
    ];
    const allowedPrefixes = [PRODUCT_DIR, USER_DATA].map((root) => root + sep);
    for (const key of keys) {
      const { filePath } = resolveRoute(key, roots);
      expect(allowedPrefixes.some((prefix) => filePath.startsWith(prefix))).toBe(true);
    }
  });
});

describe('sanitizeSegment：文件名片段的收敛', () => {
  it('剥掉路径分隔符，阻断目录穿越', () => {
    expect(sanitizeSegment('../../etc/passwd')).not.toContain('/');
    expect(sanitizeSegment('../../etc/passwd')).not.toContain('\\');
    expect(sanitizeSegment('..')).toBe('unnamed');
  });

  it('去首部点号，避免生成隐藏文件', () => {
    expect(sanitizeSegment('.hidden')).toBe('hidden');
  });

  it('Windows 保留设备名加前缀', () => {
    expect(sanitizeSegment('con')).toBe('_con');
    expect(sanitizeSegment('COM1')).toBe('_COM1');
  });

  it('空串/纯符号收敛为 unnamed', () => {
    expect(sanitizeSegment('')).toBe('unnamed');
    expect(sanitizeSegment('///')).toBe('unnamed');
  });

  it('保留常规工作区 key 原样', () => {
    expect(sanitizeSegment('default')).toBe('default');
    expect(sanitizeSegment('a1b2-c3_d4')).toBe('a1b2-c3_d4');
  });

  it('恶意 workspace key 仍落在记忆目录内', () => {
    const route = resolveRoute(`${MEMORY_KEY_PREFIX}..\\..\\evil`, roots);
    expect(route.filePath.startsWith(memoryDir(roots))).toBe(true);
  });
});

describe('serializeRouteValue：落盘形态', () => {
  const jsonRoute = resolveRoute(STORAGE_KEYS.settings, roots);
  const compactRoute = resolveRoute(STORAGE_KEYS.legacySessions, roots);
  const textRoute = resolveRoute(`${MEMORY_KEY_PREFIX}default`, roots);

  it('json 路由落盘为真实结构，而不是被转义的字符串', () => {
    const persisted = { state: { settings: { theme: 'dark' } }, version: 8 };
    const fileText = serializeRouteValue(JSON.stringify(persisted), jsonRoute);
    // 关键：文件内容可直接 JSON.parse 出结构（人类可读可改）
    expect(JSON.parse(fileText)).toEqual(persisted);
    expect(fileText).toContain('\n');
  });

  it('运行时数据紧凑写（不缩进）', () => {
    const persisted = { state: { sessions: [] }, version: 0 };
    const fileText = serializeRouteValue(JSON.stringify(persisted), compactRoute);
    expect(fileText).not.toContain('\n');
    expect(JSON.parse(fileText)).toEqual(persisted);
  });

  it('text 路由原样落盘（Markdown 不应被 JSON 转义）', () => {
    const markdown = '# 记忆\n\n- 偏好：中文\n- 含"引号"与\\反斜杠';
    expect(serializeRouteValue(markdown, textRoute)).toBe(markdown);
  });

  it('json 路由遇到非法 JSON 会抛错（调用方需自担，不静默写坏文件）', () => {
    expect(() => serializeRouteValue('{not-json', jsonRoute)).toThrow();
  });
});

describe('unwrapLegacyValue：旧 blob 的兼容', () => {
  it('剥掉旧链路多出的一层字符串编码', () => {
    const persisted = { state: { settings: { theme: 'dark' } }, version: 8 };
    const single = JSON.stringify(persisted);
    const legacy = JSON.stringify(single); // 旧适配器再 stringify 一次
    expect(unwrapLegacyValue(legacy)).toBe(single);
  });

  it('旧记忆值同样剥一层，还原成纯文本', () => {
    const legacy = JSON.stringify('# 记忆');
    expect(unwrapLegacyValue(legacy)).toBe('# 记忆');
  });

  it('主进程自持的裸文本不含这一层，原样返回', () => {
    expect(unwrapLegacyValue('3f2a-uuid')).toBe('3f2a-uuid');
    expect(unwrapLegacyValue('{not-json')).toBe('{not-json');
  });

  it('结构值（非字符串）保持不变，不做多余剥离', () => {
    const arr = JSON.stringify([1, 2, 3]);
    expect(unwrapLegacyValue(arr)).toBe(arr);
  });
});

describe('往返：写进去什么，读回来什么', () => {
  it('zustand 的持久化文档往返后仍可被 JSON.parse 还原', () => {
    const persisted = { state: { settings: { theme: 'dark', desktop: {} } }, version: 8 };
    const jsonRoute = resolveRoute(STORAGE_KEYS.settings, roots);
    // 写：zustand 序列化 → 落盘
    const fileText = serializeRouteValue(JSON.stringify(persisted), jsonRoute);
    // 读：文件原文即返回值（消费方自己 JSON.parse）
    expect(JSON.parse(fileText)).toEqual(persisted);
  });

  it('旧 blob → 剥层 → 落盘，与新装路径得到同一份结构', () => {
    const persisted = { state: { settings: { theme: 'light' } }, version: 8 };
    const jsonRoute = resolveRoute(STORAGE_KEYS.settings, roots);
    const legacy = JSON.stringify(JSON.stringify(persisted));
    const migrated = serializeRouteValue(unwrapLegacyValue(legacy), jsonRoute);
    const fresh = serializeRouteValue(JSON.stringify(persisted), jsonRoute);
    expect(migrated).toBe(fresh);
  });
});

describe('resolveWriteTarget：导出写盘的安全边界', () => {
  it('相对路径解析到 ①（MEMORY.md → ~/.nanowork/MEMORY.md）', () => {
    expect(resolveWriteTarget('MEMORY.md', roots)).toBe(join(PRODUCT_DIR, 'MEMORY.md'));
  });

  it('相对路径允许子目录', () => {
    expect(resolveWriteTarget(join('export', 'a.json'), roots)).toBe(
      join(PRODUCT_DIR, 'export', 'a.json'),
    );
  });

  it('用户主目录内的绝对路径放行', () => {
    const target = join(HOME, 'Documents', 'a.txt');
    expect(resolveWriteTarget(target, roots)).toBe(target);
  });

  it('两个根之外的绝对路径拒绝', () => {
    expect(resolveWriteTarget(resolve('/etc/passwd'), roots)).toBeNull();
  });

  it('同前缀但不同目录的路径拒绝（/home/u-evil 不得命中 /home/u）', () => {
    expect(resolveWriteTarget(`${HOME}-evil/x.txt`, roots)).toBeNull();
  });

  it('相对路径穿越出去时拒绝', () => {
    expect(resolveWriteTarget('../../etc/passwd', roots)).toBeNull();
  });

  it('空路径与含 NUL 的路径拒绝', () => {
    expect(resolveWriteTarget('', roots)).toBeNull();
    expect(resolveWriteTarget('a\0b', roots)).toBeNull();
  });
});

describe('knownRouteFiles：storage:clear 的删除清单', () => {
  it('覆盖两个根下的登记落点', () => {
    const files = knownRouteFiles(roots);
    expect(files).toContain(join(PRODUCT_DIR, 'settings.json'));
    expect(files).toContain(join(USER_DATA, 'sessions.json'));
    expect(files).toContain(join(memoryDir(roots), 'index.json'));
  });

  it('只列到具体文件，不含 plugins / connectors 等纯用户资产目录', () => {
    const files = knownRouteFiles(roots);
    // 清单里允许出现 ① 下 skills/、experts/ 内的**索引文件**（它们确实是存储状态），
    // 但绝不允许涉及插件包与连接器凭据——那些属用户资产，不该被「清空数据」带走。
    for (const dir of ['plugins', 'connectors']) {
      expect(files.some((file) => file.startsWith(join(PRODUCT_DIR, dir)))).toBe(false);
    }
  });

  it('每一项都指向文件而非目录（技能包等目录内容不会被连带删除）', () => {
    for (const file of knownRouteFiles(roots)) {
      expect(/\.(json|txt|md)$/.test(file)).toBe(true);
    }
  });

  it('豁免名单里的 key 不在删除清单里（身份文件 + 用户记忆作用域）', () => {
    const files = knownRouteFiles(roots);
    // 身份文件：清掉 SOUL.md 是「重置应用」不该有的副作用
    expect(files).not.toContain(join(PRODUCT_DIR, IDENTITY_FILENAMES.soul));
    // 记忆作用域：它只是指针，数据在 ① user-memory/<scope>/（不可清空）；
    // 清掉指针不会删数据，只会让画像/偏好永远读不回来
    expect(files).not.toContain(join(USER_DATA, 'memory-scope.txt'));
  });
});

describe('M3：用户级记忆 / 身份文件 / 提示词外置的落点', () => {
  it.each([
    [IDENTITY_STORAGE_KEYS.soul, 'SOUL.md'],
    [IDENTITY_STORAGE_KEYS.identity, 'IDENTITY.md'],
    [IDENTITY_STORAGE_KEYS.user, 'USER.md'],
    [IDENTITY_STORAGE_KEYS.bootstrap, 'BOOTSTRAP.md'],
  ])('身份文件 %s 落在 ① 根目录的 %s（原样 Markdown，用户可直接编辑）', (key, filename) => {
    const route = resolveRoute(key, roots);
    expect(route.scope).toBe('user');
    expect(route.filePath).toBe(join(PRODUCT_DIR, filename));
    expect(route.format).toBe('text');
    expect(route.pretty).toBe(false);
  });

  it('用户级记忆落 ① 根目录的 MEMORY.md，而不是 memory/ 下的同名文件', () => {
    const route = resolveRoute(USER_MEMORY_KEY, roots);
    expect(route.scope).toBe('user');
    expect(route.filePath).toBe(join(PRODUCT_DIR, 'MEMORY.md'));
    expect(route.format).toBe('text');
    // 关键区分：若误用 MEMORY_KEY_PREFIX，会得到 memory/user.md——一个
    // 看起来像工作区记忆、实际谁都不认的孤儿文件。
    expect(route.filePath).not.toBe(join(memoryDir(roots), 'user.md'));
  });

  it.each([
    [`${PROMPT_KEY_PREFIX}mode.ask`, join('prompts', 'mode', 'ask.md')],
    [`${PROMPT_KEY_PREFIX}domain.code`, join('prompts', 'domain', 'code.md')],
    [
      `${PROMPT_KEY_PREFIX}style.style-professional`,
      join('prompts', 'style', 'style-professional.md'),
    ],
  ])('提示词模板 %s 落在 ① %s（两段式）', (key, rel) => {
    const route = resolveRoute(key, roots);
    expect(route.scope).toBe('user');
    expect(route.filePath).toBe(join(PRODUCT_DIR, rel));
    expect(route.format).toBe('text');
  });

  it('提示词 key 段数不对时落兜底目录，不猜路径深度', () => {
    for (const bad of [`${PROMPT_KEY_PREFIX}mode`, `${PROMPT_KEY_PREFIX}mode.a.b`, `${PROMPT_KEY_PREFIX}mode.`]) {
      const route = resolveRoute(bad, roots);
      expect(route.filePath.startsWith(miscDir(roots))).toBe(true);
    }
  });

  it('提示词 key 里的恶意片段不得让落点逃出 ① 目录', () => {
    const hostile = [
      `${PROMPT_KEY_PREFIX}..%2F..%2Fetc.passwd`,
      `${PROMPT_KEY_PREFIX}mode.../../evil`,
      `${PROMPT_KEY_PREFIX}....../....`,
      `${PROMPT_KEY_PREFIX}\\..\\..\\windows.system32`,
      `${PROMPT_KEY_PREFIX}mode.CON`,
    ];
    for (const key of hostile) {
      const route = resolveRoute(key, roots);
      // 真正的不变量是「落点仍在两个根之内」，而不是「字符串里没有点」：
      // 文件名里的 `..`（如 `a..b`）是合法字符，不构成路径穿越。
      expect(
        route.filePath.startsWith(PRODUCT_DIR + sep) ||
          route.filePath.startsWith(USER_DATA + sep),
        key,
      ).toBe(true);
    }
  });

  it('两段式提示词 key 的段名被收敛为安全文件名', () => {
    const route = resolveRoute(`${PROMPT_KEY_PREFIX}mode.con`, roots);
    // Windows 保留设备名不得直接当文件名
    expect(route.filePath).toBe(join(PRODUCT_DIR, 'prompts', 'mode', '_con.md'));
  });

  it('身份文件被排除在 storage:clear 之外（清空数据不该带走手写人设）', () => {
    const files = knownRouteFiles(roots);
    for (const filename of ['SOUL.md', 'IDENTITY.md', 'USER.md', 'BOOTSTRAP.md']) {
      expect(files).not.toContain(join(PRODUCT_DIR, filename));
    }
    // 用户级记忆不在豁免内：它和工作区记忆同类，「清空数据」清掉是既有语义
    expect(files).toContain(join(PRODUCT_DIR, 'MEMORY.md'));
  });

  it('提示词模板目录是 ① 下的 prompts/（与引擎 workspace 的 prompts/ 是两套）', () => {
    expect(promptsDir(roots)).toBe(join(PRODUCT_DIR, 'prompts'));
  });
});
