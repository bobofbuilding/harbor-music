const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const directory = process.argv[2];

https.createServer({
  cert: fs.readFileSync(directory + "/cert.pem"),
  key: fs.readFileSync(directory + "/key.pem"),
}, (request, response) => {
  if (fs.existsSync(directory + "/unreachable")) {
    response.writeHead(503);
    response.end();
    return;
  }
  const url = new URL(request.url, "https://localhost");
  const pageFailure = directory + "/page-failure";
  if (url.pathname === "/music/api/tracks" && url.searchParams.get("offset") === "100" && fs.existsSync(pageFailure)) {
    fs.unlinkSync(pageFailure);
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end("{}");
    return;
  }
  const upstream = http.request({
    hostname: "127.0.0.1", port: 28766, path: request.url,
    method: request.method, headers: request.headers,
  }, result => {
    response.writeHead(result.statusCode, result.headers);
    result.pipe(response);
  });
  upstream.on("error", () => { response.writeHead(502); response.end(); });
  request.pipe(upstream);
}).listen(28767, "127.0.0.1");
