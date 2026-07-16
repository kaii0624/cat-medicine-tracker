const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json({ ok: true });
      }

      if (url.pathname === "/api/records" && request.method === "GET") {
        if (!canRead(request, env)) return unauthorized();
        return listRecords(env);
      }

      if (url.pathname === "/api/records" && request.method === "PUT") {
        if (!isSameOrigin(request, url)) return forbidden();
        if (!canWrite(request, env)) return unauthorized();
        return upsertRecord(request, env);
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/api/records/")) {
        if (!isSameOrigin(request, url)) return forbidden();
        if (!canWrite(request, env)) return unauthorized();
        return deleteRecord(url, env);
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error("API request failed", error);
      return json({ error: "Server error" }, 500);
    }
  },
};

async function listRecords(env) {
  const result = await env.DB.prepare(
    `SELECT
       date_key AS dateKey,
       period,
       timestamp,
       updated_at AS updatedAt
     FROM dose_records
     ORDER BY timestamp ASC
     LIMIT 240`,
  ).all();

  const records = (result.results || []).map((record) => ({
    id: `${record.dateKey}-${record.period}`,
    dateKey: record.dateKey,
    period: record.period,
    timestamp: record.timestamp,
    updatedAt: record.updatedAt,
  }));
  return json({ records });
}

async function upsertRecord(request, env) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > 2048) return json({ error: "Request too large" }, 413);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const validationError = validateRecord(body);
  if (validationError) return json({ error: validationError }, 400);

  const timestamp = new Date(body.timestamp).toISOString();
  const updatedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO dose_records (date_key, period, timestamp, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(date_key, period)
     DO UPDATE SET timestamp = excluded.timestamp, updated_at = excluded.updated_at`,
  )
    .bind(body.dateKey, body.period, timestamp, updatedAt)
    .run();

  return json({
    record: {
      id: `${body.dateKey}-${body.period}`,
      dateKey: body.dateKey,
      period: body.period,
      timestamp,
      updatedAt,
    },
  });
}

async function deleteRecord(url, env) {
  const parts = url.pathname.split("/").filter(Boolean);
  const dateKey = parts[2];
  const period = parts[3];
  if (!isDateKey(dateKey) || !isPeriod(period)) {
    return json({ error: "Invalid record key" }, 400);
  }

  await env.DB.prepare("DELETE FROM dose_records WHERE date_key = ? AND period = ?")
    .bind(dateKey, period)
    .run();
  return json({ ok: true });
}

function validateRecord(record) {
  if (!record || typeof record !== "object") return "Invalid record";
  if (!isDateKey(record.dateKey)) return "Invalid date";
  if (!isPeriod(record.period)) return "Invalid period";

  const timestamp = new Date(record.timestamp);
  if (!Number.isFinite(timestamp.getTime())) return "Invalid timestamp";
  const now = Date.now();
  if (timestamp.getTime() > now + 5 * 60_000) return "Future timestamps are not allowed";
  if (timestamp.getTime() < now - 400 * 24 * 60 * 60_000) return "Timestamp is too old";
  return "";
}

function isDateKey(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isPeriod(value) {
  return value === "morning" || value === "evening";
}

function canRead(request, env) {
  const token = bearerToken(request);
  return secureEqual(token, env.VIEW_TOKEN) || secureEqual(token, env.ADMIN_TOKEN);
}

function canWrite(request, env) {
  return secureEqual(bearerToken(request), env.ADMIN_TOKEN);
}

function bearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

function secureEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function isSameOrigin(request, url) {
  const origin = request.headers.get("Origin");
  return !origin || origin === url.origin;
}

function unauthorized() {
  return json({ error: "Unauthorized" }, 401);
}

function forbidden() {
  return json({ error: "Forbidden" }, 403);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
