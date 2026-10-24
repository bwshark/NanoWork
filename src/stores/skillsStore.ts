import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { platform } from '@/platform';
import { zustandStorage } from '@/platform';
import { STORAGE_KEYS } from '@/lib/constants';
import { SKILLS } from '@/ai/builtinSkills';
import {
  buildOverrideMap,
  resolveSkillOverride,
  withEffectiveOverride,
} from '@/lib/skillOverrides';
import {
  applyOverrides,
  dropOverride,
  entriesFromLegacy,
  findOverride,
  pinnedSkillIds,
  upsertOverride,
} from '@/lib/skillOverrideTable';
import { metaForEdit, metaForNew } from '@/lib/syncStamp';
import { recordAppAudit } from '@/lib/appAudit';
import type { Skill, SkillOverride, SkillOverrideEntry } from '@/types';

interface SkillsState {
  /**
   * 运行时视图：磁盘扫描的**事实** + 覆盖表的**用户意图**合成结果。
   * 消费方（会话挂载 / 技能页 / 任务表单）只读它，不必知道覆盖表的存在。
   */
  skills: Skill[];
  /**
   * 技能覆盖表（用户意图的唯一来源，也是**唯一的云端同步负载**）。
   *
   * 与 `skills` 分开的原因见 `types/skill.ts` 的 `SkillOverrideEntry`：技能正文
   * 由各设备的磁盘决定、多端自然一致；跨端要传的只有「用户把它调成了哪一档、
   * 有没有置顶」。整实体同步会把 `Skill.path` 这个机器专属字段带上云（FR-10.5）。
   */
  overrides: SkillOverrideEntry[];
  /**
   * 置顶的技能 id（「我安装的」列表把置顶项排在最前）。
   *
   * **派生值**：恒等于 `overrides` 里 `pinned === true` 的 `skillId`，由
   * `pinnedSkillIds()` 算出，**不单独持久化**——落盘就是第二份真相，
   * 而两份真相没有东西保证一致（症状是「点过置顶、重启后顺序变了」）。
   *
   * 刻意**不**放进 `Skill` 对象里，也刻意**不**推给引擎：
   * - 它不是技能属性，而是**用户对这份列表的排序偏好**。挂进技能对象就要在
   *   `mergeSkills` 里为它单独写一条「内容取最新、这字段取用户选择」的还原路径
   *   （`override` 已经占了一条），多一条就多一处会漂移的地方。
   * - 引擎不关心顺序。混进 `buildOverrideMap` 会让「置顶」变成一条会写进
   *   nanobot 配置的指令，而它在引擎侧没有任何对应语义。
   */
  pinnedIds: string[];
  /** 是否已完成首次本地技能扫描 */
  loaded: boolean;
  /**
   * 最近一次「把三态覆盖推给引擎」的失败原因（null = 无失败）。
   *
   * 刻意留一个**可见**的错误位而不是 console.warn：覆盖同步失败时，
   * 界面会显示「已停用」而引擎照旧把它列给模型——这是最难自查的一类不一致，
   * 必须让用户看见。
   */
  syncError: string | null;
  /**
   * 重新扫描技能目录并合并。
   * @param workspace 当前工作区绝对路径；给了才会扫项目级技能（`<workspace>/skills`）
   */
  refresh: (workspace?: string) => Promise<void>;
  /** 在「启用 / 停用」两档之间切换（保留给只关心开与关的既有入口） */
  toggleSkill: (id: string) => void;
  /** 布尔入口 → 映射到 `on` / `off` 两档 */
  setSkillEnabled: (id: string, enabled: boolean) => void;
  /** 设置三态覆盖（FR-3.1 的完整入口），并推送给引擎 */
  setSkillOverride: (id: string, override: SkillOverride) => void;
  /** 置顶 / 取消置顶（只影响「我安装的」列表顺序，不推引擎） */
  toggleSkillPin: (id: string) => void;
  /** 安装一个技能（Web 端上传或 Electron 端从本地选择） */
  installSkill: (skill: Skill) => void;
  /** 删除本地安装的技能；内置技能不可删除 */
  removeSkill: (id: string) => void;
}

