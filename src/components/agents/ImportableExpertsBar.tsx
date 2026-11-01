import { useEffect, useMemo, useState } from "react";
import { Alert, Box, Button, Chip, Stack, Typography } from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import { usePluginsStore } from "@/stores/pluginsStore";
import { useAgentsStore } from "@/stores/agentsStore";
import { useExpertGroupsStore } from "@/stores/expertGroupsStore";
import { useSkillsStore } from "@/stores/skillsStore";
import {
  applyExpertBlueprint,
  blueprintFromPluginExpert,
} from "@/lib/agent/expertBlueprint";
import { toast } from "@/components/Toast";
import { platform } from "@/platform";
import type { PluginExpertPackage } from "@/types/plugin";

/**
 * 「随包专家」提示条：插件带来但还没导入的专家，直接在专家页给出入口。
 *
 * ## 为什么需要它
 *
 * 随包专家此前只在**插件页**能导入。但用户想找专家时是去专家页的——他既不知道
 * 某个插件里有专家，也不会为了找专家去翻插件列表。`curated-experts.json` 在
 * WorkBuddy 里解决的就是这件事：把"推荐给你的专家"摆在专家中心，而不是让人
 * 去翻包。
 *
 * ## 已导入的怎么消失
 *
 * 判据是**同名**（`Agent.name === displayName`）。不做 id 级别的登记：插件里的
 * 专家没有本地 id（落地时才生成），而用户在专家页可能改过名字——改名后它会重新
 * 出现在这里，那是可接受的行为（比"导入过就永久不再提示"更安全：至少不会漏掉
 * 真正的重装场景）。
 */
export function ImportableExpertsBar() {
  const installed = usePluginsStore((s) => s.installed);
  const loaded = usePluginsStore((s) => s.loaded);
  const ensureLoaded = usePluginsStore((s) => s.ensureLoaded);
  const agents = useAgentsStore((s) => s.agents);
  const importAgent = useAgentsStore((s) => s.importAgent);
  const createGroup = useExpertGroupsStore((s) => s.createGroup);
  const skills = useSkillsStore((s) => s.skills);
  const [busy, setBusy] = useState(false);

  const isElectron = platform.env === "electron";
  useEffect(() => {
    if (!isElectron) return;
    void ensureLoaded();
  }, [ensureLoaded, isElectron]);

  /** 插件带来的全部专家（含来源插件名，导入提示要用） */
  const packaged = useMemo(() => {
    const rows: Array<{ pluginName: string; pkg: PluginExpertPackage }> = [];
    for (const view of installed) {
      for (const pkg of view.plugin.expertPackages) {
        rows.push({ pluginName: view.plugin.manifest.name, pkg });
      }
    }
    return rows;
  }, [installed]);

  /** 还没导入的（按名字判重） */
  const pending = useMemo(() => {
    const names = new Set(agents.map((a) => a.name.trim()));
    return packaged.filter((row) => !names.has(row.pkg.displayName.trim()));
  }, [agents, packaged]);

  if (!isElectron || !loaded || pending.length === 0) return null;

  const doImport = (rows: Array<{ pluginName: string; pkg: PluginExpertPackage }>) => {
    setBusy(true);
    try {
      let created = 0;
      const warnings: string[] = [];
      for (const { pkg } of rows) {
        const result = applyExpertBlueprint(
          blueprintFromPluginExpert(pkg),
          { importAgent, createGroup },
          { knownSkillIds: skills.map((s) => s.id) },
        );
        created += 1;
        warnings.push(...result.warnings);
      }
      if (warnings.length > 0) {
        toast.warning(`已导入 ${created} 个，${warnings[0]}`);
      } else {
        toast.success(`已导入 ${created} 个专家到「我的专家」`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Alert
      severity="info"
      icon={<AutoAwesomeIcon sx={{ fontSize: 18 }} />}
      sx={{ mb: 2, alignItems: "center", "& .MuiAlert-message": { flex: 1 } }}
      action={
        <Button
          size="small"
          variant="outlined"
          disabled={busy}
          onClick={() => doImport(pending)}
          sx={{ textTransform: "none", whiteSpace: "nowrap" }}
        >
          全部导入
        </Button>
      }
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        <Typography sx={{ fontSize: 13 }}>
          插件带来 {pending.length} 位专家，可直接加入「我的专家」：
        </Typography>
        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
          {pending.slice(0, 4).map(({ pluginName, pkg }) => (
            <Chip
              key={`${pluginName}/${pkg.name}`}
              size="small"
              variant="outlined"
              label={`${pkg.displayName}${pkg.expertType === "team" ? "（团）" : ""}`}
              onClick={() => doImport([{ pluginName, pkg }])}
              sx={{ height: 22, fontSize: 11.5, cursor: "pointer" }}
            />
          ))}
          {pending.length > 4 && (
            <Chip size="small" label={`+${pending.length - 4}`} sx={{ height: 22, fontSize: 11.5 }} />
          )}
        </Stack>
      </Box>
    </Alert>
  );
}
