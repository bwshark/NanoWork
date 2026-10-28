/**
 * 知识库上传的前端小工具（体积文案 + 客户端预检）。
 *
 * ## 为什么要在前端就先挡一次
 *
 * 服务端会挡（`parsing.MAX_UPLOAD_BYTES`），但那是**把 11MB 的 base64 传完之后**才回 422。
 * 用户在一个本地服务上等了十几秒才看到一个「文件太大」，观感等同于卡死。
 * 体积检查是纯本地计算，没有理由不做。
 *
 * ⚠️ 前端挡不是**安全边界**：它只是体验优化，真正的上限在服务端（客户端可以被绕过）。
 */

/** 与服务端 `parsing.MAX_UPLOAD_BYTES` 保持一致；改一处必须改另一处。 */
export const KB_MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * 文件选择框的 accept 列表（同上：与服务端 `SUPPORTED_EXTENSIONS` 同源）。
 *
 * `.doc` 在列：服务端不再直接拒收，而是用 Word / LibreOffice 转成 `.docx` 后解析
 * （见 `parsing._parse_doc`）。**这台机器没装办公套件时会回 422** 并提示「另存为
 * .docx」—— 那是服务端的能力问题，不该由前端提前拦掉：能转的机器上它就该能传。
 */
export const KB_UPLOAD_ACCEPT = '.txt,.md,.csv,.doc,.docx,.pdf,.xlsx,.pptx';

/** 体积文案（B / KB / MB）。 */
export function formatBytesLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 来源格式的中文名。列表里显示「PDF / Word」比显示 `pdf / docx` 更省一次翻译。 */
export const KB_KIND_LABELS: Record<string, string> = {
  text: '纯文本',
  // `.doc` 与 `.docx` 都是 Word：用户不关心容器，界面上一律显示「Word」。
  // 真正的旧版/新版区别在服务端的 `kind` 上（`.doc` 会带一条「已转换」的 warning）。
  doc: 'Word',
  docx: 'Word',
  pdf: 'PDF',
  xlsx: 'Excel',
  pptx: 'PPT',
};

/** 未知格式原样返回：后端将来加了 `.xlsx` 时，界面显示 `xlsx` 也比显示空白强。 */
export function kindLabel(kind: string | undefined): string {
  if (!kind) return KB_KIND_LABELS.text;
  return KB_KIND_LABELS[kind] ?? kind;
}

/**
 * 上传前预检；返回错误文案，`null` = 通过。
 *
 * 后缀用**白名单**而不是黑名单：黑名单漏一个（比如 `.xls`）就等于让服务端去报错，
 * 而服务端的报错虽然清楚，但没必要让用户多走一趟网络。
 *
 * ⚠️ 白名单只管「服务端认不认这个后缀」，**不判服务端当前能不能转**：
 * `.doc` 在名单里，但没装 Office / LibreOffice 的部署会回 422 —— 那是运行时能力，
 * 前端查不到，也不该猜。
 */
export function precheckUpload(file: { name: string; size: number }): string | null {
  if (file.size <= 0) return `「${file.name}」是空文件`;
  if (file.size > KB_MAX_UPLOAD_BYTES) {
    return `「${file.name}」${formatBytesLabel(file.size)}，超过单文件 ${formatBytesLabel(KB_MAX_UPLOAD_BYTES)} 上限`;
  }
  const dot = file.name.lastIndexOf('.');
  const suffix = dot < 0 ? '' : file.name.slice(dot).toLowerCase();
  if (!KB_UPLOAD_ACCEPT.split(',').includes(suffix)) {
    return `不支持 ${suffix || '无后缀'} 文件，可上传 ${KB_UPLOAD_ACCEPT.split(',').join(' / ')}`;
  }
  return null;
}
