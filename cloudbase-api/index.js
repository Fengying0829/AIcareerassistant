const crypto = require("crypto");
const tcb = require("@cloudbase/node-sdk");

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_FREE_QUOTA = 3;
const RESERVED_USER_IDS = new Set(["admin", "root", "system", "null", "undefined", "support"]);

const cloud = tcb.init({ env: tcb.SYMBOL_CURRENT_ENV });
const db = cloud.database();
const $ = db.command;

exports.main = async function main(event) {
  const method = event.httpMethod || event.requestContext?.http?.method || "GET";
  const path = getPath(event);
  const headers = corsHeaders();

  if (method === "OPTIONS") return json(204, {}, headers);

  try {
    if (method === "POST" && path.endsWith("/api/events")) return await handleEvent(event, headers);
    if (method === "GET" && path.endsWith("/api/analytics")) return await handleAnalytics(headers);
    if (method === "POST" && path.endsWith("/api/user/register")) return await handleUserRegister(event, headers);
    if (method === "GET" && path.endsWith("/api/me")) return await handleMe(event, headers);
    if (method === "POST" && path.endsWith("/api/match")) return await handleMatch(event, headers);
    if (method === "POST" && path.endsWith("/api/admin/login")) return await handleAdminLogin(event, headers);
    if (method === "GET" && path.endsWith("/api/admin/users")) return await handleAdminUsers(event, headers);
    if (method === "POST" && path.endsWith("/api/admin/quota/grant")) return await handleAdminGrant(event, headers);

    return json(404, { error: "NOT_FOUND", message: "接口不存在。" }, headers);
  } catch (error) {
    return json(500, {
      error: "SERVER_ERROR",
      message: error.message || "服务器错误。"
    }, headers);
  }
};

async function handleUserRegister(event, headers) {
  const { userId } = parseBody(event);
  const normalized = normalizeUserId(userId);
  const invalid = validateUserId(normalized);
  if (invalid) return json(400, invalid, headers);

  const existing = await getUser(normalized);
  if (existing) {
    return json(409, {
      error: "USER_ID_TAKEN",
      message: "这个用户ID已被使用，请换一个。"
    }, headers);
  }

  const now = new Date().toISOString();
  const user = {
    user_id: normalized,
    quota_remaining: DEFAULT_FREE_QUOTA,
    total_match_count: 0,
    total_upload_count: 0,
    status: "active",
    created_at: now,
    last_active_at: now
  };

  await db.collection("users").doc(normalized).set(user);
  await writeQuotaLog(normalized, DEFAULT_FREE_QUOTA, "free_trial", "system");

  return json(200, publicUser(user), headers);
}

async function handleMe(event, headers) {
  const userId = normalizeUserId(getQuery(event).userId);
  const invalid = validateUserId(userId);
  if (invalid) return json(400, invalid, headers);

  const user = await getUser(userId);
  if (!user) {
    return json(404, {
      error: "USER_NOT_FOUND",
      message: "用户不存在，请先创建用户ID。"
    }, headers);
  }

  await touchUser(userId);
  return json(200, publicUser(user), headers);
}

