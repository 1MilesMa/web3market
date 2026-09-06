/**
 * 零依赖静态服务器 —— 只为了把 frontend/ 目录通过 http:// 打开。
 *
 * 为什么不能直接双击 index.html：
 *   浏览器在 file:// 协议下会禁止 fetch 读取同目录的 abi/*.json（CORS 限制），
 *   页面就只能拿到空白 ABI。所以必须用 http:// 访问。
 *
 * 用法（双击本文件，或在终端里执行）：
 *   node serve.js
 * 然后浏览器打开 http://localhost:5173
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT ? Number(process.env.PORT) : 5173;
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel === "/") rel = "/index.html";

  // 防目录穿越：解析后必须仍在 ROOT 之内
  const file = path.resolve(ROOT, "." + rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("403 Forbidden");
    return;
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found: " + rel);
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log("");
  console.log("  SimpleMarket 前端已启动");
  console.log("  ------------------------------------------");
  console.log("  请在浏览器打开： http://localhost:" + PORT);
  console.log("  停止服务：在这个窗口按 Ctrl + C");
  console.log("");
});
