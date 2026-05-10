const { readJson, storageProvider, writeJson } = require("./storage");

const STATE_PATH = "meme-coin-control-center/shared-paper-state.json";

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const state = await readJson(STATE_PATH, null);
      return sendJson(res, 200, { ok: true, storage: { provider: storageProvider() }, state });
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const payload = JSON.parse(body || "{}");
      if (!payload || typeof payload !== "object" || !payload.state) {
        return sendJson(res, 400, { ok: false, error: "missing-state" });
      }

      const versionedState = {
        ...payload.state,
        sharedUpdatedAt: Date.now()
      };

      const stored = await writeJson(STATE_PATH, versionedState);

      return sendJson(res, 200, { ok: true, storage: { provider: stored.provider }, state: versionedState });
    }

    res.setHeader("Allow", "GET, POST");
    return sendJson(res, 405, { ok: false, error: "method-not-allowed" });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error.message });
  }
};
