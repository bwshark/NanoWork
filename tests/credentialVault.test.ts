import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CredentialVault,
  CREDENTIAL_VAULT_VERSION,
  safeStorageCipher,
  type CredentialCipher,
} from '../electron/credentialVault';

/**
 * 凭据保险库测试。
 *
 * 三条必须钉住的语义：
 * 1. **密文里不得出现明文**（这是"加密"的全部意义）；
 * 2. **加密不可用时拒绝写入**（fail-closed，绝不悄悄降级成明文）；
 * 3. **只回传 key 名**（值一旦回传渲染层，加密就白做了）。
 */

/** 可预测的伪 cipher：`enc:<明文>`，便于断言"文件里没有明文" */
const fakeCipher: CredentialCipher = {
  available: () => true,
  encrypt: (plain) => Buffer.from(`enc:${plain}`, 'utf-8'),
  decrypt: (blob) => {
    const text = blob.toString('utf-8');
    if (!text.startsWith('enc:')) throw new Error('不是本 cipher 的密文');
    return text.slice(4);
  },
};

/** 模拟"本机没有系统凭据库"（Linux 无 keyring / 无头环境） */
const unavailableCipher: CredentialCipher = {
  available: () => false,
  encrypt: () => {
    throw new Error('不可用');
  },
  decrypt: () => {
    throw new Error('不可用');
  },
};

let dir = '';
let filePath = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nanowork-vault-'));
  filePath = join(dir, 'connectors', '.credentials.v3.json');
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不影响断言
  }
});

function makeVault(cipher: CredentialCipher = fakeCipher): CredentialVault {
  return new CredentialVault({ filePath, cipher });
}

describe('CredentialVault: 读写往返', () => {
  it('写入后可按 server 读回明文', async () => {
    const vault = makeVault();
    await vault.write('github', { token: 'ghp_secret' });
    expect(await vault.read('github')).toEqual({ token: 'ghp_secret' });
  });

  it('keyNames 只给名字、不给值，且有序', async () => {
    const vault = makeVault();
    await vault.write('srv', { zeta: 'z', alpha: 'a' });
    expect(await vault.keyNames()).toEqual({ srv: ['alpha', 'zeta'] });
  });

  it('落盘的是密文——文件里不得出现明文密钥', async () => {
    const vault = makeVault();
    await vault.write('srv', { token: 'super-secret-value' });

    const raw = readFileSync(filePath, 'utf-8');
    expect(raw).not.toContain('super-secret-value');
    const parsed = JSON.parse(raw) as { version: number; servers: Record<string, unknown> };
    expect(parsed.version).toBe(CREDENTIAL_VAULT_VERSION);
    expect(parsed.servers.srv).toBeTruthy();
  });

  it('整条替换：第二次写入覆盖第一次', async () => {
    const vault = makeVault();
    await vault.write('srv', { token: 'old', extra: 'x' });
    await vault.write('srv', { token: 'new' });
    expect(await vault.read('srv')).toEqual({ token: 'new' });
    expect((await vault.keyNames()).srv).toEqual(['token']);
  });

  it('写空对象等于删除该条（不留空壳）', async () => {
    const vault = makeVault();
    await vault.write('srv', { token: 'x' });
    await vault.write('srv', {});
    expect(await vault.keyNames()).toEqual({});
    expect(await vault.read('srv')).toEqual({});
  });

  it('remove 幂等', async () => {
    const vault = makeVault();
    await vault.write('srv', { token: 'x' });
    await vault.remove('srv');
    await vault.remove('srv');
    expect(await vault.keyNames()).toEqual({});
  });

  it('非字符串值被丢弃（配置来自用户输入，不可信）', async () => {
    const vault = makeVault();
    await vault.write('srv', {
      good: 'v',
      bad: 42,
      empty: '',
      nested: { a: 1 },
    } as unknown as Record<string, string>);
    expect(await vault.read('srv')).toEqual({ good: 'v' });
    expect((await vault.keyNames()).srv).toEqual(['good']);
  });

  it('缺 server 名时拒绝写入', async () => {
    const vault = makeVault();
    await expect(vault.write('', { token: 'x' })).rejects.toThrow('缺少 server 名');
  });
});

