import { useEffect, useState, type ReactNode } from "react";
import { Box, Button, TextField, Chip } from "@mui/material";
import CloudDoneIcon from "@mui/icons-material/CloudDone";
import CloudOffIcon from "@mui/icons-material/CloudOff";
import PowerIcon from "@mui/icons-material/Power";
import { useSettingsStore } from "@/stores/settingsStore";
import { connectionManager } from "@/ai/connectionManager";
import { platform } from "@/platform";
import { nanobotBridge } from "@/platform/nanobotBridge";

/**
 * 顶部连接状态横幅：显示当前连接模式/状态，
 * 在线模式下可填写网关地址；桌面端额外提供拉起/停止 nanobot 按钮。
 */
export function ConnectionBanner() {
  const status = useSettingsStore((s) => s.status);
  const gatewayEndpoint = useSettingsStore((s) => s.settings.gatewayEndpoint);
  const setSettings = useSettingsStore((s) => s.setSettings);

  // 桌面端：nanobot 网关子进程状态（仅 electron 环境有效）
  const [gwRunning, setGwRunning] = useState(false);
  useEffect(() => {
    if (platform.env !== "electron") return;
    let active = true;
    const tick = () =>
      nanobotBridge.status().then((r) => active && setGwRunning(r));
    void tick();
    const t = setInterval(tick, 3000);
    return () => {
      active = false;
      clearInterval(t);
    };
  }, []);

  let label: string;
  let color: "success" | "error" = "error";
  let icon: ReactNode = <CloudOffIcon fontSize="small" />;

  if (status === "connected") {
    label = "已连接网关";
    color = "success";
    icon = <CloudDoneIcon fontSize="small" />;
  } else {
    label = "网关离线";
    color = "error";
    icon = <CloudOffIcon fontSize="small" />;
  }

  const onToggleGateway = async () => {
    if (gwRunning) {
      await nanobotBridge.stop();
      setGwRunning(false);
      // 主动停止后立即回探一次，避免芯片要等下一个心跳周期才变灰
      void connectionManager.probe();
    } else {
      const ok = await nanobotBridge.start();
      setGwRunning(ok);
      // 子进程拉起 ≠ API 已监听：nanobot 冷启动需约 9 秒才会 listen。
      // 主进程 start() 内部已等到端口就绪，这里再兜底确认一次，
      // 避免横幅停在「离线」要等下一个心跳周期才转绿
      if (ok) void connectionManager.waitUntilReady();
    }
  };

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        px: 2,
        py: 1,
        borderBottom: "1px solid",
        borderColor: "divider",
        bgcolor: "background.paper",
      }}
    >
      <Chip size="small" color={color} icon={icon} label={label} />
      <TextField
        size="small"
        value={gatewayEndpoint}
        onChange={(e) => setSettings({ gatewayEndpoint: e.target.value })}
        placeholder="网关地址，例如 http://127.0.0.1:8900"
        sx={{ width: 320, "& .MuiInputBase-root": { borderRadius: 1.5 } }}
      />
      {platform.env === "electron" && (
        <Button
          size="small"
          variant="outlined"
          startIcon={<PowerIcon fontSize="small" />}
          color={gwRunning ? "warning" : "success"}
          onClick={onToggleGateway}
        >
          {gwRunning ? "停止 Gateway" : "启动 Gateway"}
        </Button>
      )}
    </Box>
  );
}
