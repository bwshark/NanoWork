/**
 * 图片引用的双向替换。
 *
 * 这一层是**编辑器与知识库之间的那座桥**：正文里存的是 `asset:<id>`，
 * 渲染时换成浏览器能加载的地址，保存时换回去。
 *
 * 往返必须无损 —— 换不回去就意味着「打开一次文档，图就变成坏图了」。
 */

import { describe, expect, it } from 'vitest';
import {
  FAILED_IMAGE_PLACEHOLDER,
  collectAssetIds,
  replaceAssetRefs,
  restoreAssetRefs,
} from '@/lib/kb/assetRef';

describe('collectAssetIds', () => {
  it('按出现顺序收集且去重', () => {
    const markdown = 'a ![一](asset:aaa) b ![二](asset:bbb) c ![三](asset:aaa)';
    expect(collectAssetIds(markdown)).toEqual(['aaa', 'bbb']);
  });

  it('没有图片时是空数组', () => {
    expect(collectAssetIds('普通正文')).toEqual([]);
  });
});

describe('replaceAssetRefs', () => {
  it('换成可加载地址，并给出「地址 → 资产 id」的反向映射', () => {
    const result = replaceAssetRefs('前 ![架构图](asset:aaa) 后', () => 'blob:http://x/1');

    expect(result.text).toBe('前 ![架构图](blob:http://x/1) 后');
    expect(result.map.get('blob:http://x/1')).toBe('aaa');
  });

  it('取不到时用占位图（**不删掉这张图**）', () => {
    const result = replaceAssetRefs('前 ![架构图](asset:aaa) 后', () => null);

    expect(result.text).toContain(FAILED_IMAGE_PLACEHOLDER);
    expect(result.text).toContain('架构图');
    expect(result.map.size).toBe(0);
  });
});

describe('restoreAssetRefs', () => {
  it('保存前能把地址换回 asset:<id>（往返不失真）', () => {
    const original = '前 ![架构图](asset:aaa) 后 ![表](asset:bbb) 尾';
    const resolved = replaceAssetRefs(original, (id) => `blob:http://x/${id}`);

    expect(restoreAssetRefs(resolved.text, resolved.map)).toBe(original);
  });

  it('地址是长的那种也要换对（按长度倒序，避免前缀吃掉长的）', () => {
    const original = '![x](asset:aaa)';
    const resolved = replaceAssetRefs(original, () => 'blob:http://x/1');
    // 人为塞一个「短地址是长地址前缀」的情况
    resolved.map.set('blob:http://x/1', 'aaa');
    resolved.map.set('blob:http://x/12', 'bbb');

    const restored = restoreAssetRefs('![x](blob:http://x/12)', resolved.map);
    expect(restored).toBe('![x](asset:bbb)');
  });
});
