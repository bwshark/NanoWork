import { Suspense, useEffect } from "react";
import { Box } from "@mui/material";
import { Outlet, useNavigate } from "react-router-dom";
import { SidebarNav } from "./SidebarNav";
/* import { ConnectionBanner } from "./ConnectionBanner"; */
import { RouteFallback } from "./RouteFallback";
import { TitleBar } from "@/components/TitleBar";
import { ArtifactPanel } from "@/components/artifacts/ArtifactPanel";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { useSyncConflictToast } from "@/components/SyncStatus";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { platform } from "@/platform";

/** 应用主框架：顶部全宽自绘标题栏 + 左导航 + 连接条 + 右侧主内容区 + 可展开的右侧产物面板 */
export function AppLayout() {
  const navigate = useNavigate();

  // 全局快捷键派发器：挂在布局层，整个应用生命周期只挂一次
  useGlobalShortcuts();

  // 同步冲突通知：同样是应用级的一次性副作用，挂在布局层——挂进侧栏会随侧栏折叠
  // （Electron）一起消失，那时冲突提示会静默丢掉。
  useSyncConflictToast();

  // 托盘菜单「打开设置」等主进程指令 → 执行路由跳转。
  // 窗口只是被隐藏而非卸载，渲染层仍在运行，指令可即时生效。
  useEffect(() => {
    // Web 端 platform.onAppNavigate 返回空取消函数，这里不必再自己判环境
    return platform.onAppNavigate((path) => navigate(path));
  }, [navigate]);

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
        bgcolor: "background.default",
      }}
    >
      {platform.env === "electron" && <TitleBar />}
      <Box sx={{ display: "flex", flex: 1, minHeight: 0 }}>
        <SidebarNav />
        <Box
          sx={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            height: "100%",
          }}
        >
          {/* {platform.env === "electron" && <ConnectionBanner />} */}
          <Box sx={{ flex: 1, display: "flex", minHeight: 0 }}>
            <Box sx={{ flex: 1, overflow: "auto", minWidth: 0 }}>
              {/* FR-13.5 路由懒加载的边界。**放在这里而不是路由表上**：侧栏 / 标题栏 /
                  产物面板在切页期间保持挂载，只有内容区走 fallback。放到路由表上会让
                  整棵带壳布局一起卸载重建（表现是切页时侧栏闪一下、滚动位置全丢）。 */}
              <Suspense fallback={<RouteFallback />}>
                <Outlet />
              </Suspense>
            </Box>
            {/* 右侧产物面板：由会话行的「产物面板」入口开关，收起时不占位 */}
            <ArtifactPanel />
          </Box>
        </Box>
      </Box>
      {/* 设置弹窗挂在布局层而非路由：任何时候（含任意会话页）都能被侧边栏 / 托盘唤起，
          且开关它不会导致主内容区卸载重建 */}
      <SettingsDialog />
    </Box>
  );
}
