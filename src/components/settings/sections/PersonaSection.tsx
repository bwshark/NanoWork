import { Box } from '@mui/material';
import { PersonaPage } from '@/pages/persona/PersonaPage';

/**
 * 人格分区：身份文件（SOUL / IDENTITY / USER）+ 提示词模板外置编辑。
 *
 * 内容整体复用 `PersonaPage` 的 embedded 形态——那一页自带的层级说明、引导横幅、
 * 编辑弹窗都不需要重写，重复实现一遍只会让两边慢慢长歪。
 */
export function PersonaSection() {
  return (
    <Box>
      <PersonaPage embedded />
    </Box>
  );
}
