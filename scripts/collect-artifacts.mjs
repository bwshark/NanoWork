/**
 * 把 `build-installer.mjs` 写的产物清单展开成"要上传的文件列表"（一行一个路径）。
 *
 * ## 为什么要多这一层
 *
 * 上传步骤需要的不只是安装包本身，还要 electron-updater 的元数据
 * （`latest.yml` / `latest-mac.yml` / `latest-linux.yml` 与 `*.blockmap`）——
 * 漏了它们，客户端能下载更新但判断不出"有新版本"。
 *
 * 而安装包目录又**不保证**是 workflow 里写的那个（Windows 上受限目录会把产物挪到盘根），
 * 所以目录必须从清单里反推，不能在 YAML 里写死。
 *
 * 用法：
 *   node scripts/collect-artifacts.mjs <artifacts.json>   # 打印一行一个文件路径
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const reportPath = process.argv[2];
if (!reportPath) {
  console.error('用法：node scripts/collect-artifacts.mjs <artifacts.json>');
  process.exit(1);
}
if (!existsSync(reportPath)) {
  console.error(`找不到产物清单：${reportPath}（构建脚本没有产出它会在这里报错）`);
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const artifacts = Array.isArray(report.artifacts) ? report.artifacts : [];
if (artifacts.length === 0) {
  console.error('产物清单为空');
  process.exit(1);
}

const outDir = dirname(artifacts[0].path);
// electron-updater 的元数据与差分块：扩展名固定，但文件名里带架构（latest-mac.yml 共用），
// 因此按"同目录里长得像元数据"来收，而不是拼名字。
const metadata = readdirSync(outDir)
  .filter((name) => /^latest.*\.yml$/i.test(name) || /\.blockmap$/i.test(name))
  .map((name) => join(outDir, name));

for (const file of [...artifacts.map((item) => item.path), ...metadata]) {
  console.log(file);
}
