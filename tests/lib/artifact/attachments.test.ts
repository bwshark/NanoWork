import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  attachmentPreviewSrc,
  attachmentToUploadFile,
  attachmentsToUploadFiles,
  classifyKind,
  dataUrlToBase64,
  extOf,
  fileToAttachment,
  formatBytes,
  inferMime,
  revokeAttachmentPreview,
  toPersistableAttachment,
} from '@/lib/artifact/attachments';
import type { Attachment } from '@/types';

/**
 * 附件工具集单测。
 *
 * 覆盖重点：
 * - 用户明确要求的文档 / 表格 / 幻灯片 / 文本标记 / 配置日志 / 图片 / 视频格式全部正确归类；
 * - 异常输入（无扩展名、只有点号、大写、多重点号、未知扩展名）不得抛错；
 * - 持久化裁剪的边界与「无副作用」；
 * - object URL 的释放条件。
 */

/** 构造附件（默认一个最小可用的文本附件） */
function att(patch: Partial<Attachment> = {}): Attachment {
  return {
    id: 'att-1',
    name: 'note.txt',
    size: 10,
    mime: 'text/plain',
    kind: 'text',
    ...patch,
  };
}

let revokeSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  revokeSpy = vi.fn();
  // jsdom 未实现 object URL，按需打桩（模块在调用时才访问，故可后置打桩）
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:mock-preview'),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: revokeSpy,
    configurable: true,
    writable: true,
  });
});

describe('attachments: 常量', () => {
  it('单文件上限 10MB、单条消息最多 10 个附件', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_ATTACHMENT_COUNT).toBe(10);
  });

  it('ATTACHMENT_ACCEPT 覆盖用户要求的全部扩展名', () => {
    const required = [
      '.pdf',
      '.docx',
      '.doc',
      '.xlsx',
      '.xls',
      '.pptx',
      '.ppt',
      '.txt',
      '.md',
      '.csv',
      '.json',
      '.xml',
      '.html',
      '.yaml',
      '.yml',
      '.toml',
      '.log',
      '.png',
      '.jpg',
      '.jpeg',
      '.gif',
      '.webp',
      '.bmp',
      '.svg',
      '.mp4',
      '.mov',
      '.webm',
      '.avi',
    ];
    for (const ext of required) {
      expect(ATTACHMENT_ACCEPT).toContain(ext);
    }
  });

  it('ATTACHMENT_ACCEPT 为以点号开头、逗号分隔的扩展名列表', () => {
    const parts = ATTACHMENT_ACCEPT.split(',');
    expect(parts.length).toBeGreaterThan(50);
    parts.forEach((p) => expect(p.startsWith('.')).toBe(true));
  });
});

describe('attachments: extOf 扩展名提取', () => {
  it('常规文件名返回小写扩展名', () => {
    expect(extOf('report.pdf')).toBe('pdf');
    expect(extOf('a.b.c.docx')).toBe('docx');
  });

  it('大写扩展名归一化为小写', () => {
    expect(extOf('REPORT.PDF')).toBe('pdf');
    expect(extOf('Photo.JPEG')).toBe('jpeg');
  });

  it('无扩展名 / 只有点号 / 以点结尾均返回空串或不抛错', () => {
    expect(extOf('Makefile')).toBe('');
    expect(extOf('')).toBe('');
    expect(extOf('file.')).toBe('');
    // 只有点号开头的隐藏文件：整体被当作扩展名，但不得抛错
    expect(() => extOf('.gitignore')).not.toThrow();
  });

  it('多重点号压缩文件取最后一段', () => {
    expect(extOf('archive.tar.gz')).toBe('gz');
  });
});

