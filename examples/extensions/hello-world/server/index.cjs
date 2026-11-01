/**
 * Hello 扩展的后台服务（`extension.json` 的 `service` 字段）。
 *
 * ## 三条与宿主约定的纪律
 *
 * 1. **端口用 0 让系统分配并打出来**：写死端口迟早冲突，而冲突的表现是
 *    "扩展打不开、宿主说服务在跑"。打印出来的那行会出现在扩展页的服务日志里。
 * 2. **只监听 `127.0.0.1`**：扩展服务不是给局域网用的。绑 `0.0.0.0` 在 Windows 上
 *    还会弹防火墙授权框（用户会以为程序在偷偷联网）。
 * 3. **收到 SIGTERM 就干净退出**：宿主 stop 时先 SIGTERM、3 秒后才 SIGKILL。
 *    我们自己退出，进程列表才不会留残影。
 *
 * ## 环境变量
 *
 * 宿主只传白名单变量（`PATH` / `TEMP` 等）并附带 `NANOWORK_EXTENSION_ID` /
 * `NANOWORK_EXTENSION_ENV=restricted`。**拿不到宿主的任何 API Key**——需要凭据时
 * 由用户在扩展自己的配置里填，而不是顺手读环境。
 */
const http = require('node:http');

const HOST = '127.0.0.1';

const server = http.createServer((req, res) => {
  // 扩展页是 `nanowork-ext://<id>` 这个自定义源，会命中 CORS 预检
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: true,
        extension: process.env.NANOWORK_EXTENSION_ID ?? 'unknown',
        env: process.env.NANOWORK_EXTENSION_ENV ?? 'unknown',
        pid: process.pid,
        uptimeSec: Math.round(process.uptime()),
        // 故意回显"能看到哪些敏感变量"，用来证明宿主的白名单确实生效
        leaked: ['DASHSCOPE_API_KEY', 'NANOWORK_TOKEN', 'OPENAI_API_KEY'].filter(
          (key) => process.env[key] !== undefined,
        ),
      }),
    );
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(0, HOST, () => {
  const { port } = server.address();
  // 这一行会被宿主收进服务日志（扩展页可以展开看），用户据此填上面的端口
  console.log(`hello-world service listening on http://${HOST}:${port}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  // 有长连接时 close 不会立刻回调，兜一下
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
