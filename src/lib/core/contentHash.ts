/**
 * 内容寻址哈希。
 *
 * 唯一的跨批契约点，被三处共用：
 * - 本批 FR-7.2：产物索引的 `contentHash`
 * - FR-7.3：`file-history/<hash>.bak` 的文件备份（内容寻址，天然去重）
 * - 未来的产物内容同步
 *
 * 三处**必须用同一个函数**，否则会出现两套寻址——这是 6b 规格 §5 定下的约束。
 *
 * ## 为什么是同步的纯 TS 实现
 *
 * 渲染层拿不到 `node:crypto`；`crypto.subtle.digest` 是**异步**的，而产物入库点
 * （`artifactsStore.recordArtifact`）是同步 reducer——异步 hash 会把整条链路拖成异步。
 * 故此处手写标准 SHA-256（FIPS 180-4），纯 TS、同步、**不 import platform**，
 * 浏览器与 Node 逐字节一致。
 *
 * ## 与 `hashContent`（djb2）的分工
 *
 * `src/lib/workspace/workspaceKey.ts` 的 `hashContent` 是 djb2：短、快，用于**段键与变更检测**
 * （6b 的 `<!-- SUMMARY:<hash> -->` 去重标记与它逐字节对齐）。
 * 它**不是**内容地址——碰撞概率不足以支撑跨端寻址。两者输出形态也不同：
 * 本函数带 `sha256:` 前缀，djb2 是裸 8 位十六进制。不要互换。
 */

/** SHA-256 常量 K（前 64 个质数立方根小数部分的前 32 位） */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** 初始哈希值 H0（前 8 个质数平方根小数部分的前 32 位） */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** 循环右移（32 位） */
function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/**
 * 内容寻址哈希：`sha256:<64 位十六进制>`，输入按 **UTF-8** 编码。
 *
 * 带前缀是有意的：裸 hex 与 djb2 的裸 hex 长得像，混用时无法从值上分辨。
 */
export function contentHash(text: string): string {
  const bytes = new TextEncoder().encode(text ?? '');
  return `sha256:${digestHex(bytes)}`;
}

/** 对字节序列做 SHA-256，返回 64 位小写十六进制（无前缀） */
function digestHex(bytes: Uint8Array): string {
  // 填充：0x80 + 若干个 0x00 + 8 字节大端位长度，使总长 ≡ 56 (mod 64)，再补到 64 的倍数
  const bitLen = bytes.length * 8;
  const paddedLen = (((bytes.length + 8) >> 6) + 1) << 6;
  const msg = new Uint8Array(paddedLen);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  // 位长度写成 64 位大端；`>>> 0` 之外的高位单独放，避免超过 2^53 时丢精度
  const high = Math.floor(bitLen / 0x100000000);
  const low = bitLen >>> 0;
  msg[paddedLen - 8] = (high >>> 24) & 0xff;
  msg[paddedLen - 7] = (high >>> 16) & 0xff;
  msg[paddedLen - 6] = (high >>> 8) & 0xff;
  msg[paddedLen - 5] = high & 0xff;
  msg[paddedLen - 4] = (low >>> 24) & 0xff;
  msg[paddedLen - 3] = (low >>> 16) & 0xff;
  msg[paddedLen - 2] = (low >>> 8) & 0xff;
  msg[paddedLen - 1] = low & 0xff;

  const h = Uint32Array.from(H0);
  const w = new Uint32Array(64);

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] =
        ((msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i++) {
      const S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  let out = '';
  for (let i = 0; i < 8; i++) out += h[i].toString(16).padStart(8, '0');
  return out;
}
