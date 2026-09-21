import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Step 14A contract upload (POST /api/finance/contracts/upload, multipart PDF <= 10 MB).
    // src/proxy.ts matches every /api/* path, and while a proxy is present Next buffers each request
    // body in memory and TRUNCATES it at this limit WITHOUT failing the request (default 10 MB =
    // 10485760 bytes). A 10 MB PDF plus multipart framing is a few hundred bytes over that default, so
    // the body would arrive cut short (a corrupt PDF / an unterminated multipart). 11 MB leaves
    // headroom for the framing; the upload route itself rejects anything over 10 MB + 64 KB
    // (src/server/finance-agreements/upload-request.ts), which must stay below this value.
    // It also raises the (in-memory) buffer for every other /api/* request body from 10 MB to 11 MB.
    proxyClientMaxBodySize: "11mb",
  },
};

export default nextConfig;
