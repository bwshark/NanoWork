/**
 * `settings.knownWorkspaces`：已用工作空间登记表。
 *
 * 它存在的唯一理由是修一个用户报的缺陷——把某工作空间下的最后一条任务切走/删掉后，
 * 那个工作空间的分组会从侧边栏整体消失（分组完全由会话推导，没任务就没组），
 * 用户看到的是「我的工作空间丢了」，而磁盘上目录与文件都好好的。
 *
 * 因此这张表是**粘性**的：登记一次就一直在，直到用户显式「从列表中移除」。
 * 不粘就没用——按「当前有任务的目录」现算，等于回到原来的推导。
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { useSettingsStore } from '@/stores/settingsStore';
import type { Settings } from '@/types';

const BBB = 'D:\\work\\bbb';
const AAA = 'D:\\work\\aaa';

function reset() {
  useSettingsStore.setState({
    settings: { ...useSettingsStore.getState().settings, knownWorkspaces: [] },
  });
}

beforeEach(reset);

describe('rememberWorkspace / forgetWorkspace', () => {
  it('登记后加入，按登记顺序追加（不被去重逻辑重排）', () => {
    const { rememberWorkspace } = useSettingsStore.getState();
    rememberWorkspace(BBB);
    rememberWorkspace(AAA);

    expect(useSettingsStore.getState().settings.knownWorkspaces).toEqual([BBB, AAA]);
  });

  it('重复登记是幂等的（启动水合会对每个工作空间调一次）', () => {
    const { rememberWorkspace } = useSettingsStore.getState();
    rememberWorkspace(BBB);
    const before = useSettingsStore.getState().settings.knownWorkspaces;

    rememberWorkspace(BBB);
    // 幂等要停在「不写 state」这一层：写一次就触发一次持久化，
    // 而启动路径每个工作空间都会调一次，累起来是无意义的磁盘写入
    expect(useSettingsStore.getState().settings.knownWorkspaces).toBe(before);
  });

  it('首尾空白被裁掉，纯空白 / 空串直接忽略（没有「未指定」的工作空间可登记）', () => {
    const { rememberWorkspace } = useSettingsStore.getState();
    rememberWorkspace(`  ${BBB}  `);
    rememberWorkspace('   ');
    rememberWorkspace('');

    expect(useSettingsStore.getState().settings.knownWorkspaces).toEqual([BBB]);
  });

  it('移除只摘登记，不碰别名表（别名留给重新登记后用）', () => {
    const { rememberWorkspace, forgetWorkspace, setWorkspaceAlias } =
      useSettingsStore.getState();
    rememberWorkspace(BBB);
    setWorkspaceAlias(BBB, '乙方项目', 'bbb');

    forgetWorkspace(BBB);

    expect(useSettingsStore.getState().settings.knownWorkspaces).toEqual([]);
    expect(useSettingsStore.getState().settings.workspaceAliases).toEqual({
      [BBB]: '乙方项目',
    });
  });

  it('移除一个不在表里的路径是 no-op（连 state 都不换）', () => {
    const { rememberWorkspace, forgetWorkspace } = useSettingsStore.getState();
    rememberWorkspace(BBB);
    const before = useSettingsStore.getState().settings.knownWorkspaces;

    forgetWorkspace(AAA);
    expect(useSettingsStore.getState().settings.knownWorkspaces).toBe(before);
  });
});

describe('settingsStore v11 迁移：补齐 knownWorkspaces', () => {
  /** 取实现里的 migrate 而不是复刻一份逻辑——复刻的那份会随实现漂移 */
  function runMigrate(persisted: unknown) {
    const migrate = useSettingsStore.persist.getOptions().migrate as
      | ((state: unknown, version: number) => unknown)
      | undefined;
    expect(migrate).toBeTypeOf('function');
    return migrate!(persisted, 10) as { settings: Settings };
  }

  it('老用户没有这个字段 → 空表（真正的补登记发生在启动水合里）', () => {
    expect(runMigrate({ settings: {}, status: 'offline' }).settings.knownWorkspaces).toEqual(
      [],
    );
  });

  it('残留 null / 非数组 → 归一化为数组（读侧会直接 includes）', () => {
    expect(
      runMigrate({ settings: { knownWorkspaces: null }, status: 'offline' }).settings
        .knownWorkspaces,
    ).toEqual([]);
    expect(
      runMigrate({ settings: { knownWorkspaces: BBB }, status: 'offline' }).settings
        .knownWorkspaces,
    ).toEqual([]);
  });

  it('已有内容原样保留', () => {
    expect(
      runMigrate({ settings: { knownWorkspaces: [BBB] }, status: 'offline' }).settings
        .knownWorkspaces,
    ).toEqual([BBB]);
  });
});