describe('attachments: inferMime 文档 / 表格 / 幻灯片', () => {
  it.each([
    ['a.pdf', 'application/pdf'],
    ['a.doc', 'application/msword'],
    [
      'a.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
    ['a.xls', 'application/vnd.ms-excel'],
    [
      'a.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    ['a.ppt', 'application/vnd.ms-powerpoint'],
    [
      'a.pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
  ])('%s → %s', (name, mime) => {
    expect(inferMime(name)).toBe(mime);
  });

  it('大写扩展名同样能推断', () => {
    expect(inferMime('REPORT.PDF')).toBe('application/pdf');
    expect(inferMime('DATA.XLSX')).toBe(inferMime('data.xlsx'));
  });
});

describe('attachments: inferMime 文本 / 标记 / 配置 / 日志', () => {
  it.each([
    ['a.txt', 'text/plain'],
    ['a.md', 'text/markdown'],
    ['a.csv', 'text/csv'],
    ['a.json', 'application/json'],
    ['a.xml', 'application/xml'],
    ['a.html', 'text/html'],
    ['a.yaml', 'application/yaml'],
    ['a.yml', 'application/yaml'],
    ['a.toml', 'application/toml'],
    ['a.log', 'text/plain'],
  ])('%s → %s', (name, mime) => {
    expect(inferMime(name)).toBe(mime);
  });
});

describe('attachments: inferMime 图片 / 视频', () => {
  it.each([
    ['a.png', 'image/png'],
    ['a.jpg', 'image/jpeg'],
    ['a.jpeg', 'image/jpeg'],
    ['a.gif', 'image/gif'],
    ['a.webp', 'image/webp'],
    ['a.bmp', 'image/bmp'],
    ['a.svg', 'image/svg+xml'],
    ['a.mp4', 'video/mp4'],
    ['a.mov', 'video/quicktime'],
    ['a.webm', 'video/webm'],
    ['a.avi', 'video/x-msvideo'],
  ])('%s → %s', (name, mime) => {
    expect(inferMime(name)).toBe(mime);
  });
});

describe('attachments: inferMime 边界与兜底', () => {
  it('未知扩展名回退 application/octet-stream 且不抛错', () => {
    expect(inferMime('data.qqq')).toBe('application/octet-stream');
    expect(inferMime('archive.tar.gz')).toBe('application/octet-stream');
  });

  it('无扩展名 / 只有点号 / 空文件名一律兜底，不抛错', () => {
    expect(inferMime('Makefile')).toBe('application/octet-stream');
    expect(inferMime('file.')).toBe('application/octet-stream');
    expect(inferMime('')).toBe('application/octet-stream');
    expect(() => inferMime('.gitignore')).not.toThrow();
    expect(inferMime('.gitignore')).toBe('application/octet-stream');
  });
});

describe('attachments: classifyKind 大类判定', () => {
  it('仅凭扩展名判定', () => {
    expect(classifyKind('a.pdf')).toBe('document');
    expect(classifyKind('a.docx')).toBe('document');
    expect(classifyKind('a.xlsx')).toBe('document');
    expect(classifyKind('a.txt')).toBe('text');
    expect(classifyKind('a.md')).toBe('text');
    expect(classifyKind('a.json')).toBe('text');
    expect(classifyKind('a.yaml')).toBe('text');
    expect(classifyKind('a.log')).toBe('text');
    expect(classifyKind('a.png')).toBe('image');
    expect(classifyKind('a.svg')).toBe('image');
    expect(classifyKind('a.mp4')).toBe('video');
    expect(classifyKind('a.mov')).toBe('video');
    expect(classifyKind('a.webm')).toBe('video');
    expect(classifyKind('a.avi')).toBe('video');
    expect(classifyKind('a.mp3')).toBe('audio');
  });

  it('浏览器 MIME 优先（即便扩展名未知）', () => {
    expect(classifyKind('unknown.xyz', 'image/png')).toBe('image');
    expect(classifyKind('unknown.xyz', 'video/mp4')).toBe('video');
    expect(classifyKind('unknown.xyz', 'audio/mpeg')).toBe('audio');
    expect(classifyKind('unknown.xyz', 'text/x-ini')).toBe('text');
  });

  it('泛化 MIME（octet-stream）不误导，回退按扩展名判定', () => {
    expect(classifyKind('a.pdf', 'application/octet-stream')).toBe('document');
    expect(classifyKind('a.png', 'application/octet-stream')).toBe('image');
    expect(classifyKind('a.mp4', 'application/octet-stream')).toBe('video');
  });

  it('空 MIME / 未知扩展名 → other，不抛错', () => {
    expect(classifyKind('a.qqq', '')).toBe('other');
    expect(classifyKind('a.qqq')).toBe('other');
    expect(classifyKind('Makefile', 'application/zip')).toBe('other');
    expect(() => classifyKind('')).not.toThrow();
  });
});

describe('attachments: formatBytes 体积文案', () => {
  it('0 与非有限值统一为 0 B', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });

  it('B / KB / MB 单位与精度', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 100)).toBe('100 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 1.5)).toBe('1.5 MB');
  });

  it('超过 10MB 的值仍以 MB 呈现', () => {
    expect(formatBytes(MAX_ATTACHMENT_BYTES)).toBe('10.0 MB');
    expect(formatBytes(12 * 1024 * 1024)).toBe('12.0 MB');
  });

  it('GB 及以上不抛错且单位收敛到 GB', () => {
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
    expect(() => formatBytes(1024 ** 5)).not.toThrow();
    expect(formatBytes(1024 ** 5)).toMatch(/GB$/);
  });
});