async function handleMatch(event, headers) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const model = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL;

  if (!apiKey) {
    return json(503, {
      error: "MISSING_DEEPSEEK_API_KEY",
      message: "后端没有配置 DEEPSEEK_API_KEY。请在腾讯云函数环境变量里添加。"
    }, headers);
  }

  const input = parseBody(event);
  const userId = normalizeUserId(input.userId);
  const invalid = validateUserId(userId);
  if (invalid) return json(400, invalid, headers);

  const user = await getUser(userId);
  if (!user) {
    return json(404, {
      error: "USER_NOT_FOUND",
      message: "用户不存在，请先创建用户ID。"
    }, headers);
  }

  if (Number(user.quota_remaining || 0) <= 0) {
    return json(402, {
      error: "QUOTA_EXHAUSTED",
      message: `免费次数已用完，请联系管理员添加次数。请提供你的用户ID：${userId}`,
      user: publicUser(user)
    }, headers);
  }

  const resumeText = String(input.resumeText || "").trim();
  const jdText = String(input.jdText || "").trim();
  if (resumeText.length < 30) {
    return json(400, { error: "RESUME_TEXT_TOO_SHORT", message: "请先上传并解析一份有效简历。" }, headers);
  }
  if (jdText.length < 30) {
    return json(400, { error: "JD_TEXT_TOO_SHORT", message: "请先粘贴一段有效岗位 JD。" }, headers);
  }

  const startedAt = Date.now();
  const traceId = crypto.randomUUID ? crypto.randomUUID() : `trace_${Date.now()}`;

  const deepseekResponse = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: [
            "你是面向中国求职者的简历与岗位 JD 匹配分析专家。",
            "你必须只返回合法 JSON object，不要返回 Markdown，不要返回解释性文字。",
            "不要编造用户没有提供的经历；所有改写建议必须基于简历原文。",
            "输出字段必须包含 score, level, dimensions, reason, matches, gaps, rewrites, interviews, advice。"
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            instruction: "请基于简历文本和岗位 JD 生成匹配分析 JSON。",
            output_schema: {
              score: "0-100 integer",
              level: "string",
              dimensions: [{ label: "技能匹配|项目经验|行业背景|教育经历|表达完整度", score: "0-100 integer", note: "string" }],
              reason: "string",
              matches: ["string"],
              gaps: ["string"],
              rewrites: [{ gap: "string", original: "string", improved: "string", why: "string" }],
              interviews: [{ question: "string", answer_hint: "string", risk: "string" }],
              advice: ["string"]
            },
            resumeText: resumeText.slice(0, 20000),
            jdText: jdText.slice(0, 12000)
          })
        }
      ],
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
      temperature: 0.2,
      max_tokens: 3000,
      stream: false
    })
  });

  const raw = await deepseekResponse.text();
  let deepseekPayload;
  try {
    deepseekPayload = JSON.parse(raw);
  } catch {
    return json(502, {
      error: "DEEPSEEK_NON_JSON",
      message: "DeepSeek 返回了非 JSON 响应。",
      detail: raw.slice(0, 300)
    }, headers);
  }

  if (!deepseekResponse.ok) {
    return json(deepseekResponse.status, {
      error: "DEEPSEEK_ERROR",
      message: deepseekPayload.error?.message || "DeepSeek 调用失败。",
      detail: deepseekPayload
    }, headers);
  }

  let report;
  const content = deepseekPayload.choices?.[0]?.message?.content || "{}";
  try {
    report = JSON.parse(content);
  } catch {
    return json(502, {
      error: "DEEPSEEK_REPORT_INVALID_JSON",
      message: "DeepSeek 的分析结果不是合法 JSON。",
      detail: content.slice(0, 300)
    }, headers);
  }

  const usage = normalizeUsage(deepseekPayload.usage || {});
  report.usage = {
    ...usage,
    model,
    latency_ms: Date.now() - startedAt,
    estimated_cost_usd: estimateCost(usage.input_tokens, usage.output_tokens)
  };
  report.traceId = traceId;

  const now = new Date().toISOString();
  await db.collection("users").doc(userId).update({
    quota_remaining: $.inc(-1),
    total_match_count: $.inc(1),
    last_active_at: now
  });
  await writeQuotaLog(userId, -1, "match_success", "system");
  await db.collection("match_jobs").add({
    user_id: userId,
    score: Number(report.score || 0),
    model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    estimated_cost_usd: report.usage.estimated_cost_usd,
    trace_id: traceId,
    created_at: now
  });

  const updated = await getUser(userId);
  report.user = publicUser(updated);
  return json(200, report, headers);
}

async function handleAdminLogin(event, headers) {
  const input = parseBody(event);
  const expectedUser = process.env.ADMIN_USERNAME || "admin";
  const expectedPassword = process.env.ADMIN_PASSWORD || "";

  if (!expectedPassword) {
    return json(503, {
      error: "ADMIN_PASSWORD_NOT_CONFIGURED",
      message: "请先在云函数环境变量里配置 ADMIN_PASSWORD。"
    }, headers);
  }

  if (String(input.username || "") !== expectedUser || String(input.password || "") !== expectedPassword) {
    return json(401, {
      error: "ADMIN_LOGIN_FAILED",
      message: "管理员账号或密码错误。"
    }, headers);
  }

  return json(200, {
    token: signToken({ role: "admin", username: expectedUser, exp: Date.now() + 12 * 60 * 60 * 1000 }),
    username: expectedUser
  }, headers);
}

