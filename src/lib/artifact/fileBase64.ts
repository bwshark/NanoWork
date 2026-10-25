/**
 * 读文件为 base64（不带 `data:` 前缀）。
 *
 * 为什么不用 `readAsDataURL` 再切前缀：切前缀要处理 `data:<mime>;base64,` 的
 * 各种写法（有些环境会带 charset），出错时表现为「服务端说不是合法 base64」——
 * 也就是**上传失败但看不出是客户端把前缀带进去了**。直接读 ArrayBuffer 再编码，
 * 只有一条路径。
 *
 * 为什么不用 `File.text()`：它按 UTF-8 解码，`.docx` / `.pdf` 是二进制，
 * 解出来再转回去就废了。
 */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const buffer = reader.result;
      if (!(buffer instanceof ArrayBuffer)) {
        reject(new Error(`读取「${file.name}」失败`));
        return;
      }
      resolve(arrayBufferToBase64(buffer));
    };
    reader.onerror = () => reject(new Error(`读取「${file.name}」失败`));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * ArrayBuffer → base64。
 *
 * 分块 `String.fromCharCode`：一次性 `String.fromCharCode(...new Uint8Array(buf))`
 * 在 8MB 文件上会把参数表撑爆（不同引擎的栈上限不同，表现为 `RangeError: Maximum
 * call stack size exceeded`，而它只在文件够大时出现——小样本永远测不出来）。
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
