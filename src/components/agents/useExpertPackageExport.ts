import { useCallback } from "react";
import { toast } from "@/components/Toast";
import { platform } from "@/platform";
import { exportExpertPackageFile } from "@/lib/expertPackageIo";
import { useSkillsStore } from "@/stores/skillsStore";
import type { Agent } from "@/types";

/**
 * 「导出专家包」的动作接线（FR-3.3）。
 *
 * 抽成 hook 是因为 `AgentsPage` 与 `MyAgentsPage` 是两份高度重复的实现：导出逻辑
 * 若各写一遍，两处的提示文案、失败处理、技能名解析必然漂移（这两页此前的专家表单
 * 就因此字段集不一致过）。
 *
 * 提示文案区分平台：Electron 落 `~/.nanowork/`，Web 是浏览器下载 —— 同一条
 * 「已导出」在两端的下一句动作完全不同（去文件夹找 vs 去下载列表找）。
 *
 * 刻意**不做**「导出中禁用按钮」：写一个几 KB 的文本是毫秒级动作，为它多传一个
 * busy prop 给两处 footer 得不偿失；重复点击最坏就是同名文件被覆盖一次，内容相同。
 */
export function useExpertPackageExport() {
  const skills = useSkillsStore((s) => s.skills);

  const exportAgent = useCallback(
    async (agent: Agent) => {
      const skillNameOf = (id: string): string =>
        skills.find((s) => s.id === id)?.name ?? id;
      const result = await exportExpertPackageFile(agent, skillNameOf);
      if (!result.ok) {
        toast.error(`导出失败：${result.error ?? "未知错误"}`);
        return;
      }
      const place =
        platform.env === "electron"
          ? `~/.nanowork/${result.fileName}`
          : result.fileName;
      const suffix = result.warnings.length
        ? `（${result.warnings.join("；")}）`
        : "";
      toast.success(`已导出到 ${place}${suffix}`);
    },
    [skills],
  );

  return { exportAgent };
}