/**
 * 基于当前内置目录与持久化数据重新合并。
 *
 * 合并的**唯一职责**是「内容取最新、状态取用户选择」：
 * 技能正文随代码/磁盘更新，但用户改过的三态覆盖不能被冲掉。
 */
function mergeSkills(stored: Skill[], scanned: Skill[]): Skill[] {
  const storedMap = new Map(stored.map((s) => [s.id, s]));

  // 内置技能：保留当前代码中的版本，仅恢复用户覆盖的状态
  const builtin = SKILLS.map((s) => {
    const over = storedMap.get(s.id);
    return withEffectiveOverride(
      s,
      over && over.source === 'builtin' ? resolveSkillOverride(over) : undefined,
    );
  });

  // 扫描到的技能（用户级 / 项目级 / 本地安装）：内容取磁盘最新
  const restoredMap = new Map(stored.filter((s) => s.source !== 'builtin').map((s) => [s.id, s]));
  const scannedMerged = scanned.map((s) => {
    const st = restoredMap.get(s.id);
    return withEffectiveOverride(s, st ? resolveSkillOverride(st) : undefined);
  });

  return [...builtin, ...scannedMerged];
}

/**
 * 这个技能是否「归用户所有」——即能否从 store 里删掉。
 *
 * 内置技能随应用发布，删了下次启动就回来；项目级技能来自
 * `<workspace>/skills` 目录，`refresh()` 每进一次页面就重扫一遍，
 * 从 store 里抹掉同样会「复活」。两者都不该给删除入口：
 * 前者删了没用，后者真正的删除动作是删文件，不是改状态。
 */
function isUserOwnedSkill(skill: Skill): boolean {
  return skill.source !== 'builtin' && skill.scope !== 'project';
}

/**
 * 把三态覆盖推给引擎（`agents.defaults.skillOverrides`）。
 *
 * 推的是 `buildOverrideMap` 的产物——只含非默认档，
 * 因此「用户把某技能调回启用」表现为**从表里消失**而不是写一个 `on`。
 */
