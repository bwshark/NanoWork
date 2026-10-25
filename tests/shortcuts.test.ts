/**
 * 快捷键注册表与键位匹配。
 *
 * 这层是纯函数，但**一旦错了会错得很难查**：用户把「切换左侧栏」绑成某个组合键后
 * 按下去没反应，或者更糟——按 Ctrl+Shift+B 时「切换产物面板」和「切换左侧栏」同时响应。
 * 所以这里重点覆盖三类：
 *
 * 1. **修饰键全等**：Ctrl+Shift+B 不得命中 Ctrl+B；
 * 2. **裸键与 Shift 组合的分野**：Enter 不得命中 Shift+Enter（否则永远发不出去）；
 * 3. **捕获 → 匹配的往返一致**：改键时捕获出的串，必须能被匹配函数原样认回来——
 *    这是「改完键就不生效」最可能的成因（`Plus` 与 `+`、`Esc` 与 `Escape` 之类的写法漂移）。
 */

import { describe, expect, it } from 'vitest';
import { isEditableTarget } from '@/lib/editor/editableTarget';
import {
  DEFAULT_BINDINGS,
  SHORTCUTS,
  bindingFromEvent,
  conflictsWithTyping,
  eventKeyToken,
  formatBinding,
  formatShortcutHint,
  matchBinding,
  parseBinding,
  resolveBinding,
  type KeyLike,
  type ShortcutId,
} from '@/lib/editor/shortcuts';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Settings } from '@/types';

/** 构造一个「事件形状」的假对象：只填匹配用得上的字段 */
function key(init: Partial<KeyLike> & { key: string; code?: string }): KeyLike {
  return {
    code: init.code ?? '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...init,
  };
}

/** 常用按键的简写构造 */
const EV = {
  b: (mods: Partial<KeyLike> = {}) => key({ key: 'b', code: 'KeyB', ...mods }),
  enter: (mods: Partial<KeyLike> = {}) => key({ key: 'Enter', code: 'Enter', ...mods }),
  esc: (mods: Partial<KeyLike> = {}) => key({ key: 'Escape', code: 'Escape', ...mods }),
  comma: (mods: Partial<KeyLike> = {}) => key({ key: ',', code: 'Comma', ...mods }),
  f11: (mods: Partial<KeyLike> = {}) => key({ key: 'F11', code: 'F11', ...mods }),
  digit1Shift: () => key({ key: '!', code: 'Digit1', shiftKey: true }),
};

describe('键位匹配：修饰键全等', () => {
  it('Ctrl+B 命中，Ctrl+Shift+B 不命中', () => {
    expect(matchBinding('Ctrl+B', EV.b({ ctrlKey: true }))).toBe(true);
    expect(
      matchBinding('Ctrl+B', EV.b({ ctrlKey: true, shiftKey: true })),
    ).toBe(false);
  });

  it('Ctrl+Shift+B 只命中带 Shift 的那条', () => {
    const both = EV.b({ ctrlKey: true, shiftKey: true });
    expect(matchBinding('Ctrl+Shift+B', both)).toBe(true);
    expect(matchBinding('Ctrl+B', both)).toBe(false);
  });

  it('没有 Ctrl 时不会误命中 Ctrl 组合，反之亦然', () => {
    expect(matchBinding('Ctrl+B', EV.b())).toBe(false);
    expect(matchBinding('Ctrl+Shift+B', EV.b({ shiftKey: true }))).toBe(false);
  });
});

describe('键位匹配：裸键与修饰键组合的分野', () => {
  it('Enter 不命中 Shift+Enter（否则换行与发送会互相吞掉）', () => {
    expect(matchBinding('Enter', EV.enter())).toBe(true);
    expect(matchBinding('Enter', EV.enter({ shiftKey: true }))).toBe(false);
    expect(matchBinding('Shift+Enter', EV.enter({ shiftKey: true }))).toBe(true);
  });

  it('Esc 命中 Escape 事件', () => {
    expect(matchBinding('Esc', EV.esc())).toBe(true);
  });

  it('符号键按字面绑定', () => {
    expect(matchBinding('Ctrl+,', EV.comma({ ctrlKey: true }))).toBe(true);
    expect(matchBinding('Ctrl+,', EV.comma())).toBe(false);
  });

  it('F11 不要求修饰键', () => {
    expect(matchBinding('F11', EV.f11())).toBe(true);
  });

  it('Shift+1 与 Shift+! 同源（按 code 取主键，不受符号影响）', () => {
    // e.key 是 '!（Shift 的产物），e.code 仍是 Digit1；主键 token 取 '1'
    expect(eventKeyToken(EV.digit1Shift())).toBe('1');
    expect(matchBinding('Shift+1', EV.digit1Shift())).toBe(true);
  });

  it('空键位（已禁用）永不命中', () => {
    expect(matchBinding('', EV.enter())).toBe(false);
  });
});

