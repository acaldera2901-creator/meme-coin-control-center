const { get, list, put } = require("@vercel/blob");

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

async function redisCommand(command) {
  const config = redisConfig();
  if (!config) throw new Error("Upstash Redis env not configured");
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error || `Upstash HTTP ${response.status}`);
  return payload.result;
}

async function readBlobJson(path, fallback) {
  const listed = await list({ prefix: path, limit: 1 });
  const blob = listed.blobs.find((item) => item.pathname === path);
  if (!blob) return fallback;
  const stored = await get(path, { access: "private" });
  if (!stored || stored.statusCode !== 200 || !stored.stream) return fallback;
  return JSON.parse(await new Response(stored.stream).text());
}

async function writeBlobJson(path, value) {
  await put(path, JSON.stringify(value), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json"
  });
}

async function readJson(path, fallback) {
  if (redisConfig()) {
    const result = await redisCommand(["GET", path]);
    return result ? JSON.parse(result) : fallback;
  }
  return readBlobJson(path, fallback);
}

async function writeJson(path, value) {
  if (redisConfig()) {
    await redisCommand(["SET", path, JSON.stringify(value)]);
    return { provider: "upstash-redis" };
  }
  await writeBlobJson(path, value);
  return { provider: "vercel-blob" };
}

function storageProvider() {
  return redisConfig() ? "upstash-redis" : "vercel-blob";
}

module.exports = {
  readJson,
  writeJson,
  storageProvider
};
