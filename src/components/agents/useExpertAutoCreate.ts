import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "@/components/Toast";
import { ROUTES } from "@/lib/core/constants";
import { useSessionsStore } from "@/stores/sessionsStore";
import { useSkillsStore } from "@/stores/skillsStore";
import { DEEP_LINK_PROMPT_KEY } from "@/types/deepLink";

/**
 * 「AI 自动创建专家 / 专家团」的动作接线。
 *
 * ## 它到底做了什么（三件事，缺一不可）
 *
 * 1. **新建一条空白会话**（`inheritCapabilities: false`）—— 自动创建不该继承用户
 *    当前正在用的专家人设，否则模型会顶着别人的身份去设计专家。
 * 2. **把「专家创建」技能挂到这条会话上**。技能的声明式内容（产出什么格式的蓝图）
 *    必须由技能提供，而不是写在前端提示词里：技能是可编辑资产，前端常量不是。
 * 3. **带着开场白跳到对话页**。开场白与用户截图里的文案一致 ——
 *    「帮我创建一个 XXX 专家…我的经验是：[请补充…]」这种带占位符的句式，
 *    比一句空白的「描述你的专家」更能让人知道该填什么。
 *
 * ## 为什么不是「点一下直接建好」
 *
 * 直接的专家配置只能来自用户已知的信息；而多数人说不清自己要的专家该有什么
 * 工作流。这一步的价值是**把模糊想法问清楚**，所以必须进对话。真正的落库发生在
 * 模型产出蓝图之后（见 `lib/agent/expertBlueprint.ts` 与 `ExpertBlueprintCard`）。
 */

/** 「专家创建」技能的内置 id（与 `ai/builtinSkills.ts` 中一致） */
export const EXPERT_BUILDER_SKILL_ID = 'expert-builder';

export type AutoCreateKind = 'agent' | 'team';

/**
 * 开场白模板。
 *
 * 占位符用方括号而不是 `{{}}`：它是给**用户**改的，不是给模板引擎渲染的，
 * 中文方括号在输入框里更显眼（一眼能看出哪里需要替换）。
 */
const OPENING_PROMPT: Record<AutoCreateKind, string> = {
  agent: '帮我创建一个 XXX 专家，擅长 XXXXX。我的经验是：[请补充你的行业背景、相关经验]',
  team: '帮我创建一个 XXX 专家团，团队成员包括[请补充成员角色]，共同擅长 XXXXX。我的经验是：[请补充你的行业背景、相关经验]',
};

const SESSION_TITLE: Record<AutoCreateKind, string> = {
  agent: '创建专家',
  team: '创建专家团',
};

export function useExpertAutoCreate() {
  const navigate = useNavigate();
  const createSession = useSessionsStore((s) => s.createSession);
  const updateSession = useSessionsStore((s) => s.updateSession);
  const skills = useSkillsStore((s) => s.skills);

  const startAutoCreate = useCallback(
    (kind: AutoCreateKind) => {
      const skill = skills.find((s) => s.id === EXPERT_BUILDER_SKILL_ID);
      // 技能被用户停用时如实说，不静默降级：没有技能就没有蓝图规约，
      // 模型会自由发挥，最后卡片解析不出来 —— 那种「看起来能用」最耗人。
      if (!skill) {
        toast.error('内置技能「专家创建」不可用，无法自动创建');
        return;
      }
      if (!skill.enabled) {
        toast.error('「专家创建」技能已停用，请到技能页启用后再试');
        return;
      }

      const session = createSession(undefined, SESSION_TITLE[kind], {
        inheritCapabilities: false,
      });
      updateSession(session.id, (s) => ({
        ...s,
        skillIds: [EXPERT_BUILDER_SKILL_ID],
        updatedAt: new Date().toISOString(),
      }));
      navigate(ROUTES.chat, { state: { [DEEP_LINK_PROMPT_KEY]: OPENING_PROMPT[kind] } });
    },
    [createSession, navigate, skills, updateSession],
  );

  return { startAutoCreate };
}