describe('捕获 → 匹配 往返一致', () => {
  const cases: Array<[string, KeyLike]> = [
    ['Ctrl+B', EV.b({ ctrlKey: true })],
    ['Ctrl+Shift+B', EV.b({ ctrlKey: true, shiftKey: true })],
    ['Enter', EV.enter()],
    ['Shift+Enter', EV.enter({ shiftKey: true })],
    ['Esc', EV.esc()],
    ['F11', EV.f11()],
    ['Ctrl+,', EV.comma({ ctrlKey: true })],
    ['Alt+Meta+B', EV.b({ altKey: true, metaKey: true })],
  ];

  it.each(cases)('捕获出的 %s 能被匹配函数认回', (expected, event) => {
    expect(bindingFromEvent(event)).toBe(expected);
    expect(matchBinding(expected, event)).toBe(true);
  });

  it('只按住修饰键时不落定', () => {
    expect(bindingFromEvent(key({ key: 'Control', code: 'ControlLeft', ctrlKey: true }))).toBeNull();
    expect(bindingFromEvent(key({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))).toBeNull();
  });
});

describe('展示文案', () => {
  it('Plus / Minus 还原成带引号的符号（`+` 与连接符同形，必须区分）', () => {
    expect(formatBinding('Ctrl+Plus')).toBe('Ctrl+"+"');
    expect(formatBinding('Ctrl+Minus')).toBe('Ctrl+"-"');
  });

  it('其余 token 原样展示', () => {
    expect(formatBinding('Ctrl+Shift+B')).toBe('Ctrl+Shift+B');
    expect(formatBinding('Ctrl+[')).toBe('Ctrl+[');
    expect(formatBinding('Enter')).toBe('Enter');
    expect(formatBinding('')).toBe('');
  });

  it('菜单提示在 token 之间补空格（先 split 再逐个格式化）', () => {
    expect(formatShortcutHint('Ctrl+,')).toBe('Ctrl + ,');
    expect(formatShortcutHint('Ctrl+Shift+B')).toBe('Ctrl + Shift + B');
    // ⚠️ 这一条是「先 split 再 format」的判据：整串 format 再按 `+` 切会把 `"+"` 切成三段
    expect(formatShortcutHint('Ctrl+Plus')).toBe('Ctrl + "+"');
    expect(formatShortcutHint('')).toBe('');
  });
});

describe('输入控件避让', () => {
  it('裸可打印键与空格需要避让，带 Ctrl/Alt/Meta 的不避让', () => {
    expect(conflictsWithTyping('B')).toBe(true);
    expect(conflictsWithTyping('Space')).toBe(true);
    expect(conflictsWithTyping('Ctrl+B')).toBe(false);
    expect(conflictsWithTyping('Alt+B')).toBe(false);
    expect(conflictsWithTyping('Meta+B')).toBe(false);
  });

  it('功能键与 Enter/Esc 不避让（它们不会被「打出来」）', () => {
    expect(conflictsWithTyping('F11')).toBe(false);
    expect(conflictsWithTyping('Enter')).toBe(false);
    expect(conflictsWithTyping('Esc')).toBe(false);
    // Shift 不是避让理由：Shift+Enter 本就归输入框自己处理
    expect(conflictsWithTyping('Shift+Enter')).toBe(false);
  });

  it('识别可编辑目标', () => {
    const input = document.createElement('input');
    const div = document.createElement('div');
    const editable = document.createElement('div');
    // jsdom 未实现 `isContentEditable`（真实浏览器里由 DOM 计算），手动补上
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(div)).toBe(false);
    expect(isEditableTarget(editable)).toBe(true);
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('注册表完整性', () => {
  it('id 不重复', () => {
    const ids = SHORTCUTS.map((def) => def.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每条命令都有默认键位，且 DEFAULT_BINDINGS 与注册表同构', () => {
    for (const def of SHORTCUTS) {
      expect(DEFAULT_BINDINGS[def.id], `${def.id} 缺默认键位`).toBe(
        def.defaultBinding,
      );
    }
    expect(Object.keys(DEFAULT_BINDINGS).sort()).toEqual(
      SHORTCUTS.map((d) => d.id).sort(),
    );
  });

  it('可改键的默认键位互不冲突', () => {
    // 冲突的默认值意味着「按下后只有先匹配到的那条生效」，另一条永远沉默
    const custom = SHORTCUTS.filter((def) => def.group === 'custom');
    const bindings = custom.map((def) => def.defaultBinding);
    expect(new Set(bindings).size).toBe(bindings.length);
  });

  it('默认键位都能被解析（末位是主键，其余都是已知修饰键）', () => {
    const known = ['Ctrl', 'Alt', 'Shift', 'Meta'];
    for (const def of SHORTCUTS) {
      if (!def.defaultBinding) continue;
      const parsed = parseBinding(def.defaultBinding);
      expect(parsed, `${def.id} 的键位无法解析`).toBeTruthy();
      for (const mod of parsed!.mods) {
        expect(known, `${def.id} 出现未知修饰键 ${mod}`).toContain(mod);
      }
    }
  });
});

describe('覆盖表读取', () => {
  it('表里没有 = 用默认；空串 = 已禁用；有值 = 用覆盖值', () => {
    expect(resolveBinding('chat.new', {})).toBe('Ctrl+N');
    expect(resolveBinding('chat.new', { 'chat.new': '' })).toBe('');
    expect(resolveBinding('chat.new', { 'chat.new': 'Ctrl+Alt+N' })).toBe(
      'Ctrl+Alt+N',
    );
    expect(resolveBinding('chat.new', undefined)).toBe(DEFAULT_BINDINGS['chat.new']);
  });

  it('快捷键 id 联合类型与注册表一致（编译期保证，此处仅取一个代表）', () => {
    const id: ShortcutId = 'settings.open';
    expect(resolveBinding(id, {})).toBe('Ctrl+,');
  });
});

describe('覆盖表写入（settingsStore）', () => {
  /** 每条用例从干净的表开始：store 是模块级单例，不隔离会互相污染 */
  function clearShortcuts(): void {
    const s = useSettingsStore.getState();
    useSettingsStore.setState({ settings: { ...s.settings, shortcuts: {} } });
  }

  it('写入自定义键位后读回，且不影响其他命令', () => {
    clearShortcuts();
    useSettingsStore.getState().setShortcut('chat.new', 'Ctrl+Alt+N');
    const overrides = useSettingsStore.getState().settings.shortcuts;
    expect(overrides?.['chat.new']).toBe('Ctrl+Alt+N');
    expect(resolveBinding('chat.new', overrides)).toBe('Ctrl+Alt+N');
    expect(resolveBinding('sidebar.toggle', overrides)).toBe('Ctrl+B');
  });

  it('恢复默认 = 删除表项，而不是把默认值写回表里', () => {
    clearShortcuts();
    const store = useSettingsStore.getState();
    store.setShortcut('chat.new', 'Ctrl+Alt+N');
    useSettingsStore.getState().setShortcut('chat.new', null);
    expect(useSettingsStore.getState().settings.shortcuts).toEqual({});
  });

  it('写入与默认相同的键位同样按恢复默认处理', () => {
    // 否则表里会留下一条「与默认完全相同的记录」，日后调整默认键位时它会挡住新默认值
    clearShortcuts();
    useSettingsStore.getState().setShortcut('chat.new', 'Ctrl+N');
    expect(useSettingsStore.getState().settings.shortcuts).toEqual({});
  });

  it('空串保留为表项（显式禁用），不能被当成「没设置过」', () => {
    clearShortcuts();
    useSettingsStore.getState().setShortcut('chat.new', '');
    const overrides = useSettingsStore.getState().settings.shortcuts;
    expect(overrides?.['chat.new']).toBe('');
    expect(resolveBinding('chat.new', overrides)).toBe('');
    expect(matchBinding('', EV.b())).toBe(false);
  });

  it('resetShortcuts 清空整张表', () => {
    clearShortcuts();
    const store = useSettingsStore.getState();
    store.setShortcut('chat.new', 'Ctrl+Alt+N');
    store.setShortcut('chat.search', 'Ctrl+Alt+F');
    useSettingsStore.getState().resetShortcuts();
    expect(useSettingsStore.getState().settings.shortcuts).toEqual({});
  });

  it('v10 迁移：老数据没有 shortcuts 字段时补齐为空表', () => {
    const options = useSettingsStore.persist.getOptions();
    const migrate = options.migrate as
      | ((state: unknown, version: number) => unknown)
      | undefined;
    expect(migrate).toBeTypeOf('function');

    // 老持久化数据：只有 v9 时代就存在的字段
    const migrated = migrate!(
      {
        settings: {
          gatewayEndpoint: 'http://127.0.0.1:8900/v1',
          theme: 'light',
        },
        status: 'offline',
      },
      9,
    ) as { settings: Settings };

    expect(migrated.settings.shortcuts).toEqual({});
    // 已有字段不能被迁移冲掉
    expect(migrated.settings.theme).toBe('light');
  });
});
