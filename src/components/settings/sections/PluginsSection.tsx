import { Box } from '@mui/material';
import { PluginsPage } from '@/pages/plugins/PluginsPage';

/**
 * 插件分区：插件包的安装 / 卸载 / 启停与引擎激活状态。
 *
 * 与「专家 / 技能 / 连接器」的差别在于入口位置：那三项是**装能力**，用完就进会话，
 * 留在侧边栏；插件是**打包分发单位**，装完基本不再动，因此收进设置。
 */
export function PluginsSection() {
  return (
    <Box>
      <PluginsPage embedded />
    </Box>
  );
}