async function handleAdminUsers(event, headers) {
  const auth = requireAdmin(event);
  if (auth.error) return json(auth.status, auth.error, headers);

  const result = await db.collection("users").orderBy("last_active_at", "desc").limit(100).get();
  return json(200, {
    users: (result.data || []).map(publicUser)
  }, headers);
}

async function handleAdminGrant(event, headers) {
  const auth = requireAdmin(event);
  if (auth.error) return json(auth.status, auth.error, headers);

  const input = parseBody(event);
  const userId = normalizeUserId(input.userId);
  const amount = Math.floor(Number(input.amount || 0));
  const invalid = validateUserId(userId);
  if (invalid) return json(400, invalid, headers);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 999) {
    return json(400, {
      error: "INVALID_QUOTA_AMOUNT",
      message: "增加次数必须是 1 到 999 之间的整数。"
    }, headers);
  }

  const user = await getUser(userId);
  if (!user) {
    return json(404, {
      error: "USER_NOT_FOUND",
      message: "用户不存在，请确认用户ID是否填写正确。"
    }, headers);
  }

  await db.collection("users").doc(userId).update({
    quota_remaining: $.inc(amount),
    last_active_at: new Date().toISOString()
  });
  await writeQuotaLog(userId, amount, "admin_grant", auth.payload.username || "admin");

  const updated = await getUser(userId);
  return json(200, {
    ok: true,
    user: publicUser(updated)
  }, headers);
}

async function handleEvent(event, headers) {
  const raw = parseBody(event);
  const eventDoc = sanitizeEvent(raw);
  await db.collection("events").add(eventDoc);

  const userId = normalizeUserId(raw.user_id_hash || raw.userId || "");
  if (userId && !validateUserId(userId) && eventDoc.event_name === "resume_parse_success") {
    try {
      await db.collection("users").doc(userId).update({
        total_upload_count: $.inc(1),
        last_active_at: new Date().toISOString()
      });
    } catch {}
  }

  return json(200, { ok: true }, headers);
}

async function handleAnalytics(headers) {
  const eventsResult = await db.collection("events").orderBy("timestamp", "desc").limit(200).get().catch(() => ({ data: [] }));

  const events = eventsResult.data || [];
  const count = name => events.filter(e => e.event_name === name).length;
  const scores = events.filter(e => e.event_name === "match_success").map(e => Number(e.properties?.score || 0)).filter(Boolean);
  const costs = events.reduce((sum, e) => sum + Number(e.properties?.estimated_cost_usd || 0), 0);
  const topEvents = Object.entries(events.reduce((memo, e) => {
    memo[e.event_name] = (memo[e.event_name] || 0) + 1;
    return memo;
  }, {})).sort((a, b) => b[1] - a[1]).map(([event_name, count]) => ({ event_name, count }));

  return json(200, {
    source: "cloudbase",
    totals: {
      pv: count("page_view"),
      uploads: count("resume_parse_success"),
      matches: count("match_success"),
      failures: count("match_failed") + count("resume_parse_failed"),
      apiCostUsd: costs,
      averageScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0
    },
    topEvents,
    recentEvents: events,
    users: [],
    feedback: []
  }, headers);
}

async function getUser(userId) {
  try {
    const result = await db.collection("users").doc(userId).get();
    return result.data && result.data.length ? result.data[0] : null;
  } catch {
    return null;
  }
}

async function touchUser(userId) {
  try {
    await db.collection("users").doc(userId).update({ last_active_at: new Date().toISOString() });
  } catch {}
}

async function writeQuotaLog(userId, change, reason, operator) {
  await db.collection("quota_logs").add({
    user_id: userId,
    change,
    reason,
    operator,
    created_at: new Date().toISOString()
  });
}

