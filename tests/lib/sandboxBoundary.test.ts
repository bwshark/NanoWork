/**
 * FR-8.5 沙箱边界声明：**这张表不许变成一片绿**。
 *
 * 纯数据模块的用例价值不在「数组能读」，而在于钉住三条一旦被改坏就会静默误导用户的
 * 性质：
 *
 * 1. 只要状态不是 `on`，缺口文案必须非空——「部分生效」却不写缺什么，读者会当成全有；
 * 2. 「操作系统级隔离」必须持续以 `off` 存在——这是本仓最容易在文档里被写成「已有沙箱」
 *    的一条，删掉它等于把风险声明撤了；
 * 3. id 唯一且稳定（界面 `data-testid`、文档、用例都靠它引用）。
 */

import { describe, it, expect } from 'vitest';
import {
  SANDBOX_BOUNDARY_SUMMARY,
  SANDBOX_LAYERS,
  SANDBOX_RISK_NOTE,
  SANDBOX_STATUS_LABELS,
  type SandboxLayerStatus,
} from '@/lib/sandboxBoundary';

describe('沙箱边界表的结构不变量', () => {
  it('id 唯一、字段齐全', () => {
    const ids = SANDBOX_LAYERS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const layer of SANDBOX_LAYERS) {
      expect(layer.id).not.toBe('');
      expect(layer.layer).not.toBe('');
      expect(layer.enforced.length).toBeGreaterThan(20);
      expect(['electron', 'engine', 'both']).toContain(layer.owner);
      expect(Object.keys(SANDBOX_STATUS_LABELS)).toContain(layer.status);
    }
  });

  it('非 on 的层必须写清缺口；on 的层不得有缺口文案', () => {
    for (const layer of SANDBOX_LAYERS) {
      if (layer.status === 'on') {
        expect(layer.gap, `${layer.id} 状态为 on 却写了缺口`).toBe('');
      } else {
        expect(layer.gap.length, `${layer.id} 缺 status=${layer.status} 的缺口说明`).toBeGreaterThan(10);
      }
    }
  });

  it('必须至少承认两处缺口（全绿 = 文案失真）', () => {
    const withGap = SANDBOX_LAYERS.filter((l) => l.status !== 'on');
    expect(withGap.length).toBeGreaterThanOrEqual(2);
  });
});

describe('三条不得被悄悄抹掉的边界', () => {
  it('「操作系统级隔离」存在、不得声称已生效，且必须写明 Windows 无后端', () => {
    const os = SANDBOX_LAYERS.find((l) => l.id === 'os-isolation');
    expect(os, 'os-isolation 行被删了：风险声明不能少').toBeTruthy();
    // 引擎里确实有 bwrap（Linux 命名空间隔离），所以是 partial 而不是 off；
    // 但它默认关闭、Windows 无后端 —— 这两点必须写在缺口里，否则读者会以为「本机有隔离」
    expect(os!.status).toBe<SandboxLayerStatus>('partial');
    expect(os!.gap).toContain('默认关闭');
    expect(os!.gap).toContain('Windows');
    // 归属版本要写明，否则读者无法判断「等多久」
    expect(os!.gap).toContain('V3');
  });

  it('命令执行绕过路径隔离这条缺口必须写着（filesystem 层只能是 partial）', () => {
    const fs = SANDBOX_LAYERS.find((l) => l.id === 'filesystem');
    expect(fs).toBeTruthy();
    expect(fs!.status).toBe<SandboxLayerStatus>('partial');
    expect(fs!.gap).toContain('exec');
  });

  it('没有域名出口白名单这条缺口必须写着（network 层只能是 partial）', () => {
    const net = SANDBOX_LAYERS.find((l) => l.id === 'network');
    expect(net).toBeTruthy();
    expect(net!.status).toBe<SandboxLayerStatus>('partial');
    expect(net!.gap).toContain('白名单');
  });
});

describe('文案是纯文本（界面不解析 markdown）', () => {
  it('所有展示字符串都不含 markdown 标记', () => {
    const all = [
      SANDBOX_BOUNDARY_SUMMARY,
      SANDBOX_RISK_NOTE,
      ...SANDBOX_LAYERS.flatMap((l) => [l.layer, l.enforced, l.gap]),
    ];
    for (const text of all) {
      expect(text, text.slice(0, 20)).not.toContain('**');
      expect(text, text.slice(0, 20)).not.toContain('`');
    }
  });
});

describe('摘要与风险结论', () => {
  it('摘要先否掉「操作系统级隔离」这个误读', () => {
    expect(SANDBOX_BOUNDARY_SUMMARY).toContain('不是操作系统级隔离');
    expect(SANDBOX_BOUNDARY_SUMMARY).toContain('没有容器');
  });

  it('风险结论把决策责任交回用户', () => {
    expect(SANDBOX_RISK_NOTE).toContain('完全访问');
    expect(SANDBOX_RISK_NOTE).toContain('没有文件系统隔离');
  });
});
