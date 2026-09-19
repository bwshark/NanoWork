import { Box } from '@mui/material';
import { ImChannelsPage } from '@/pages/im/ImChannelsPage';

/**
 * 助理设置分区：IM 频道（钉钉 / 飞书 / Lark / 微信 / 企业微信）。
 *
 * 原为侧边栏一级入口「助理」，现收进设置——它配的是「助手被谁触达」，
 * 属于一次配好就很少再动的配置，不该占着日常操作区。
 */
export function AssistantSection() {
  return (
    <Box>
      <ImChannelsPage embedded />
    </Box>
  );
}
