/**
 * `installerPlan.mjs` 的类型声明。
 *
 * 打包脚本是可直接被 node 执行的 ESM，用 `.mjs` 才能不经过编译；而测试是 TS，
 * 需要类型才能过 `tsc -p tsconfig.test.json`。所以类型只写在这一处，
 * **不要**改成 .ts（那样 `node scripts/build-installer.mjs` 就跑不起来了）。
 */

export type PlatformId = 'win' | 'mac' | 'linux';
export type ArchId = 'x64' | 'arm64';

export interface ArtifactSpec {
  kind: string;
  ext: RegExp;
}

export interface PlatformMeta {
  label: string;
  host: string;
  pbsHints: string[];
  artifacts: ArtifactSpec[];
  runtimeProbe: RegExp;
}

export declare const PLATFORM_META: Record<PlatformId, PlatformMeta>;
export declare const ARCH_ALIASES: Record<ArchId, string[]>;

export declare function normalizeArch(value: unknown): ArchId | null;
export declare function detectPlatform(asset: unknown): PlatformId | null;
export declare function parseRuntimeAsset(asset: unknown): {
  platform: PlatformId | null;
  arch: ArchId | null;
};
