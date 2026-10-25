import { useEffect, useState, type ReactNode } from "react";
import { Box, Button, TextField, Chip } from "@mui/material";
import CloudDoneIcon from "@mui/icons-material/CloudDone";
import CloudOffIcon from "@mui/icons-material/CloudOff";
import PowerIcon from "@mui/icons-material/Power";
import { useSettingsStore } from "@/stores/settingsStore";
import { applyGatewayEndpointInfo, connectionManager } from "@/ai/connectionManager";
import { platform } from "@/platform";
import { nanobotBridge } from "@/platform/nanobotBridge";
import { DEFAULT_GATEWAY_PORT } from "@/lib/core/constants";
import type { NanobotGatewayInfo } from "@/platform/types";

/**
 * 把网关地址对齐到主进程**实际**监听的端口。
 *
 * 端口是运行时值而非约定值：首选端口被占用、或落在 Windows 保留端口区间时，主进程会
 * 自动顺延（见 `electron/main.ts` 的 `resolveGatewayPort`）。不同步的话界面会一直探测
 * 一个没人监听的端口 —— 表现为「网关离线」而子进程明明活着。
 *
 * 判据全部收在 `nextGatewayEndpoint`（纯函数，已单测）：本机地址才同步、端口未知不动、
 * 已对齐则返回 null。**判据本体已下沉到 `connectionManager`**（心跳里无条件跑），
 * 这里只是让横幅自己的那次轮询复用同一套判定 —— 两处各写一份必然会漂移。
 * 这里取 store 的**实时值**而非闭包值 —— 轮询间隔内用户可能刚改过地址。
 *
 * 写完立即回探一次：不动手的话要等下一个心跳（15s）才转绿，用户会以为「换了端口就连不上」。
 * @param info 主进程返回的实际监听信息
 */
function syncGatewayEndpoint(info: NanobotGatewayInfo): void {
  if (!applyGatewayEndpointInfo(info)) return;
  void connectionManager.probe();
}

/**
 * 顶部连接状态横幅：显示当前连接模式/状态，
 * 在线模式下可填写网关地址；桌面端额外提供拉起/停止 nanobot 按钮。
 */
export function ConnectionBanner() {
  const status = useSettingsStore((s) => s.status);
  const gatewayEndpoint = useSettingsStore((s) => s.settings.gatewayEndpoint);
  const setSettings = useSettingsStore((s) => s.setSettings);

  // 桌面端：网关子进程状态 + 端口协商（仅 electron 环境有效）
  const [gwRunning, setGwRunning] = useState(false);
  const [gwPort, setGwPort] = useState<number | null>(null);
  const [gwFallback, setGwFallback] = useState(false);
  useEffect(() => {
    if (platform.env !== "electron") return;
    let active = true;
    const tick = async () => {
      const info = await nanobotBridge.info();
      if (!active) return;
      setGwRunning(info.running);
      setGwPort(info.port);
      setGwFallback(info.fallback);
      syncGatewayEndpoint(info);
    };
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
        placeholder={`网关地址，例如 http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`}
        sx={{ width: 320, "& .MuiInputBase-root": { borderRadius: 1.5 } }}
      />
      {/* 首选端口不可用 → 主进程换了端口，地址已被自动对齐；显式告知，免得用户
          以为「我明明配的是 8900，怎么连上了另一个端口」 */}
      {gwFallback && gwPort !== null && (
        <Chip
          size="small"
          variant="outlined"
          color="warning"
          label={`端口已自动改为 ${gwPort}`}
        />
      )}
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
