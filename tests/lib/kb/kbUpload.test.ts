/**
 * 上传前预检（FR-4.7 解析的客户端那一半）。
 *
 * 服务端也会挡，但那是**把 base64 传完之后**才回 422。这一组用例守的是
 * 「不该发的请求一个都别发」：空文件、超限、不支持的格式都在本地拦掉，
 * 并且各自给一句能照着做的话。
 */

import { describe, expect, it } from 'vitest';
import {
  KB_KIND_LABELS,
  KB_MAX_UPLOAD_BYTES,
  KB_UPLOAD_ACCEPT,
  formatBytesLabel,
  kindLabel,
  precheckUpload,
} from '@/lib/kb/kbUpload';

describe('formatBytesLabel', () => {
  it('按量级给单位，不用科学计数法也不用裸字节数', () => {
    expect(formatBytesLabel(0)).toBe('0 B');
    expect(formatBytesLabel(512)).toBe('512 B');
    expect(formatBytesLabel(2048)).toBe('2.0 KB');
    expect(formatBytesLabel(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('precheckUpload', () => {
  it('正常文件放行（返回 null，而不是空串或 undefined）', () => {
    expect(precheckUpload({ name: '差旅制度.docx', size: 1024 })).toBeNull();
    // 后缀大小写不敏感：Windows 上 .DOCX 很常见
    expect(precheckUpload({ name: '制度.DOCX', size: 1024 })).toBeNull();
    expect(precheckUpload({ name: 'a.pdf', size: 1024 })).toBeNull();
  });

  it('空文件直接拦（服务端会回「文件是空的」，没必要走一趟网络）', () => {
    expect(precheckUpload({ name: 'a.txt', size: 0 })).toContain('空文件');
  });

  it('超限时把实际大小与上限都说出来', () => {
    const message = precheckUpload({ name: '大文件.pdf', size: KB_MAX_UPLOAD_BYTES + 1 });
    expect(message).toContain('大文件.pdf');
    expect(message).toContain('8.0 MB');
  });

  it('不支持的后缀给出可选项（而不是只说一句「不支持」）', () => {
    const message = precheckUpload({ name: '截图.png', size: 1024 });
    expect(message).toContain('.png');
    expect(message).toContain('.docx');
  });

  it('旧版 .doc 在这里就拦（服务端提示的是「另存为」，但根本不必发出去）', () => {
    expect(precheckUpload({ name: '旧.doc', size: 1024 })).toContain('.doc');
  });

  it('无后缀文件也拦住', () => {
    expect(precheckUpload({ name: 'README', size: 1024 })).toContain('无后缀');
  });

  it('accept 列表与预检白名单是同一份（否则选择框能选、预检却拒绝）', () => {
    for (const ext of KB_UPLOAD_ACCEPT.split(',')) {
      expect(precheckUpload({ name: `x${ext}`, size: 10 })).toBeNull();
    }
  });
});

describe('来源格式的中文名', () => {
  it('三种已知格式都有中文名（缺一个界面上就是裸英文）', () => {
    expect(Object.keys(KB_KIND_LABELS).sort()).toEqual(['docx', 'pdf', 'text']);
    expect(kindLabel('pdf')).toBe('PDF');
    expect(kindLabel('docx')).toBe('Word');
  });

  it('缺省当纯文本：老接口没回 kind 时列表不该出现 undefined', () => {
    expect(kindLabel(undefined)).toBe('纯文本');
    expect(kindLabel('')).toBe('纯文本');
  });

  it('未知格式原样返回（后端将来加了 xlsx，显示 xlsx 也比空白强）', () => {
    expect(kindLabel('xlsx')).toBe('xlsx');
  });
});
