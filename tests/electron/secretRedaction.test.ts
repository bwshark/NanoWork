/**
 * 日志出口的内容级凭据脱敏（FR-11.9）。
 *
 * 重点在**两条负向断言**：`input_tokens` / `total_tokens` 与 sha256 摘要**不能**被脱敏。
 * 前者是日志里最常见的字段，误脱敏会让「这次用了多少 token」这类排查直接失效；
 * 后者（`args_digest`）是审计日志里定位「哪次调用」的唯一线索。
 *
 * 变异验证目标：把 CREDENTIAL_KV_RE 里的 `token` 去掉字边界保护（或把分隔符放宽成
 * `[\s\S]`）→ 「input_tokens 不被脱敏」用例必须变红。
 */

import { describe, expect, it } from 'vitest';
import { redactSecrets, redactSecretsIn } from '../../electron/secretRedaction';

describe('redactSecrets：该脱的', () => {
  it('键值对保留键名与分隔符，只打值', () => {
    const r = redactSecrets('api_key=sk-abcdef1234567890XYZ done');
    expect(r.hits).toBe(1);
    expect(r.text).toContain('api_key=');
    expect(r.text).not.toContain('sk-abcdef1234567890XYZ');
    // 23 字符的值 → 留首 4 尾 4，中间打码（够认得出是哪一把，又不足以爆破）
    expect(r.text).toBe('api_key=sk-a...0XYZ done');
  });

  it('JSON 形态的键值对同样处理，且结果仍是合法 JSON', () => {
    const src = '{"authorization": "Bearer abcdefghijklmnopqrst", "model": "qwen-max"}';
    const r = redactSecrets(src);
    expect(r.hits).toBeGreaterThanOrEqual(1);
    expect(r.text).not.toContain('abcdefghijklmnopqrst');
    // 脱敏不得引入引号/反斜杠/换行，否则拿到包的人 jq 一下直接解析失败
    expect(() => JSON.parse(r.text)).not.toThrow();
    const parsed = JSON.parse(r.text) as Record<string, string>;
    expect(parsed.model).toBe('qwen-max');
  });

  it('Bearer 只打 token，保留 scheme', () => {
    const r = redactSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz');
    expect(r.text).toMatch(/^Authorization: Bearer abcd\.\.\.wxyz$/);
  });

  it('sk- 前缀独立识别（键名不在名单里也能抓到）', () => {
    const r = redactSecrets('got key sk-0123456789abcdefghij');
    expect(r.hits).toBe(1);
    expect(r.text).not.toContain('0123456789abcdefghij');
  });

  it('JWT 三段式整体打码', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
    const r = redactSecrets(`token: ${jwt}`);
    expect(r.hits).toBeGreaterThanOrEqual(1);
    expect(r.text).not.toContain(jwt);
  });

  it('短值（<12）整串打码，不留可爆破残段', () => {
    const r = redactSecrets('password=short1234');
    expect(r.text).toBe('password=****');
  });

  it('大小写不敏感（Authorization / API_KEY / TOKEN 都抓）', () => {
    expect(redactSecrets('API_KEY=abcdefghijklmn').hits).toBe(1);
    expect(redactSecrets('TOKEN=abcdefghijklmn').hits).toBe(1);
    expect(redactSecrets('Secret: abcdefghijklmn').hits).toBe(1);
  });
});

describe('redactSecrets：不该脱的', () => {
  it('input_tokens / total_tokens / cache_read_tokens 不误伤', () => {
    // ⚠️ 值必须**长到能过 8 字符门槛**：用 `input_tokens=1234` 做负向用例是自欺欺人——
    // 它本来就被长度挡掉，证明不了「键名不在凭据名单里」这条判据真的在工作。
    const src = 'input_tokens=1234567890 total_tokens: 5678901234 cache_read_tokens=42';
    const r = redactSecrets(src);
    expect(r.hits).toBe(0);
    expect(r.text).toBe(src);
  });

  it('token_count / tokens 之类的派生字段不误伤', () => {
    const src = 'token_count=9 tokens=3';
    expect(redactSecrets(src).hits).toBe(0);
  });

  it('sha256 摘要不脱敏（args_digest 是定位调用的线索）', () => {
    const digest = 'a'.repeat(64);
    const r = redactSecrets(`args_digest=${digest}`);
    expect(r.hits).toBe(0);
    expect(r.text).toContain(digest);
  });

  it('普通字段与路径原样保留', () => {
    const src = 'model=qwen-max path=D:\\\\Work\\\\nanowork duration_ms=812';
    expect(redactSecrets(src).text).toBe(src);
  });

  it('没有任何匹配时 hits 为 0（README 里如实写「命中 0 处」）', () => {
    expect(redactSecrets('plain log line').hits).toBe(0);
  });
});

describe('redactSecretsIn', () => {
  it('批量处理并累计命中数', () => {
    const r = redactSecretsIn(['api_key=abcdefghijklmn', 'nothing here', 'token=abcdefghijklmn']);
    expect(r.hits).toBe(2);
    expect(r.texts[0]).not.toContain('abcdefghijklmn');
    expect(r.texts[1]).toBe('nothing here');
  });
});
