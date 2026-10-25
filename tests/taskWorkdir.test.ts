/**
 * 任务卡片上的工作目录摘要（FR-5.8）。
 *
 * 判据的要点只有两个，但都很容易写错：
 * 1. **绑到默认目录 == 未绑定** —— 任务本来就在那里跑，写出来只会把那一行撑长，
 *    判据必须用 `isSameWorkspacePath`（路径字面量可能差尾部分隔符 / 大小写 / 正反斜杠）；
 * 2. 没有默认路径可比对时（默认路径尚未就绪）**不能**把「绑到默认目录」误判成「绑了别的」
 *    —— 那就显示一个用户没做过的设置。
 */
import { describe, expect, it } from 'vitest';
import { describeTaskWorkdir } from '@/lib/task/taskWorkdir';

describe('describeTaskWorkdir：任务卡片上的工作目录摘要', () => {
  it('未绑定（undefined / 空串 / 纯空白）都不出这一行', () => {
    expect(describeTaskWorkdir(undefined, 'C:/def', {})).toBeNull();
    expect(describeTaskWorkdir('', 'C:/def', {})).toBeNull();
    expect(describeTaskWorkdir('   ', 'C:/def', {})).toBeNull();
  });

  it('绑到默认工作空间 == 不绑定（尾部分隔符 / 大小写不同也算同一个目录）', () => {
    expect(describeTaskWorkdir('C:\\proj\\def', 'C:/proj/def', {})).toBeNull();
    expect(describeTaskWorkdir('c:/proj/def/', 'C:/proj/def', {})).toBeNull();
  });

  it('绑了别的目录 → 显示别名优先、否则末级目录名', () => {
    expect(describeTaskWorkdir('D:/proj/alpha', 'C:/proj/def', {})).toBe('工作目录：alpha');
    expect(describeTaskWorkdir('D:/proj/alpha', 'C:/proj/def', { 'D:/proj/alpha': '牧场项目' })).toBe(
      '工作目录：牧场项目',
    );
  });

  it('默认路径尚未就绪时不误判（把它当成「绑了目录」显示出来，而不是当默认值吞掉）', () => {
    // 默认路径没就绪时 `isSameWorkspacePath` 一律 false；此时宁可显示出来，
    // 也不能断言「这就是默认目录」——那是替用户编一个他没做过的设置。
    expect(describeTaskWorkdir('C:/proj/def', undefined, {})).toBe('工作目录：def');
  });

  it('绑到默认目录时别名不生效（它是默认工作空间，那个名字由语义决定）', () => {
    expect(describeTaskWorkdir('C:/proj/def', 'C:/proj/def', { 'C:/proj/def': '别名' })).toBeNull();
  });
});