function publicUser(user) {
  return {
    user_id: user.user_id || user._id,
    quota_remaining: Number(user.quota_remaining || 0),
    total_match_count: Number(user.total_match_count || 0),
    total_upload_count: Number(user.total_upload_count || 0),
    status: user.status || "active",
    created_at: user.created_at || "",
    last_active_at: user.last_active_at || ""
  };
}

function normalizeUserId(userId) {
  return String(userId || "").trim().toLowerCase();
}

function validateUserId(userId) {
  if (!/^[a-z0-9_-]{4,24}$/.test(userId)) {
    return {
      error: "INVALID_USER_ID",
      message: "用户ID需要 4-24 位，只能使用英文、数字、下划线或短横线。"
    };
  }
  if (/^\d{11}$/.test(userId) || RESERVED_USER_IDS.has(userId)) {
    return {
      error: "RESERVED_USER_ID",
      message: "这个用户ID不可使用，请换一个。"
    };
  }
  return null;
}

function requireAdmin(event) {
  const auth = getHeader(event, "authorization");
  const token = auth && auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const payload = verifyToken(token);
  if (!payload || payload.role !== "admin") {
    return {
      status: 401,
      error: { error: "ADMIN_UNAUTHORIZED", message: "请先登录管理员账号。" }
    };
  }
  return { payload };
}

function signToken(payload) {
  const secret = process.env.ADMIN_TOKEN_SECRET || process.env.ADMIN_PASSWORD || "change-me";
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyToken(token) {
  try {
    const [body, sig] = String(token || "").split(".");
    if (!body || !sig) return null;
    const secret = process.env.ADMIN_TOKEN_SECRET || process.env.ADMIN_PASSWORD || "change-me";
    const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseBody(event) {
  if (!event.body) return {};
  const text = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return typeof text === "string" ? JSON.parse(text || "{}") : text;
}

function getQuery(event) {
  if (event.queryStringParameters) return event.queryStringParameters;
  if (event.query) return event.query;
  const raw = event.rawQueryString || "";
  return Object.fromEntries(new URLSearchParams(raw));
}

function getPath(event) {
  return event.path || event.requestContext?.http?.path || event.rawPath || "/";
}

function getHeader(event, name) {
  const headers = event.headers || {};
  const key = Object.keys(headers).find(k => k.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : "";
}

function normalizeUsage(usage) {
  return {
    input_tokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    output_tokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    total_tokens: Number(usage.total_tokens || 0)
  };
}

function estimateCost(inputTokens, outputTokens) {
  const inputCost = Number(inputTokens || 0) * 0.14 / 1000000;
  const outputCost = Number(outputTokens || 0) * 0.28 / 1000000;
  return Number((inputCost + outputCost).toFixed(6));
}

function sanitizeEvent(raw) {
  const allow = new Set([
    "page", "role", "file_type", "file_size_kb", "resume_text_len", "jd_text_len",
    "score", "latency_ms", "model", "input_tokens", "output_tokens",
    "estimated_cost_usd", "error_code", "tab", "scroll_depth", "endpoint", "status",
    "device_type", "viewport_width", "viewport_height", "screen_width", "screen_height",
    "browser_language", "timezone", "referrer", "page_url"
  ]);
  const props = {};
  Object.entries(raw.properties || {}).forEach(([key, value]) => {
    if (!allow.has(key)) return;
    if (typeof value === "number") props[key] = Number.isFinite(value) ? value : 0;
    else if (typeof value === "boolean") props[key] = value;
    else props[key] = String(value ?? "").slice(0, 120);
  });
  return {
    event_name: String(raw.event_name || "unknown").slice(0, 80),
    user_id_hash: String(raw.user_id_hash || raw.userId || "anonymous").slice(0, 120),
    session_id: String(raw.session_id || "session").slice(0, 120),
    timestamp: raw.timestamp || new Date().toISOString(),
    properties: props
  };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "https://www.echo0829.cn",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Content-Type": "application/json; charset=utf-8"
  };
}

function json(statusCode, payload, headers) {
  return {
    statusCode,
    headers,
    body: statusCode === 204 ? "" : JSON.stringify(payload)
  };
}
