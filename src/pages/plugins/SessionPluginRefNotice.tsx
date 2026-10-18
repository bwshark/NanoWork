import { Alert, Box, Typography } from "@mui/material";

import type { MissingSessionPluginRef } from "@/lib/sessionPluginRefs";

/**
 * 「会话引用的插件版本本机缺失」的提示条（FR-3.9 ①）。
 *
 * ## 为什么不弹 Dialog / 不做 toast
 *
 * 缺失不是一个要用户当场决策的事件——它可能长期成立（那版就是没在这儿装），
 * 也可能下一秒就消失（装上就好）。做成**页面内的常驻说明**：
 * 状态好了自己消失，不需要事务性交互。
 *
 * ## 为什么只「说」不「修」
 *
 * 这里给不出安全的自动动作：装哪个版本、要不要改会话，都是用户的事。
 * 自动回滚或自动安装都属于「替用户猜」，代价远大于收益。
 */
export function SessionPluginRefNotice({
  rows,
}: {
  rows: readonly MissingSessionPluginRef[];
}) {
  if (rows.length === 0) return null;
  return (
    <Alert
      severity="warning"
      variant="outlined"
      data-testid="session-plugin-ref-notice"
      sx={{ mb: 1 }}
    >
      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
        {rows.length} 条会话引用了本机没有的插件版本
      </Typography>
      <Typography variant="caption" component="div" sx={{ opacity: 0.85, mt: 0.25 }}>
        这些会话当初是在别的版本（或别的设备）下建的，本机缺这一版，
        它们真正用到的能力可能与创建时不同。装上对应版本后本条提示会自动消失。
      </Typography>
      <Box
        component="ul"
        sx={{ mt: 0.75, mb: 0, pl: 2.5, "& li": { listStyle: "disc" } }}
      >
        {rows.map((row) => (
          <li key={`${row.sessionId}:${row.plugin}`}>
            <Typography variant="caption" component="span">
              <Box component="span" sx={{ fontFamily: "monospace" }}>
                {row.plugin}@{row.version}
              </Box>
              {" · "}
              {row.sessionTitle}
            </Typography>
          </li>
        ))}
      </Box>
    </Alert>
  );
}