async function pushOverrides(skills: Skill[]): Promise<string | null> {
  try {
    const result = await platform.syncNanobotSkills(JSON.stringify(buildOverrideMap(skills)));
    return result.ok ? null : result.message;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export const useSkillsStore = create<SkillsState>()(
  persist(
    (set, get) => {
      /**
       * 覆盖表变更的**统一出口**：重算派生视图（`skills` / `pinnedIds`）并落 state。
       *
       * 返回新的 `skills`，供「推引擎」那条路径复用（不必再读一次 state，
       * 也避免读到中间态）。四处写动作（改档 / 置顶 / 安装 / 卸载）都经这里，
       * 是为了让「表是权威、视图是派生」这条不变量只有一处实现。
       */
      const commitOverrides = (entries: SkillOverrideEntry[]): Skill[] => {
        const skills = applyOverrides(get().skills, entries);
        set({ overrides: entries, skills, pinnedIds: pinnedSkillIds(entries) });
        return skills;
      };

      return {
        skills: mergeSkills([], []),
        overrides: [],
        pinnedIds: [],
        loaded: false,
        syncError: null,

        refresh: async (workspace) => {
          const scanned = await platform.loadUserSkills(workspace);
          const stored = get().skills;
          const merged = mergeSkills(stored, scanned);
          // 合并之后按覆盖表**重新合成**：`mergeSkills` 只从「当前视图」里捡回用户
          // 改过的档，而视图可能因为上一次扫描丢过条目（磁盘暂时读不到），
          // 表里的记录才是权威。
          const skills = applyOverrides(merged, get().overrides);
          set({ skills, loaded: true });
          // 扫描可能带回一批新技能（用户刚往目录里丢了一个），
          // 这些技能的默认档是 `on`，无需推送；但若磁盘上的技能被删了，
          // 覆盖表里可能留下僵尸条目，所以这里也顺带重推一次。
          set({ syncError: await pushOverrides(skills) });
        },

        toggleSkill: (id) => {
          const current = get().skills.find((s) => s.id === id);
          if (!current) return;
          const next = resolveSkillOverride(current) === 'off' ? 'on' : 'off';
          get().setSkillOverride(id, next);
        },

        setSkillEnabled: (id, enabled) => get().setSkillOverride(id, enabled ? 'on' : 'off'),

        setSkillOverride: (id, override) => {
          const { skills, overrides } = get();
          // 只改**已存在**的技能：凭空加条目会让覆盖表指向一个不存在的技能，
          // 同步到对端就是一条永远不生效的指令
          const target = skills.find((sk) => sk.id === id);
          if (!target) return;
          const prev = findOverride(overrides, id);
          const nextSkills = commitOverrides(
            upsertOverride(overrides, {
              skillId: id,
              override,
              // 改档不动置顶：两件事互不相干（置顶只影响列表顺序）
              pinned: prev?.pinned ?? false,
              // 已有条目 → `rev + 1`；新条目 → `rev = 1`
              ...(prev ? metaForEdit(prev) : metaForNew()),
            }),
          );
          // 先落状态再推引擎：界面必须立刻响应，同步是后台的事。
          void pushOverrides(nextSkills).then((error) => set({ syncError: error }));
          // `toggleSkill` / `setSkillEnabled` 都收敛到这一个出口 → 只在这里记一次，
          // 否则同一个开关动作会在审计里出现两三条（「谁改的」反而更难读）
          recordAppAudit({
            action: 'skill.override',
            targetId: id,
            targetLabel: target.name,
            detail: { override },
          });
        },

        toggleSkillPin: (id) => {
          const { skills, overrides } = get();
          const current = skills.find((sk) => sk.id === id);
          if (!current) return;
          const prev = findOverride(overrides, id);
          // 置顶**不动覆盖档**：表里已有条目就沿用它的现值；没有条目时取该技能
          // 当前生效档，而不是硬写 `on`——后者会把「仅手动调用」的技能顺手打开，
          // 而用户只是想把它排到前面
          commitOverrides(
            upsertOverride(overrides, {
              skillId: id,
              override: prev?.override ?? resolveSkillOverride(current),
              pinned: !(prev?.pinned ?? false),
              ...(prev ? metaForEdit(prev) : metaForNew()),
            }),
          );
          // 置顶不推引擎：见 `pinnedIds` 的说明
        },

        installSkill: (skill) => {
          set((s) => {
            const next = withEffectiveOverride(skill, 'on');
            // 重新安装 = 明确回到默认档 `on`：覆盖表里若留着「停用」记录，必须一起
            // 改掉，否则刚装上就被上次的停用压回去，用户在列表里找不到它
            // （表现成「点了安装没反应」）。置顶保留——那是排序偏好，与安装无关。
            const prev = findOverride(s.overrides, skill.id);
            const overrides = prev
              ? upsertOverride(s.overrides, {
                  ...prev,
                  override: 'on',
                  ...metaForEdit(prev),
                })
              : s.overrides;
            const skills = s.skills.some((sk) => sk.id === skill.id)
              ? s.skills.map((sk) => (sk.id === skill.id && isUserOwnedSkill(sk) ? next : sk))
              : [...s.skills, next];
            return { skills, overrides, pinnedIds: pinnedSkillIds(overrides) };
          });
          recordAppAudit({
            action: 'skill.install',
            targetId: skill.id,
            targetLabel: skill.name,
          });
        },

        /*
         * 卸载时连带清掉覆盖条目，否则表里会攒下指向已卸载技能的僵尸记录
         * （技能重新装上时会**莫名其妙自己变回停用 / 自己置顶**）。清理是有条件的：
         * 内置技能卸不掉，那种情况下不能把它的覆盖悄悄抹掉。
         */
        removeSkill: (id) => {
          // 不可删的技能（内置 / 项目级）原本就是静默无操作；审计也不能给它记账，
          // 否则留下一条「删过」但什么都没发生的记录，比不记更误导
          const target = get().skills.find((sk) => sk.id === id && isUserOwnedSkill(sk));
          if (!target) return;
          set((s) => {
            const removed = s.skills.some((sk) => sk.id === id && isUserOwnedSkill(sk));
            const overrides = removed ? dropOverride(s.overrides, id) : s.overrides;
            return {
              skills: s.skills.filter((sk) => !(sk.id === id && isUserOwnedSkill(sk))),
              overrides,
              pinnedIds: pinnedSkillIds(overrides),
            };
          });
          recordAppAudit({ action: 'skill.remove', targetId: id, targetLabel: target.name });
        },
      };
    },
    {
      name: STORAGE_KEYS.skills,
      storage: zustandStorage,
      /*
       * v2：`enabled: boolean` → `override: on|user-invocable-only|off`（FR-3.1）
       * v3：抽出 `overrides` 覆盖表（用户意图的唯一来源，也是唯一的云端同步负载，
       *     见 `types/skill.ts` 的 `SkillOverrideEntry`）；`pinnedIds` 改为它的派生值
       */
      version: 3,
      migrate: (persisted) => {
        const state = persisted as
          | { skills?: Skill[]; overrides?: SkillOverrideEntry[]; pinnedIds?: string[] }
          | undefined;
        const skills = Array.isArray(state?.skills) ? state.skills : [];
        // `withEffectiveOverride` 会按布尔的 `enabled` 推导老数据的档：
        // `enabled: false` → `off`，其余 → `on`。不猜中间档。
        const normalized = skills.map((s) => withEffectiveOverride(s));
        // 已有覆盖表（v3 形态）就原样信任；否则从旧的 `skills` + `pinnedIds` 抽。
        // 判据落在**数据形状**上而不只是版本号：降级回滚过的用户磁盘上完全可能
        // 是「version=2 但已经带 overrides」，按版本号硬抽会把表里新增的条目冲掉。
        const overrides = Array.isArray(state?.overrides)
          ? state.overrides
          : entriesFromLegacy(normalized, state?.pinnedIds ?? []);
        return { skills: normalized, overrides, loaded: false, syncError: null };
      },
      /*
       * 落盘两份、各有明确职责：
       * - `skills`：**事实缓存**（扫描结果 + 合成视图）。带着 `override`/`enabled`
       *   是为了重启后不必等扫描就能正确显示；它**不是**用户意图的权威，表才是。
       * - `overrides`：用户意图表，V1.5 的同步层直接把它当集合读。
       *
       * `pinnedIds` **不落盘**：它是覆盖表的派生值，落盘就是第二份真相。
       */
      partialize: (s) => ({ skills: s.skills, overrides: s.overrides }),
      merge: (persisted, current) => {
        const state = persisted as
          | { skills?: Skill[]; overrides?: SkillOverrideEntry[] }
          | undefined;
        // 没有任何落盘数据（首次启动 / 被清空）时保留初始状态：初始 `skills`
        // 已经含内置技能，用空数组覆盖会让技能页白屏
        if (!state) return current;
        const overrides = state.overrides ?? [];
        return {
          ...current,
          overrides,
          // 表是权威：按它重算视图与置顶。只信落盘的 `skills.override` 会让
          // 「表改了、视图没跟上」这类不一致永远修不回来
          skills: applyOverrides(state.skills ?? [], overrides),
          pinnedIds: pinnedSkillIds(overrides),
        };
      },
    },
  ),
);
