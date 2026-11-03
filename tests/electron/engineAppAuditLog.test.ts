/**
 * FR-8.9 第四条来源：引擎侧两份应用操作审计的**路径解析与内容合并**。
 *
 * 这段逻辑看起来只是「拼两个文件」，但里面有三个会静默出错的分支，
 * 每一个的症状都是「审计页少了几条」，而不是报错：
 * 1. env 空串（关闭那一份）被当成「没设」→ 关掉了却还在读旧账；
 * 2. 某一份不存在时整次读取失败 → 网关那份一缺，serve 那份也读不出来；
 * 3. 前一份末尾没有换行就拼接 → 与下一份首行粘成坏 JSON，解析层整行丢弃。
 */

import { describe, expect, it } from 'vitest';
import {
  mergeEngineAppAuditContent,
  resolveEngineAppAuditTargets,
} from '../../electron/engineAppAuditLog';

const DIR = '/data/audit';

describe('resolveEngineAppAuditTargets（两份文件的落点）', () => {
  it('两个 env 都没设时用默认文件名', () => {
    expect(resolveEngineAppAuditTargets({}, DIR)).toEqual([
      '/data/audit/app-operations.ndjson',
      '/data/audit/app-operations.gateway.ndjson',
    ]);
  });

  it('显式路径优先于默认目录', () => {
    expect(
      resolveEngineAppAuditTargets({ app: '/tmp/a.ndjson', gateway: '/tmp/b.ndjson' }, DIR),
    ).toEqual(['/tmp/a.ndjson', '/tmp/b.ndjson']);
  });

  it('⛔ 空串 = 关闭那一份（与引擎侧 raw.strip() 判据一致）', () => {
    // 关掉网关那份：只剩 serve；反过来也一样
    expect(resolveEngineAppAuditTargets({ gateway: '' }, DIR)).toEqual([
      '/data/audit/app-operations.ndjson',
    ]);
    expect(resolveEngineAppAuditTargets({ app: '   ' }, DIR)).toEqual([
      '/data/audit/app-operations.gateway.ndjson',
    ]);
  });

  it('两份都关掉时返回空数组（调用方据此回「无审计」而不是一个不存在的路径）', () => {
    expect(resolveEngineAppAuditTargets({ app: '', gateway: '' }, DIR)).toEqual([]);
  });

  it('Windows 风格目录也拼得对（不产生混用分隔符的路径）', () => {
    expect(resolveEngineAppAuditTargets({}, 'C:\\Users\\x\\audit')).toEqual([
      'C:\\Users\\x\\audit\\app-operations.ndjson',
      'C:\\Users\\x\\audit\\app-operations.gateway.ndjson',
    ]);
    // 已经带尾分隔符时不要拼出双斜杠
    expect(resolveEngineAppAuditTargets({}, 'C:\\audit\\')).toEqual([
      'C:\\audit\\app-operations.ndjson',
      'C:\\audit\\app-operations.gateway.ndjson',
    ]);
  });
});

describe('mergeEngineAppAuditContent（拼成一段 NDJSON）', () => {
  it('两份都有内容时按读取顺序拼接，行数相加', () => {
    const merged = mergeEngineAppAuditContent([
      '{"action":"config.reload"}\n',
      '{"action":"message.send"}\n',
    ]);
    expect(merged.exists).toBe(true);
    expect(merged.content.split('\n').filter(Boolean)).toEqual([
      '{"action":"config.reload"}',
      '{"action":"message.send"}',
    ]);
  });

  it('⭐ 前一份末尾缺换行时必须补上，否则与下一份首行粘成坏行', () => {
    // 进程被强杀时最后一行可能没有换行符——真实会发生的形态
    const merged = mergeEngineAppAuditContent([
      '{"action":"config.reload"}',
      '{"action":"message.send"}\n',
    ]);
    const lines = merged.content.split('\n').filter(Boolean);
    expect(lines).toEqual(['{"action":"config.reload"}', '{"action":"message.send"}']);
    // 每行都必须是**可解析**的 JSON：粘成一行时下面这条会抛
    expect(() => lines.forEach((line) => JSON.parse(line))).not.toThrow();
  });

  it('某一份缺失（读失败给了空串）时另一份照常返回', () => {
    const merged = mergeEngineAppAuditContent(['', '{"action":"message.send"}\n']);
    expect(merged.exists).toBe(true);
    expect(merged.content).toBe('{"action":"message.send"}\n');
  });

  it('两份都为空 → exists=false（界面走空态，而不是显示一张空表）', () => {
    expect(mergeEngineAppAuditContent(['', ''])).toEqual({ content: '', exists: false });
    // 只有空白也算「还没有记录」
    expect(mergeEngineAppAuditContent(['\n\n', '  \n'])).toEqual({
      content: '\n\n  \n',
      exists: false,
    });
  });
});