describe('CredentialVault: fail-closed', () => {
  it('加密不可用时写入抛出，且不落盘', async () => {
    const vault = makeVault(unavailableCipher);
    await expect(vault.write('srv', { token: 'x' })).rejects.toThrow('没有可用的系统凭据库');
    // 关键：不能悄悄写一份明文出来
    expect(await vault.keyNames()).toEqual({});
  });

  it('加密不可用时读取返回空（不抛，让上层退化为"未设置"）', async () => {
    const good = makeVault();
    await good.write('srv', { token: 'x' });

    const broken = makeVault(unavailableCipher);
    expect(await broken.read('srv')).toEqual({});
    // 记录仍在：读不出来不等于该删掉
    expect((await broken.keyNames()).srv).toEqual(['token']);
  });

  it('解密失败时返回空且保留记录（换机器场景）', async () => {
    const good = makeVault();
    await good.write('srv', { token: 'x' });

    const wrongCipher: CredentialCipher = {
      available: () => true,
      encrypt: (plain) => Buffer.from(plain, 'utf-8'),
      decrypt: () => {
        throw new Error('解密失败');
      },
    };
    const vault = makeVault(wrongCipher);
    expect(await vault.read('srv')).toEqual({});
    expect((await vault.keyNames()).srv).toEqual(['token']);
  });

  it('status 暴露可用性与落点（界面据此提示"未加密"）', () => {
    const vault = makeVault(unavailableCipher);
    expect(vault.status()).toEqual({ available: false, path: filePath });
  });
});

describe('CredentialVault: 容错与并发', () => {
  it('文件不存在时视为空库', async () => {
    const vault = makeVault();
    expect(await vault.keyNames()).toEqual({});
    expect(await vault.read('nope')).toEqual({});
  });

  it('文件损坏时不抛、也不删（明文密钥已不在这里，删掉只会让人找不回）', async () => {
    const vault = makeVault();
    await vault.write('srv', { token: 'x' });
    writeFileSync(filePath, '{ this is not json', 'utf-8');

    expect(await vault.keyNames()).toEqual({});
    expect(await vault.read('srv')).toEqual({});
    // 文件还在，等待人工检查
    expect(readFileSync(filePath, 'utf-8')).toBe('{ this is not json');
  });

  it('结构不合法的 server 记录被跳过，其余仍可读', async () => {
    const vault = makeVault();
    await vault.write('good', { token: 'x' });
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      servers: Record<string, unknown>;
    };
    parsed.servers.broken = { keys: 'not-an-array' };
    parsed.servers.alsoBroken = { keys: [], blob: '' };
    writeFileSync(filePath, JSON.stringify(parsed), 'utf-8');

    expect(await vault.keyNames()).toEqual({ good: ['token'] });
  });

  it('并发写不同 server 都保留（写队列串行化）', async () => {
    const vault = makeVault();
    await Promise.all([
      vault.write('a', { token: '1' }),
      vault.write('b', { token: '2' }),
      vault.write('c', { token: '3' }),
    ]);
    const names = await vault.keyNames();
    expect(Object.keys(names).sort()).toEqual(['a', 'b', 'c']);
    expect(await vault.read('b')).toEqual({ token: '2' });
  });
});

describe('safeStorageCipher: safeStorage 适配', () => {
  it('转发三个调用；isEncryptionAvailable 抛错时视为不可用', () => {
    const calls: string[] = [];
    const cipher = safeStorageCipher({
      isEncryptionAvailable: () => {
        calls.push('available');
        return true;
      },
      encryptString: (plain) => {
        calls.push('encrypt');
        return Buffer.from(plain, 'utf-8');
      },
      decryptString: (blob) => {
        calls.push('decrypt');
        return blob.toString('utf-8');
      },
    });

    expect(cipher.available()).toBe(true);
    expect(cipher.decrypt(cipher.encrypt('hi'))).toBe('hi');
    expect(calls).toEqual(['available', 'encrypt', 'decrypt']);

    const broken = safeStorageCipher({
      isEncryptionAvailable: () => {
        throw new Error('没有 keyring');
      },
      encryptString: () => Buffer.alloc(0),
      decryptString: () => '',
    });
    expect(broken.available()).toBe(false);
  });
});
