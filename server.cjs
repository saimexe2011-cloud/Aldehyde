const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// Comprehensive MIME type mapping
// Zero-dependency replacement for 'mime-types'
const MIME_TYPES = {
  // Text / Web Standard
  '.html': 'text/html',
  '.htm': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.map': 'application/json',
  '.xml': 'application/xml',

  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.tiff': 'image/tiff',
  '.exr': 'image/x-exr',
  '.hdr': 'image/vnd.radiance',

  // Video / Audio
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',

  // Fonts
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',

  // 3D Models / CAD
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.usdz': 'model/vnd.usdz+zip',
  '.obj': 'model/obj',
  '.mtl': 'model/mtl',
  '.stl': 'model/stl',

  // Documents / Data
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.wasm': 'application/wasm',
};

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, 'http://localhost');
  const decodedPath = decodeURIComponent(requestUrl.pathname);
  if (decodedPath === '/api/health') {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 200;
    res.end(JSON.stringify({ status: 'ok', hasKey: Boolean(process.env.GEMINI_API_KEY || process.env.API_KEY) }));
    return;
  }

  if (decodedPath === '/api/generate-content' && req.method === 'POST') {
    const apiKey = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();
    if (!apiKey) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'GEMINI_API_KEY is not configured.' }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyObj = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
    const rawModel = bodyObj.model || 'gemini-3-flash-preview';
    const model = rawModel === 'gemini-2.5-flash' ? 'gemini-3-flash-preview' : rawModel;
    const contents = typeof bodyObj.contents === 'string'
      ? [{ parts: [{ text: bodyObj.contents }] }]
      : Array.isArray(bodyObj.contents) ? bodyObj.contents : [bodyObj.contents];
    const upstreamUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    try {
      const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({ contents, generationConfig: bodyObj.config }),
      });
      const data = await upstream.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
      res.statusCode = upstream.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ...data, text }));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: e.message || String(e) }));
    }
    return;
  }

  if (decodedPath.startsWith('/api/gemini-proxy/')) {
    const apiKey = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();
    if (!apiKey) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'GEMINI_API_KEY is not configured.' } }));
      return;
    }
    const targetSubpath = decodedPath.slice('/api/gemini-proxy/'.length).replace('models/gemini-2.5-flash:', 'models/gemini-3-flash-preview:');
    const cleanSearch = requestUrl.search.replace(/([?&])key=[^&]*/g, '');
    const upstreamUrl = `https://generativelanguage.googleapis.com/${targetSubpath}${cleanSearch}`;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyBuf = Buffer.concat(chunks);
    try {
      const headers = { 'x-goog-api-key': apiKey };
      if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
      const upstream = await fetch(upstreamUrl, {
        method: req.method,
        headers,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? bodyBuf : undefined,
      });
      res.statusCode = upstream.status;
      const ct = upstream.headers.get('content-type');
      if (ct) res.setHeader('Content-Type', ct);
      const ab = await upstream.arrayBuffer();
      res.end(Buffer.from(ab));
    } catch (e) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: { message: e.message || String(e) } }));
    }
    return;
  }
  if (decodedPath.startsWith('/assets/') && decodedPath.endsWith('.mp3')) {
    try {
      const upstream = await fetch(`https://night-reader-57e64c69-853813963450.us-west1.run.app${decodedPath}`);
      if (upstream.ok) {
        res.statusCode = 200;
        res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        const ab = await upstream.arrayBuffer();
        res.end(Buffer.from(ab));
        return;
      }
    } catch (e) {
      console.error('MP3 proxy error:', e);
    }
  }
  const absolutePath = path.join(ROOT, decodedPath);

  // Trying to access outside the folder
  if (!absolutePath.startsWith(ROOT + path.sep)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  const getStats = async (p) => {
    try {
      const stats = await fs.promises.stat(p);
      return stats.isFile() ? stats : null;
    } catch {
      return null;
    }
  };

  const serveFile = (filePath, stats, statusCode = 200) => {
    const ext = path.extname(filePath).toLowerCase();

    // Default to binary stream if unknown type
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);

    // --- Caching Logic ---
    const mtime = stats.mtime.toUTCString();
    res.setHeader('Last-Modified', mtime);

    // Handle 304 Not Modified
    if (req.headers['if-modified-since'] === mtime) {
      res.statusCode = 304;
      res.end();
      return;
    }

    // Cache-Control Headers
    if (ext === '.html' || ext === '.htm') {
      // HTML: Always validate with server to see if new deployment exists
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      // Assets: Cache for 1 year (Immutable)
      // Assumes build tools (Vite/Next) use hashed filenames for assets
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }

    res.statusCode = statusCode;

    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      console.error('Stream error:', err);
      res.statusCode = 500;
      res.end();
    });
    stream.pipe(res);
  };

  try {
    // --- Resolution Strategy ---

    // 1. Exact Match (e.g. /style.css, /logo.png)
    let stats = await getStats(absolutePath);
    if (stats) return serveFile(absolutePath, stats);

    // 2. HTML Extension (Next.js Export: /about -> /about.html)
    const htmlPath = absolutePath + '.html';
    stats = await getStats(htmlPath);
    if (stats) return serveFile(htmlPath, stats);

    // 3. Directory Index (Standard Web: /blog -> /blog/index.html)
    const dirIndexPath = path.join(absolutePath, 'index.html');
    stats = await getStats(dirIndexPath);
    if (stats) return serveFile(dirIndexPath, stats);

    // 4. Missing File
    // If the URL has an extension at this point return 404.
    if (path.extname(absolutePath)) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    // 5. Custom 404 (Next.js Exports)
    const custom404Path = path.join(ROOT, '404.html');
    stats = await getStats(custom404Path);
    if (stats) return serveFile(custom404Path, stats, 404);

    // 6. SPA Fallback
    const spaIndexPath = path.join(ROOT, 'index.html');
    stats = await getStats(spaIndexPath);
    if (stats) return serveFile(spaIndexPath, stats, 200);

    // 7. Hard 404
    res.statusCode = 404;
    res.end('Not Found');
  } catch (err) {
    console.error('Server error:', err);
    res.statusCode = 500;
    res.end('Internal Server Error');
  }
});

server.listen(PORT, () => {
  console.log(`Static Shim running on http://localhost:${PORT}`);
});
