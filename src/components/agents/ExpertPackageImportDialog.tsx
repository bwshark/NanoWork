import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Typography,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { toast } from "@/components/Toast";
import { planExpertImport } from "@/lib/expertPackage";
import { readExpertPackageFile } from "@/lib/expertPackageIo";
import { useAgentsStore } from "@/stores/agentsStore";
import { useModelsStore } from "@/stores/modelsStore";
import { useSkillsStore } from "@/stores/skillsStore";
import type { ExpertImportPlan } from "@/types/expertPackage";

type Phase = "reading" | "preview" | "error";

export interface ExpertPackageImportDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 导入专家包（FR-3.3）：选文件 → 预览对账结果 → 确认落库。
 *
 * 三件事刻意放在**一个**对话框里，而不是「先导入再看结果」：
 * 1. **缺技能要说清**——包里引用的技能本机没有时，导入照常成功但那几个技能被跳过，
 *    用户必须在点「导入」之前就知道，否则会以为是导入坏了；
 * 2. **重名要提前露出**——最终落库的名字（可能带「（导入）」后缀）在预览里就写出来，
 *    而不是导入完去列表里找不见原来那个名字；
 * 3. **缺失模型要说明**——预设名跨机器基本失效，被丢弃后这个专家会回落到会话/网关
 *    默认模型，属于「行为变了」而不是「配置坏了」。
 *
 * 本组件自己发 `platform.pickFile()`：外部只控制 `open`。这样两个专家页面的接线
 * 都只有 `<ExpertPackageImportDialog open onClose />` 一行，不会各写一套解析分支。
 */
export function ExpertPackageImportDialog({
  open,
  onClose,
}: ExpertPackageImportDialogProps) {
  const [phase, setPhase] = useState<Phase>("reading");
  const [plan, setPlan] = useState<ExpertImportPlan | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");

  // `onClose` 是父组件里的内联函数，每次渲染都会变。直接放进 effect 依赖会让
  // 「每次父组件重渲染都重新弹一次系统文件框」——用户会看到选文件窗口反复弹出。
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setPhase("reading");
    setPlan(null);
    setWarnings([]);
    setError("");
    setFileName("");

    void (async () => {
      const result = await readExpertPackageFile();
      if (!alive) return;
      if (result.canceled) {
        // 用户在系统弹窗里按了取消：对话框自己退出，不留一个读文件失败的残影
        onCloseRef.current();
        return;
      }
      if (!result.ok || !result.pkg) {
        setError(result.error ?? "无法解析专家包");
        setFileName(result.fileName ?? "");
        setPhase("error");
        return;
      }
      // 用 getState 取一次快照而不是订阅：对账是**导入这一刻**的判断，
      // 订阅会让 store 每次变动都重算（模型目录拉取一次就会触发），
      // 而 plan 一旦算出来就不该随后台数据悄悄改口径。
      const agents = useAgentsStore.getState().agents;
      const skills = useSkillsStore.getState().skills;
      const models = useModelsStore.getState().models;
      setWarnings(result.warnings);
      setFileName(result.fileName ?? "");
      setPlan(
        planExpertImport(result.pkg, {
          existingNames: agents.map((a) => a.name),
          skillIds: skills.map((s) => s.id),
          // 空集 = 目录还没拉过 → planExpertImport 按「预设有效」放行（不误删绑定）
          presetIds: models.map((m) => m.id),
        }),
      );
      setPhase("preview");
    })();

    return () => {
      alive = false;
    };
  }, [open]);

  const confirm = () => {
    if (!plan) return;
    const created = useAgentsStore.getState().importAgent(plan.draft);
    const skipped = plan.missingSkills.length;
    toast.success(
      skipped
        ? `已导入专家「${created.name}」，${skipped} 个技能本机没有，已跳过`
        : `已导入专家「${created.name}」`,
    );
    onClose();
  };

  const pkg = plan?.pkg;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>导入专家包</DialogTitle>
      <DialogContent>
        {phase === "reading" && (
          <Typography sx={{ fontSize: 13, color: "text.secondary", py: 2 }}>
            正在读取所选文件…
          </Typography>
        )}

        {phase === "error" && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {error}
            {fileName ? (
              <Typography sx={{ fontSize: 12, mt: 0.5 }}>
                文件：{fileName}
              </Typography>
            ) : null}
          </Alert>
        )}

        {phase === "preview" && plan && pkg && (
          <Box>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
              <Typography sx={{ fontSize: 15, fontWeight: 600 }}>
                {plan.name}
              </Typography>
              <Chip size="small" variant="outlined" label={`v${pkg.version}`} />
              {plan.renamed && (
                <Chip size="small" color="warning" label="重名，已加后缀" />
              )}
            </Box>
            {fileName && (
              <Typography sx={{ fontSize: 12, color: "text.secondary", mt: 0.5 }}>
                来自 {fileName}
              </Typography>
            )}
            {pkg.description && (
              <Typography sx={{ fontSize: 13, color: "text.secondary", mt: 1 }}>
                {pkg.description}
              </Typography>
            )}

            <Divider sx={{ my: 1.5 }} />

            <Typography sx={{ fontSize: 12, color: "text.secondary", mb: 0.5 }}>
              初始提示词
            </Typography>
            <Box
              sx={{
                fontSize: 12.5,
                lineHeight: 1.6,
                bgcolor: "action.hover",
                borderRadius: 1,
                p: 1.25,
                maxHeight: 120,
                overflow: "auto",
                whiteSpace: "pre-wrap",
              }}
            >
              {pkg.agent.systemPrompt.trim() || "（空）"}
            </Box>

            <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap", mt: 1.5 }}>
              <Chip
                size="small"
                label={`技能 ${plan.draft.skillIds.length}`}
                variant="outlined"
              />
              {plan.draft.toolAllow !== undefined && (
                <Chip
                  size="small"
                  label={`白名单 ${plan.draft.toolAllow.length}`}
                  variant="outlined"
                />
              )}
              {plan.draft.toolDeny !== undefined && (
                <Chip
                  size="small"
                  label={`黑名单 ${plan.draft.toolDeny.length}`}
                  variant="outlined"
                />
              )}
              {plan.draft.model && (
                <Chip size="small" label={`模型 ${plan.draft.model}`} variant="outlined" />
              )}
              {plan.draft.avatar && (
                <Chip size="small" label="含头像" variant="outlined" />
              )}
            </Box>

            {plan.missingSkills.length > 0 && (
              <Alert severity="warning" sx={{ mt: 1.5 }}>
                以下技能本机没有，导入后不会被绑定：
                <Box sx={{ mt: 0.5, display: "flex", gap: 0.5, flexWrap: "wrap" }}>
                  {plan.missingSkills.map((s) => (
                    <Chip key={s.id} size="small" label={s.name || s.id} />
                  ))}
                </Box>
              </Alert>
            )}

            {plan.missingModel && (
              <Alert severity="info" sx={{ mt: 1.5 }}>
                模型预设「{plan.missingModel}」本机不存在，已忽略；该专家将跟随会话 /
                网关默认模型。
              </Alert>
            )}

            {warnings.length > 0 && (
              <Alert severity="info" sx={{ mt: 1.5 }}>
                {warnings.join("；")}
              </Alert>
            )}
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>取消</Button>
        <Button
          variant="contained"
          onClick={confirm}
          disabled={phase !== "preview" || !plan}
        >
          导入
        </Button>
      </DialogActions>
    </Dialog>
  );
}
