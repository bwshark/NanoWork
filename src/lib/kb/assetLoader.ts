import type { KbGateway } from './kbClient';

/**
 * 图片加载器：把资产 id 换成浏览器能直接用的地址。
 *
 * ## 为什么是 `blob:` 而不是直接用接口地址
 *
 * `<img src>` **不会**带 `Authorization` 头，而知识库的接口一律要 Bearer 票。
 * 直接把 `/api/kbs/{kb}/assets/{id}` 塞进 `src`，结果一定是 401。
 *
 * 另一条路是「签名 URL」（服务端签一个短期有效的免鉴权地址）——那是对象存储时代
 * 的标准做法，但它给权限开了一个旁路：签名链接一旦泄露，在有效期内谁都能看。
 * 本项目的核心不变量是「可见性只有一处判定」（`kb/visibility.py::allows()`），
 * 所以这里宁可多一步 blob 转换，也不引入旁路。
 *
 * ## 生命周期
 *
 * `blob:` 地址会一直占着内存，直到 `revokeObjectURL`。所以：
 * - 同一张图只取一次（`pending` 缓存）；
 * - 换文档时释放上一批（`releaseAll`）；
 * - 页面卸载时释放最后一批（`dispose`）。
 */
export interface AssetLoader {
  /** 解析成可加载地址；取不到时返回 `null`（调用方决定怎么兜底）。 */
  resolve(kbId: string, assetId: string): Promise<string | null>;
  /**
   * 登记一份**已经在本地**的字节（粘贴上传时手里就有那份 file），返回可加载地址。
   *
   * 为什么要这一条：粘贴的图上传后**立刻**就要显示，而再 fetch 一次是白等一趟。
   */
  adopt(assetId: string, blob: Blob): string;
  /**
   * 「可加载地址 → 资产 id」的映射。
   *
   * 保存时用它把 `blob:` 地址换回 `asset:<id>` —— blob 地址是一次性的，
   * 存进库里就全成了坏图。
   */
  readonly map: Map<string, string>;
  /** 释放已创建的地址（换文档时调用：上一篇的图不再需要了）。 */
  releaseAll(): void;
  /** 彻底释放（页面卸载时调用）。 */
  dispose(): void;
}

export function createAssetLoader(client: KbGateway): AssetLoader {
  const pending = new Map<string, Promise<string | null>>();
  const created: string[] = [];
  const map = new Map<string, string>();

  const revokeAll = () => {
    for (const url of created) {
      if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
    }
    created.length = 0;
    map.clear();
  };

  return {
    resolve(kbId: string, assetId: string): Promise<string | null> {
      const key = `${kbId}:${assetId}`;
      const cached = pending.get(key);
      if (cached) return cached;

      const request = client.fetchAsset(kbId, assetId).then((result) => {
        if (!result.ok || !result.data) return null;
        // 环境不支持 blob 地址（老浏览器 / 测试环境）→ 返回 null，调用方用占位图
        if (typeof URL.createObjectURL !== 'function') return null;
        const url = URL.createObjectURL(result.data);
        created.push(url);
        map.set(url, assetId);
        return url;
      });
      pending.set(key, request);
      return request;
    },

    adopt(assetId: string, blob: Blob): string {
      if (typeof URL.createObjectURL !== 'function') return '';
      const url = URL.createObjectURL(blob);
      created.push(url);
      map.set(url, assetId);
      return url;
    },

    get map(): Map<string, string> {
      return map;
    },

    releaseAll(): void {
      revokeAll();
      pending.clear();
    },

    dispose(): void {
      revokeAll();
      pending.clear();
    },
  };
}