describe('attachments: dataUrlToBase64', () => {
  it('常规 data URL 取 base64 载荷', () => {
    expect(dataUrlToBase64('data:image/png;base64,AAA=')).toBe('AAA=');
    expect(dataUrlToBase64('data:application/pdf;base64,JVBERi0x')).toBe('JVBERi0x');
  });

  it('带 charset 等参数的 data URL 也能正确截取', () => {
    expect(dataUrlToBase64('data:text/plain;charset=utf-8;base64,SGVsbG8=')).toBe(
      'SGVsbG8=',
    );
  });

  it('非 base64 的 data URL 取逗号后内容', () => {
    expect(dataUrlToBase64('data:text/plain,hello')).toBe('hello');
  });

  it('无逗号视为已是纯 base64（历史数据兼容）', () => {
    expect(dataUrlToBase64('SGVsbG8=')).toBe('SGVsbG8=');
  });

  it('空值 / 空载荷返回空串，不抛错', () => {
    expect(dataUrlToBase64(undefined)).toBe('');
    expect(dataUrlToBase64('')).toBe('');
    expect(dataUrlToBase64('data:image/png;base64,')).toBe('');
  });
});

describe('attachments: attachmentToUploadFile', () => {
  it('有内容时返回 UploadFile（base64 载荷）', () => {
    const file = attachmentToUploadFile(
      att({ name: '报告.pdf', mime: 'application/pdf', dataUrl: 'data:application/pdf;base64,JVBERi0x' }),
    );
    expect(file).not.toBeNull();
    expect(file).toEqual({
      name: '报告.pdf',
      content: 'JVBERi0x',
      mimeType: 'application/pdf',
    });
  });

  it('内容缺失（大文件未落库）返回 null', () => {
    expect(attachmentToUploadFile(att({ name: 'big.pdf' }))).toBeNull();
    expect(attachmentToUploadFile(att({ name: 'big.pdf', dataUrl: '' }))).toBeNull();
    expect(
      attachmentToUploadFile(att({ name: 'big.pdf', dataUrl: 'data:application/pdf;base64,' })),
    ).toBeNull();
  });

  it('MIME 缺失时按扩展名回退', () => {
    const file = attachmentToUploadFile(
      att({ name: 'sheet.xlsx', mime: '', dataUrl: 'data:x,AAA=' }),
    );
    expect(file?.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('未知扩展名且无 MIME 时回退 octet-stream', () => {
    const file = attachmentToUploadFile(att({ name: 'a.qqq', mime: '', dataUrl: 'data:x,AAA=' }));
    expect(file?.mimeType).toBe('application/octet-stream');
  });
});

describe('attachments: attachmentsToUploadFiles', () => {
  it('空输入返回空数组', () => {
    expect(attachmentsToUploadFiles(undefined)).toEqual([]);
    expect(attachmentsToUploadFiles(null)).toEqual([]);
    expect(attachmentsToUploadFiles([])).toEqual([]);
  });

  it('混合类型：过滤掉无内容的条目，保留有内容的', () => {
    const files = attachmentsToUploadFiles([
      att({ id: '1', name: 'a.pdf', dataUrl: 'data:x,AAA=' }),
      att({ id: '2', name: 'big.pdf' }),
      att({ id: '3', name: 'b.png', dataUrl: 'data:x,BBB=' }),
    ]);
    expect(files).toHaveLength(2);
    expect(files.map((f) => f.name)).toEqual(['a.pdf', 'b.png']);
  });

  it('缺 mimeType 时逐个按扩展名回退', () => {
    const files = attachmentsToUploadFiles([
      att({ name: 'a.csv', mime: '', dataUrl: 'data:x,AAA=' }),
      att({ name: 'b.mp4', mime: '', dataUrl: 'data:x,BBB=' }),
    ]);
    expect(files.map((f) => f.mimeType)).toEqual(['text/csv', 'video/mp4']);
  });
});

describe('attachments: toPersistableAttachment 落库裁剪', () => {
  it('小图片保留 dataUrl，但一律丢弃 object URL 预览', () => {
    const persisted = toPersistableAttachment(
      att({
        kind: 'image',
        name: 'shot.png',
        mime: 'image/png',
        size: 100 * 1024,
        previewUrl: 'blob:abc',
        dataUrl: 'data:image/png;base64,AAA=',
      }),
    );
    expect(persisted.dataUrl).toBe('data:image/png;base64,AAA=');
    expect(persisted.previewUrl).toBeUndefined();
    expect(Object.keys(persisted)).not.toContain('previewUrl');
  });

  it('超过 512KB 的图片裁掉 dataUrl', () => {
    const base = att({
      kind: 'image',
      size: 512 * 1024,
      previewUrl: 'blob:abc',
      dataUrl: 'data:image/png;base64,AAA=',
    });
    expect(toPersistableAttachment(base).dataUrl).toBe('data:image/png;base64,AAA=');
    expect(
      toPersistableAttachment({ ...base, size: 512 * 1024 + 1 }).dataUrl,
    ).toBeUndefined();
  });

  it('非图片即便很小也裁掉 dataUrl（只留元信息）', () => {
    const persisted = toPersistableAttachment(
      att({ kind: 'document', name: 'a.pdf', mime: 'application/pdf', size: 10, dataUrl: 'data:x,AAA=' }),
    );
    expect(persisted.dataUrl).toBeUndefined();
    expect(persisted.name).toBe('a.pdf');
    expect(persisted.kind).toBe('document');
  });

  it('无副作用：不就地修改传入的附件对象', () => {
    const original = att({
      kind: 'image',
      size: 1024,
      previewUrl: 'blob:abc',
      dataUrl: 'data:image/png;base64,AAA=',
    });
    const snapshot: Attachment = JSON.parse(JSON.stringify(original));
    const persisted = toPersistableAttachment(original);

    expect(original).toEqual(snapshot);
    expect(original.previewUrl).toBe('blob:abc');
    expect(original.dataUrl).toBe('data:image/png;base64,AAA=');
    // 返回的是新对象，不是同一引用
    expect(persisted).not.toBe(original);
  });
});

describe('attachments: object URL 生命周期', () => {
  it('revokeAttachmentPreview 释放 blob: 开头的预览地址', () => {
    revokeAttachmentPreview(att({ previewUrl: 'blob:abc' }));
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledWith('blob:abc');
  });

  it('非 blob 地址（http / 空）不释放，避免误伤', () => {
    revokeAttachmentPreview(att({ previewUrl: 'https://cdn.test/a.png' }));
    revokeAttachmentPreview(att({}));
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it('attachmentPreviewSrc 优先 object URL，其次 dataUrl；非图片无预览', () => {
    expect(
      attachmentPreviewSrc(att({ kind: 'image', previewUrl: 'blob:a', dataUrl: 'data:image/png;base64,A' })),
    ).toBe('blob:a');
    expect(
      attachmentPreviewSrc(att({ kind: 'image', dataUrl: 'data:image/png;base64,A' })),
    ).toBe('data:image/png;base64,A');
    expect(attachmentPreviewSrc(att({ kind: 'document', dataUrl: 'data:x,A' }))).toBeUndefined();
  });
});

describe('attachments: fileToAttachment 浏览器 File 转换', () => {
  it('按扩展名推断 MIME 与大类，并读出 dataUrl', async () => {
    const file = new File(['hello'], 'note.txt', { type: '' });
    const a = await fileToAttachment(file);
    expect(a.name).toBe('note.txt');
    expect(a.size).toBe(5);
    // 浏览器未给出 type 时按扩展名兜底
    expect(a.mime).toBe('text/plain');
    expect(a.kind).toBe('text');
    expect(a.dataUrl).toContain('base64,');
    expect(a.id).toBeTruthy();
    // 非图片不发 object URL
    expect(a.previewUrl).toBeUndefined();
  });

  it('图片额外生成 object URL 预览', async () => {
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    const a = await fileToAttachment(file);
    expect(a.kind).toBe('image');
    expect(a.mime).toBe('image/png');
    expect(a.previewUrl).toBe('blob:mock-preview');
  });

  it('超过 10MB 上限抛中文错误（由调用方 toast 提示）', async () => {
    const big = new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], 'huge.zip');
    await expect(fileToAttachment(big)).rejects.toThrow(/超出单文件 10\.0 MB 上限/);
    await expect(fileToAttachment(big)).rejects.toThrow(/huge\.zip/);
  });

  it('恰好等于上限不抛错', async () => {
    const edge = new File([new Uint8Array(MAX_ATTACHMENT_BYTES)], 'edge.zip');
    // 只校验不超限（读取 10MB 内容开销大，改为断言不抛「超出」错误）
    await expect(fileToAttachment(edge)).resolves.toMatchObject({ name: 'edge.zip' });
  });
});
