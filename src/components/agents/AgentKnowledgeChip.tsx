import { Chip, Tooltip } from '@mui/material';
import { cardChipOutlinedSx } from '@/lib/ui/cardSx';
import type { AgentKnowledgeBinding } from '@/types';

/**
 * 专家卡片上的「知识库」标记（FR-2.3 第四条 / M7）。
 *
 * ## 为什么值得单独做个芯片
 *
 * 知识库绑定是**唯一一个在界面上完全没有可见痕迹**的能力：它只改变回答里会不会引用
 * 组织资料。绑错了（绑到空库、绑到别的组织的库、早就退出那个组织）时，用户看到的
 * 症状是「这个专家好像不用资料」——没有芯片就只能去翻编辑表单。
 *
 * ## 两档文案不能合并
 *
 * `kbIds: []` 是「整个组织可见范围」，非空是「只搜这几本」。两者在数据上是两个值，
 * 在界面上也必须能区分——否则用户看到「已绑定知识库」却不知道为什么同事的资料没出现。
 */
export function AgentKnowledgeChip({
  knowledge,
}: {
  knowledge?: AgentKnowledgeBinding;
}) {
  if (!knowledge || knowledge.orgId.trim() === '') return null;

  const count = knowledge.kbIds.length;
  return (
    <Tooltip
      title={
        count === 0
          ? '每轮按你的问题检索一次：该组织下你能看到的全部知识库'
          : `每轮按你的问题检索一次：指定的 ${count} 个知识库`
      }
    >
      <Chip
        size="small"
        variant="outlined"
        data-testid="agent-knowledge-chip"
        label={count === 0 ? '组织知识库' : `知识库 ${count} 个`}
        sx={cardChipOutlinedSx}
      />
    </Tooltip>
  );
}
