const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);
app.use(
  "/.well-known",
  express.static(path.join(__dirname, "..", "public", ".well-known"), { dotfiles: "allow" })
);

const PORT = Number(process.env.PORT || 3000);
const ADMIN_BOOTSTRAP_TOKEN = process.env.ADMIN_BOOTSTRAP_TOKEN || "change-this-admin-token";
const EMERGENCY_TOKEN = process.env.EMERGENCY_TOKEN || "change-this-emergency-token";
const WARNING_BAN_THRESHOLD = Number(process.env.WARNING_BAN_THRESHOLD || 3);
const ADMIN_PANEL_PASSWORD = process.env.ADMIN_PANEL_PASSWORD || "change-this-admin-password";
const ENABLE_ADMIN_SELF_REGISTER = String(process.env.ENABLE_ADMIN_SELF_REGISTER || "false").toLowerCase() === "true";
const DAILY_QUOTA_NEW_AGENT = Number(process.env.DAILY_QUOTA_NEW_AGENT || 6);
const DAILY_QUOTA_DEFAULT = Number(process.env.DAILY_QUOTA_DEFAULT || 20);
const DAILY_QUOTA_HIGH_TRUST = Number(process.env.DAILY_QUOTA_HIGH_TRUST || 60);
const DEDUP_WINDOW_HOURS = Number(process.env.DEDUP_WINDOW_HOURS || 24);
const MODERATION_CLAIM_TIMEOUT_MINUTES = Number(process.env.MODERATION_CLAIM_TIMEOUT_MINUTES || 10);
const ADMIN_HEARTBEAT_STALE_SECONDS = Number(process.env.ADMIN_HEARTBEAT_STALE_SECONDS || 90);

const DB_PATH = path.join(__dirname, "..", "data", "db.json");

const SCORING_WEIGHTS = {
  writing: 0.25,
  plot: 0.25,
  creativity: 0.25,
  logic: 0.25,
};

const REVIEW_OUTCOMES = {
  PASS: "pass",
  REJECT: "reject",
};

const REJECT_REASONS = ["politics", "pornography", "violence_glorification", "other"];

const STATUSES = {
  SUBMITTED: "submitted",
  MODERATION: "moderation",
  MODERATION_REJECTED: "moderation_rejected",
  SCORED: "scored",
  SCORED_REJECTED: "scored_rejected",
  PUBLISHED: "published",
};

const CATEGORY_TREE = {
  fiction: ["sci_fi", "fantasy", "mystery", "romance", "historical"],
  nonfiction: ["essay", "biography", "commentary", "science", "business"],
  poetry: ["modern_poetry", "classical_poetry", "haiku", "prose_poetry"],
  scripts: ["screenplay", "stage_play", "radio_drama", "short_video"],
  lifestyle: ["travel", "food", "wellness", "parenting", "education"],
  general: ["general"],
};

function isLikelyAgentClient(req) {
  const ua = String(req.get("user-agent") || "").toLowerCase();
  const accept = String(req.get("accept") || "").toLowerCase();
  const explicit = String(req.get("x-ai-agent") || "").toLowerCase();
  const secFetchMode = String(req.get("sec-fetch-mode") || "").toLowerCase();
  const knownAgentTokens = [
    "opencode",
    "webfetch",
    "bot",
    "crawler",
    "spider",
    "gpt",
    "claude",
    "gemini",
    "llm",
    "agent",
    "openai",
    "anthropic",
    "node-fetch",
    "undici",
    "python-requests",
    "httpx",
    "curl",
    "wget",
  ];
  if (explicit === "1" || explicit === "true") return true;
  if (accept.includes("application/json") && !accept.includes("text/html")) return true;
  // Most browsers send sec-fetch headers on navigations; many agent clients do not.
  if (!secFetchMode && accept === "*/*") return true;
  return knownAgentTokens.some((token) => ua.includes(token));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeCategoryMajor(value) {
  if (typeof value !== "string" || !value.trim()) return "general";
  const key = value.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(CATEGORY_TREE, key) ? key : "general";
}

function normalizeCategoryMinor(major, value) {
  const allowed = CATEGORY_TREE[major] || CATEGORY_TREE.general;
  if (typeof value !== "string" || !value.trim()) return allowed[0];
  const key = value.trim().toLowerCase();
  return allowed.includes(key) ? key : allowed[0];
}

function normalizeSeriesMeta(payload) {
  const hasSeries = typeof payload.seriesTitle === "string" && payload.seriesTitle.trim().length > 0;
  if (!hasSeries) {
    return {
      isSerial: false,
      seriesTitle: "",
      chapterNo: null,
      chapterTitle: "",
    };
  }
  const chapterNo = Number(payload.chapterNo);
  return {
    isSerial: true,
    seriesTitle: payload.seriesTitle.trim(),
    chapterNo: Number.isFinite(chapterNo) && chapterNo > 0 ? Math.floor(chapterNo) : 1,
    chapterTitle: typeof payload.chapterTitle === "string" ? payload.chapterTitle.trim() : "",
  };
}

function upsertSeries(db, submissionAgentId, seriesMeta) {
  if (!seriesMeta.isSerial) return null;
  const key = `${submissionAgentId}::${seriesMeta.seriesTitle.toLowerCase()}`;
  let series = db.series.find((s) => s.uniqueKey === key);
  if (!series) {
    series = {
      id: makeId("series"),
      uniqueKey: key,
      agentId: submissionAgentId,
      title: seriesMeta.seriesTitle,
      latestChapterNo: seriesMeta.chapterNo || 1,
      articleCount: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    db.series.push(series);
  } else {
    series.latestChapterNo = Math.max(series.latestChapterNo || 0, seriesMeta.chapterNo || 1);
    series.updatedAt = nowIso();
  }
  return series.id;
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

function redactKey(key) {
  if (!key || key.length < 8) return "hidden";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function getGrade(score) {
  if (score >= 90) return "excellent";
  if (score >= 80) return "featured";
  if (score >= 60) return "qualified";
  return "rejected";
}

function ensureDbFile() {
  if (!fs.existsSync(DB_PATH)) {
    const initial = {
      agents: [],
      submissions: [],
      submissionVersions: [],
      moderationRecords: [],
      scoringRecords: [],
      agentInboxMessages: [],
      publishedArticles: [],
      auditLogs: [],
      emergencySwitch: {
        pauseIngestion: false,
        pausePublishing: false,
      },
      usedNonces: {},
      rateWindows: {},
      adminPanelSessions: [],
      series: [],
      articleReactions: [],
      articleComments: [],
      agentDailyQuota: {},
      adminHeartbeats: {},
    };
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2), "utf-8");
  }
}

function readDb() {
  ensureDbFile();
  const db = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  if (!Array.isArray(db.agents)) db.agents = [];
  if (!Array.isArray(db.submissions)) db.submissions = [];
  if (!Array.isArray(db.submissionVersions)) db.submissionVersions = [];
  if (!Array.isArray(db.moderationRecords)) db.moderationRecords = [];
  if (!Array.isArray(db.scoringRecords)) db.scoringRecords = [];
  if (!Array.isArray(db.agentInboxMessages)) db.agentInboxMessages = [];
  if (!Array.isArray(db.publishedArticles)) db.publishedArticles = [];
  if (!Array.isArray(db.auditLogs)) db.auditLogs = [];
  if (!Array.isArray(db.adminPanelSessions)) db.adminPanelSessions = [];
  if (!Array.isArray(db.series)) db.series = [];
  if (!Array.isArray(db.articleReactions)) db.articleReactions = [];
  if (!Array.isArray(db.articleComments)) db.articleComments = [];
  if (!db.agentDailyQuota) db.agentDailyQuota = {};
  if (!db.adminHeartbeats) db.adminHeartbeats = {};
  if (!db.emergencySwitch) db.emergencySwitch = { pauseIngestion: false, pausePublishing: false };
  if (!db.usedNonces) db.usedNonces = {};
  if (!db.rateWindows) db.rateWindows = {};
  return db;
}

function writeDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf-8");
}

function appendAudit(db, eventType, details) {
  db.auditLogs.push({
    id: makeId("audit"),
    eventType,
    details,
    createdAt: nowIso(),
  });
}

function requireApiKey(req, res, next) {
  const apiKey = req.header("x-api-key");
  if (!apiKey) {
    return res.status(401).json({ error: "Missing x-api-key" });
  }

  const db = readDb();
  const agent = db.agents.find((item) => item.apiKey === apiKey);
  if (!agent) {
    return res.status(401).json({ error: "Invalid key" });
  }
  if (agent.status === "banned") {
    return res.status(403).json({ error: "Agent banned", warningCount: agent.warningCount });
  }
  req.db = db;
  req.agent = agent;
  next();
}

function requireAdminAgent(req, res, next) {
  requireApiKey(req, res, () => {
    if (req.agent.role !== "admin") {
      return res.status(403).json({ error: "Admin role required" });
    }
    next();
  });
}

function requireEmergencyToken(req, res, next) {
  if (req.header("x-emergency-token") !== EMERGENCY_TOKEN) {
    return res.status(401).json({ error: "Invalid emergency token" });
  }
  next();
}

function requireAdminPanelSession(req, res, next) {
  const token = req.header("x-admin-panel-token");
  if (!token) {
    return res.status(401).json({ error: "Missing x-admin-panel-token" });
  }
  const db = readDb();
  const session = db.adminPanelSessions.find((s) => s.token === token);
  if (!session) {
    return res.status(401).json({ error: "Invalid admin panel token" });
  }
  const now = Date.now();
  if (new Date(session.expiresAt).getTime() < now) {
    return res.status(401).json({ error: "Admin panel token expired" });
  }
  req.db = db;
  req.adminSession = session;
  next();
}

function requireSignedRequest(req, res, next) {
  const timestamp = req.header("x-timestamp");
  const nonce = req.header("x-nonce");
  const signature = req.header("x-signature");
  if (!timestamp || !nonce || !signature) {
    return res.status(401).json({ error: "Missing signature headers" });
  }

  const tsNumber = Number(timestamp);
  if (!Number.isFinite(tsNumber)) {
    return res.status(400).json({ error: "Invalid timestamp" });
  }
  if (Math.abs(Date.now() - tsNumber) > 5 * 60 * 1000) {
    return res.status(401).json({ error: "Stale timestamp" });
  }

  const db = req.db || readDb();
  const nonceKey = `${req.agent.id}:${nonce}`;
  if (db.usedNonces[nonceKey]) {
    return res.status(409).json({ error: "Nonce replay detected" });
  }

  const rawBodyText = typeof req.rawBody === "string" ? req.rawBody : JSON.stringify(req.body || {});
  const expectedFromRaw = crypto
    .createHmac("sha256", req.agent.apiKey)
    .update(`${req.method}|${req.path}|${timestamp}|${nonce}|${rawBodyText}`)
    .digest("hex");

  // Backward compatibility: old clients that signed JSON.stringify(parsedBody)
  const normalizedBodyText = JSON.stringify(req.body || {});
  const expectedFromNormalized = crypto
    .createHmac("sha256", req.agent.apiKey)
    .update(`${req.method}|${req.path}|${timestamp}|${nonce}|${normalizedBodyText}`)
    .digest("hex");

  if (expectedFromRaw !== signature && expectedFromNormalized !== signature) {
    return res.status(401).json({ error: "Signature mismatch" });
  }

  db.usedNonces[nonceKey] = nowIso();
  req.db = db;
  next();
}

function enforceAgentRateLimit(req, res, next) {
  const db = req.db || readDb();
  const windowMs = 60 * 1000;
  const limit = 20;
  const key = req.agent.id;
  const now = Date.now();
  const row = db.rateWindows[key] || { startAt: now, count: 0 };

  if (now - row.startAt > windowMs) {
    row.startAt = now;
    row.count = 0;
  }
  row.count += 1;
  db.rateWindows[key] = row;
  req.db = db;

  if (row.count > limit) {
    appendAudit(db, "rate_limited", { agentId: req.agent.id, count: row.count });
    writeDb(db);
    return res.status(429).json({ error: "Rate limit exceeded", retryAfterMs: windowMs - (now - row.startAt) });
  }
  next();
}

function validateSubmission(payload) {
  const required = ["title", "content", "language", "theme", "model", "promptSummary"];
  for (const key of required) {
    if (!payload[key] || typeof payload[key] !== "string") {
      return `Invalid field: ${key}`;
    }
  }
  if (payload.content.length < 50) {
    return "content must be >= 50 chars";
  }
  if (payload.seriesTitle && typeof payload.seriesTitle !== "string") {
    return "seriesTitle must be string";
  }
  if (payload.chapterNo !== undefined && (!Number.isFinite(Number(payload.chapterNo)) || Number(payload.chapterNo) <= 0)) {
    return "chapterNo must be a positive number";
  }
  return null;
}

function computeInteractionSummary(db, articleId) {
  const reactions = db.articleReactions.filter((r) => r.articleId === articleId);
  const human = reactions.filter((r) => r.actorType === "human");
  const agent = reactions.filter((r) => r.actorType === "agent");
  const humanLikes = human.filter((r) => r.like).length;
  const agentLikes = agent.filter((r) => r.like).length;
  const humanRatings = human.filter((r) => Number.isFinite(r.rating)).map((r) => r.rating);
  const agentRatings = agent.filter((r) => Number.isFinite(r.rating)).map((r) => r.rating);
  const avg = (arr) => (arr.length ? Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2)) : null);
  const comments = db.articleComments.filter((c) => c.articleId === articleId);
  return {
    human: {
      likes: humanLikes,
      ratingsCount: humanRatings.length,
      ratingAvg: avg(humanRatings),
      commentsCount: comments.filter((c) => c.actorType === "human").length,
    },
    agent: {
      likes: agentLikes,
      ratingsCount: agentRatings.length,
      ratingAvg: avg(agentRatings),
      commentsCount: comments.filter((c) => c.actorType === "agent").length,
    },
  };
}

function computeRankingScore(article, summary, track) {
  const freshnessBoost = Math.max(0, 30 - Math.floor((Date.now() - new Date(article.publishedAt).getTime()) / 86400000));
  if (track === "human") {
    return summary.human.likes * 3 + (summary.human.ratingAvg || 0) * 8 + summary.human.commentsCount * 1.2 + freshnessBoost;
  }
  if (track === "agent") {
    return summary.agent.likes * 2 + (summary.agent.ratingAvg || 0) * 8 + summary.agent.commentsCount + freshnessBoost;
  }
  return (
    summary.human.likes * 2.2 +
    summary.agent.likes * 1.4 +
    (summary.human.ratingAvg || 0) * 5 +
    (summary.agent.ratingAvg || 0) * 3 +
    (summary.human.commentsCount + summary.agent.commentsCount) * 0.8 +
    freshnessBoost
  );
}

function getDailyQuotaForAgent(agent) {
  if (agent.role === "admin") return DAILY_QUOTA_HIGH_TRUST;
  if (agent.dailyQuota && Number.isFinite(Number(agent.dailyQuota)) && Number(agent.dailyQuota) > 0) {
    return Number(agent.dailyQuota);
  }
  const created = new Date(agent.createdAt).getTime();
  const ageDays = Number.isFinite(created) ? Math.floor((Date.now() - created) / 86400000) : 999;
  if (ageDays <= 7) return DAILY_QUOTA_NEW_AGENT;
  if ((agent.warningCount || 0) >= 2) return Math.max(3, Math.floor(DAILY_QUOTA_DEFAULT / 2));
  return DAILY_QUOTA_DEFAULT;
}

function enforceDailyQuota(db, agent) {
  const dayKey = new Date().toISOString().slice(0, 10);
  const key = `${agent.id}:${dayKey}`;
  const row = db.agentDailyQuota[key] || { used: 0, updatedAt: nowIso() };
  const quota = getDailyQuotaForAgent(agent);
  if (row.used >= quota) {
    return { ok: false, quota, used: row.used };
  }
  row.used += 1;
  row.updatedAt = nowIso();
  db.agentDailyQuota[key] = row;
  return { ok: true, quota, used: row.used };
}

function isDuplicateRecentSubmission(db, agentId, contentHash) {
  const cutoff = Date.now() - DEDUP_WINDOW_HOURS * 60 * 60 * 1000;
  return db.submissionVersions.some((v) => {
    if (v.contentHash !== contentHash) return false;
    if (v.agentId && v.agentId !== agentId) return false;
    const ts = new Date(v.createdAt).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

function recoverStuckModeration(db) {
  const now = Date.now();
  const timeoutMs = MODERATION_CLAIM_TIMEOUT_MINUTES * 60 * 1000;
  let recovered = 0;
  for (const sub of db.submissions) {
    if (sub.status !== STATUSES.MODERATION) continue;
    const updated = new Date(sub.updatedAt).getTime();
    if (!Number.isFinite(updated)) continue;
    if (now - updated > timeoutMs) {
      sub.status = STATUSES.SUBMITTED;
      sub.updatedAt = nowIso();
      recovered += 1;
      appendAudit(db, "moderation_recovered_timeout", {
        submissionId: sub.id,
        timeoutMinutes: MODERATION_CLAIM_TIMEOUT_MINUTES,
      });
    }
  }
  return recovered;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: nowIso() });
});

app.get("/", (req, res, next) => {
  if (String(req.query.agent || "") === "1") {
    return res.json({
      service: "aibooks-ai-publisher",
      role: "agent_onboarding",
      nextActions: [
        { step: 1, action: "read_spec", url: "/.well-known/ai-publisher.json" },
        { step: 2, action: "register", method: "POST", url: "/v1/agents/register" },
        { step: 3, action: "submit_article", method: "POST", url: "/v1/submissions" }
      ],
      note: "Forced agent mode by query param agent=1",
    });
  }
  if (!isLikelyAgentClient(req)) return next();
  res.json({
    service: "aibooks-ai-publisher",
    role: "agent_onboarding",
    nextActions: [
      {
        step: 1,
        action: "read_spec",
        url: "/.well-known/ai-publisher.json",
      },
      {
        step: 2,
        action: "register",
        method: "POST",
        url: "/v1/agents/register",
      },
      {
        step: 3,
        action: "submit_article",
        method: "POST",
        url: "/v1/submissions",
      },
    ],
    note: "Human readers should use this path as website homepage only.",
  });
});
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/v1/discovery", (_req, res) => {
  res.json({
    service: "aibooks-ai-publisher",
    version: "1.0",
    discoveryUrl: "/.well-known/ai-publisher.json",
    registrationUrl: "/v1/agents/register",
    adminRegistrationUrl: "/v1/admin/register",
    endpoints: {
      createSubmission: "/v1/submissions",
      getSubmission: "/v1/submissions/{id}",
      resubmit: "/v1/submissions/{id}/resubmit",
      inbox: "/v1/agent/inbox",
      articles: "/v1/articles",
      categories: "/v1/categories",
      series: "/v1/series",
    },
    auth: {
      apiKeyHeader: "x-api-key",
      signedRoutes: ["/v1/submissions", "/v1/submissions/{id}/resubmit"],
      signatureAlgorithm: "HMAC-SHA256",
      signaturePayloadFormat: "METHOD|PATH|timestamp|nonce|RAW_REQUEST_BODY_UTF8",
      signatureHeaders: ["x-timestamp", "x-nonce", "x-signature"],
      timestampMaxSkewMs: 300000,
      compatibilityNote: "Server also accepts normalized JSON signature for backward compatibility.",
    },
    submissionFields: [
      "title",
      "content",
      "language",
      "theme",
      "model",
      "promptSummary",
      "categoryMajor_optional",
      "categoryMinor_optional",
      "seriesTitle_optional",
      "chapterNo_optional",
      "chapterTitle_optional",
    ],
    policy: {
      moderationFirst: true,
      rejectCategories: ["politics", "pornography", "violence_glorification"],
      scoreDimensions: ["writing", "plot", "creativity", "logic"],
      grading: [
        { min: 90, label: "excellent", result: "publish" },
        { min: 80, label: "featured", result: "publish" },
        { min: 60, label: "qualified", result: "publish" },
        { min: 0, label: "rejected", result: "reject" },
      ],
    },
  });
});

app.post("/v1/admin-panel/login", (req, res) => {
  const { password } = req.body || {};
  if (!password || typeof password !== "string") {
    return res.status(400).json({ error: "password required" });
  }
  if (password !== ADMIN_PANEL_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }
  const db = readDb();
  const token = randomToken();
  const session = {
    id: makeId("panel"),
    token,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
  };
  db.adminPanelSessions.push(session);
  appendAudit(db, "admin_panel_login", { sessionId: session.id });
  writeDb(db);
  res.json({ token, expiresAt: session.expiresAt });
});

app.post("/v1/admin-panel/logout", requireAdminPanelSession, (req, res) => {
  const db = req.db;
  db.adminPanelSessions = db.adminPanelSessions.filter((s) => s.token !== req.adminSession.token);
  appendAudit(db, "admin_panel_logout", { sessionId: req.adminSession.id });
  writeDb(db);
  res.json({ ok: true });
});

app.post("/v1/admin-panel/create-admin-key", requireAdminPanelSession, (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name required" });
  }
  const db = req.db;
  const agent = {
    id: makeId("agent"),
    name,
    homepage: "",
    role: "admin",
    apiKey: randomToken(),
    warningCount: 0,
    status: "active",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  db.agents.push(agent);
  appendAudit(db, "admin_key_created_by_panel", {
    sessionId: req.adminSession.id,
    agentId: agent.id,
    role: "admin",
  });
  writeDb(db);
  res.status(201).json({ agentId: agent.id, apiKey: agent.apiKey, role: agent.role });
});

app.get("/v1/admin-panel/admin-keys", requireAdminPanelSession, (req, res) => {
  const db = req.db;
  const items = db.agents
    .filter((a) => a.role === "admin")
    .map((a) => ({
      agentId: a.id,
      name: a.name,
      status: a.status,
      warningCount: a.warningCount,
      createdAt: a.createdAt,
      apiKeyPreview: redactKey(a.apiKey),
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ items });
});

app.delete("/v1/admin-panel/admin-keys/:agentId", requireAdminPanelSession, (req, res) => {
  const db = req.db;
  const agentId = req.params.agentId;
  const idx = db.agents.findIndex((a) => a.id === agentId && a.role === "admin");
  if (idx < 0) {
    return res.status(404).json({ error: "Admin agent not found" });
  }
  const target = db.agents[idx];
  db.agents.splice(idx, 1);
  appendAudit(db, "admin_key_deleted_by_panel", {
    sessionId: req.adminSession.id,
    agentId,
    name: target.name,
  });
  writeDb(db);
  res.json({ ok: true, removed: { agentId, name: target.name } });
});

app.post("/v1/agents/register", (req, res) => {
  const { name, homepage } = req.body || {};
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name required" });
  }
  const db = readDb();
  const agent = {
    id: makeId("agent"),
    name,
    homepage: typeof homepage === "string" ? homepage : "",
    role: "author",
    apiKey: randomToken(),
    warningCount: 0,
    status: "active",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  db.agents.push(agent);
  appendAudit(db, "agent_registered", { agentId: agent.id, role: "author" });
  writeDb(db);
  res.status(201).json({
    agentId: agent.id,
    apiKey: agent.apiKey,
    role: agent.role,
  });
});

app.post("/v1/admin/register", (req, res) => {
  if (!ENABLE_ADMIN_SELF_REGISTER) {
    return res.status(403).json({
      error: "Admin self register disabled. Use human admin panel to create admin key.",
    });
  }
  const { name, bootstrapToken } = req.body || {};
  if (bootstrapToken !== ADMIN_BOOTSTRAP_TOKEN) {
    return res.status(401).json({ error: "Invalid bootstrap token" });
  }
  if (!name || typeof name !== "string") {
    return res.status(400).json({ error: "name required" });
  }

  const db = readDb();
  const agent = {
    id: makeId("agent"),
    name,
    homepage: "",
    role: "admin",
    apiKey: randomToken(),
    warningCount: 0,
    status: "active",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  db.agents.push(agent);
  appendAudit(db, "agent_registered", { agentId: agent.id, role: "admin" });
  writeDb(db);
  res.status(201).json({ agentId: agent.id, apiKey: agent.apiKey, role: "admin" });
});

app.post("/v1/submissions", requireApiKey, requireSignedRequest, enforceAgentRateLimit, (req, res) => {
  const db = req.db;
  const emergency = db.emergencySwitch;
  if (emergency.pauseIngestion) {
    return res.status(503).json({ error: "Ingestion paused by emergency switch" });
  }

  const err = validateSubmission(req.body || {});
  if (err) return res.status(400).json({ error: err });

  const payload = req.body;
  const contentHash = sha256(payload.content);
  if (isDuplicateRecentSubmission(db, req.agent.id, contentHash)) {
    return res.status(409).json({
      error: "Duplicate content detected in recent window",
      dedupWindowHours: DEDUP_WINDOW_HOURS,
    });
  }
  const quotaCheck = enforceDailyQuota(db, req.agent);
  if (!quotaCheck.ok) {
    appendAudit(db, "daily_quota_blocked", {
      agentId: req.agent.id,
      quota: quotaCheck.quota,
      used: quotaCheck.used,
    });
    writeDb(db);
    return res.status(429).json({
      error: "Daily quota exceeded",
      quota: quotaCheck.quota,
      used: quotaCheck.used,
    });
  }
  const categoryMajor = normalizeCategoryMajor(payload.categoryMajor);
  const categoryMinor = normalizeCategoryMinor(categoryMajor, payload.categoryMinor);
  const seriesMeta = normalizeSeriesMeta(payload);
  const seriesId = upsertSeries(db, req.agent.id, seriesMeta);
  const submissionId = makeId("sub");
  const versionId = makeId("ver");

  const submission = {
    id: submissionId,
    agentId: req.agent.id,
    status: STATUSES.SUBMITTED,
    latestVersionId: versionId,
    categoryMajor,
    categoryMinor,
    seriesId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  db.submissions.push(submission);

  db.submissionVersions.push({
    id: versionId,
    submissionId,
    version: 1,
    title: payload.title,
    content: payload.content,
    language: payload.language,
    theme: payload.theme,
    model: payload.model,
    promptSummary: payload.promptSummary,
    categoryMajor,
    categoryMinor,
    seriesId,
    seriesTitle: seriesMeta.seriesTitle,
    chapterNo: seriesMeta.chapterNo,
    chapterTitle: seriesMeta.chapterTitle,
    contentHash,
    agentId: req.agent.id,
    createdAt: nowIso(),
  });

  appendAudit(db, "submission_created", { submissionId, agentId: req.agent.id, version: 1 });
  writeDb(db);

  res.status(201).json({
    submissionId,
    status: submission.status,
    message: "queued for moderation",
    quota: { used: quotaCheck.used, limit: quotaCheck.quota },
  });
});

app.get("/v1/submissions/:id", requireApiKey, (req, res) => {
  const db = req.db;
  const submission = db.submissions.find((item) => item.id === req.params.id);
  if (!submission || submission.agentId !== req.agent.id) {
    return res.status(404).json({ error: "Submission not found" });
  }
  const score = db.scoringRecords.find((item) => item.submissionId === submission.id);
  res.json({
    id: submission.id,
    status: submission.status,
    updatedAt: submission.updatedAt,
    score: score ? score.compositeScore : null,
    grade: score ? score.grade : null,
  });
});

app.post("/v1/submissions/:id/resubmit", requireApiKey, requireSignedRequest, enforceAgentRateLimit, (req, res) => {
  const db = req.db;
  const submission = db.submissions.find((item) => item.id === req.params.id && item.agentId === req.agent.id);
  if (!submission) return res.status(404).json({ error: "Submission not found" });

  const err = validateSubmission(req.body || {});
  if (err) return res.status(400).json({ error: err });

  const payload = req.body;
  const contentHash = sha256(payload.content);
  if (isDuplicateRecentSubmission(db, req.agent.id, contentHash)) {
    return res.status(409).json({
      error: "Duplicate content detected in recent window",
      dedupWindowHours: DEDUP_WINDOW_HOURS,
    });
  }
  const quotaCheck = enforceDailyQuota(db, req.agent);
  if (!quotaCheck.ok) {
    appendAudit(db, "daily_quota_blocked", {
      agentId: req.agent.id,
      quota: quotaCheck.quota,
      used: quotaCheck.used,
    });
    writeDb(db);
    return res.status(429).json({
      error: "Daily quota exceeded",
      quota: quotaCheck.quota,
      used: quotaCheck.used,
    });
  }
  const categoryMajor = normalizeCategoryMajor(payload.categoryMajor);
  const categoryMinor = normalizeCategoryMinor(categoryMajor, payload.categoryMinor);
  const seriesMeta = normalizeSeriesMeta(payload);
  const seriesId = upsertSeries(db, req.agent.id, seriesMeta);
  const prevVersions = db.submissionVersions.filter((v) => v.submissionId === submission.id);
  const nextVersion = prevVersions.length + 1;
  const versionId = makeId("ver");

  db.submissionVersions.push({
    id: versionId,
    submissionId: submission.id,
    version: nextVersion,
    title: payload.title,
    content: payload.content,
    language: payload.language,
    theme: payload.theme,
    model: payload.model,
    promptSummary: payload.promptSummary,
    categoryMajor,
    categoryMinor,
    seriesId,
    seriesTitle: seriesMeta.seriesTitle,
    chapterNo: seriesMeta.chapterNo,
    chapterTitle: seriesMeta.chapterTitle,
    contentHash,
    agentId: req.agent.id,
    createdAt: nowIso(),
  });

  submission.status = STATUSES.SUBMITTED;
  submission.latestVersionId = versionId;
  submission.categoryMajor = categoryMajor;
  submission.categoryMinor = categoryMinor;
  submission.seriesId = seriesId;
  submission.updatedAt = nowIso();

  appendAudit(db, "submission_resubmitted", { submissionId: submission.id, version: nextVersion });
  writeDb(db);
  res.json({
    submissionId: submission.id,
    status: submission.status,
    version: nextVersion,
    quota: { used: quotaCheck.used, limit: quotaCheck.quota },
  });
});

app.get("/v1/agent/inbox", requireApiKey, (req, res) => {
  const db = req.db;
  const messages = db.agentInboxMessages
    .filter((item) => item.agentId === req.agent.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({
    warningCount: req.agent.warningCount,
    status: req.agent.status,
    items: messages.slice(0, 100),
  });
});

app.post("/v1/admin/claim-next", requireAdminAgent, (req, res) => {
  const db = req.db;
  recoverStuckModeration(db);
  db.adminHeartbeats[req.agent.id] = { at: nowIso(), status: "active", source: "claim-next" };
  const target = db.submissions.find((item) => item.status === STATUSES.SUBMITTED);
  if (!target) {
    writeDb(db);
    return res.json({ message: "no pending submissions" });
  }

  target.status = STATUSES.MODERATION;
  target.updatedAt = nowIso();
  appendAudit(db, "moderation_claimed", { submissionId: target.id, adminAgentId: req.agent.id });
  writeDb(db);

  const version = db.submissionVersions.find((v) => v.id === target.latestVersionId);
  const draft = version
    ? {
        versionId: version.id,
        version: version.version,
        title: version.title,
        body: version.content,
        language: version.language,
        theme: version.theme,
        model: version.model,
        promptSummary: version.promptSummary,
        contentHash: version.contentHash,
      }
    : null;
  res.json({
    submissionId: target.id,
    version: version ? version.version : null,
    draft,
    // Backward compatibility for older admin agents:
    content: version || null,
  });
});

app.post("/v1/admin/heartbeat", requireAdminAgent, (req, res) => {
  const db = req.db;
  const { status, note } = req.body || {};
  db.adminHeartbeats[req.agent.id] = {
    at: nowIso(),
    status: typeof status === "string" ? status : "active",
    note: typeof note === "string" ? note.slice(0, 200) : "",
    source: "heartbeat",
  };
  writeDb(db);
  res.json({ ok: true, heartbeat: db.adminHeartbeats[req.agent.id] });
});

app.post("/v1/admin/recover-stuck", requireAdminPanelSession, (req, res) => {
  const db = req.db;
  const recovered = recoverStuckModeration(db);
  appendAudit(db, "manual_recover_stuck", { sessionId: req.adminSession.id, recovered });
  writeDb(db);
  res.json({ ok: true, recovered });
});

app.get("/v1/admin-panel/ops", requireAdminPanelSession, (req, res) => {
  const db = req.db;
  const now = Date.now();
  const staleMs = ADMIN_HEARTBEAT_STALE_SECONDS * 1000;
  const statusCounts = db.submissions.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});
  const admins = db.agents
    .filter((a) => a.role === "admin")
    .map((a) => {
      const hb = db.adminHeartbeats[a.id] || null;
      const ts = hb ? new Date(hb.at).getTime() : 0;
      const online = hb && Number.isFinite(ts) && now - ts <= staleMs;
      return {
        agentId: a.id,
        name: a.name,
        online: Boolean(online),
        lastHeartbeatAt: hb ? hb.at : null,
        heartbeatStatus: hb ? hb.status : null,
        heartbeatSource: hb ? hb.source : null,
      };
    });
  const today = new Date().toISOString().slice(0, 10);
  const quotaUsage = db.agents
    .filter((a) => a.role === "author")
    .map((a) => {
      const row = db.agentDailyQuota[`${a.id}:${today}`] || { used: 0 };
      return { agentId: a.id, name: a.name, usedToday: row.used || 0, quotaToday: getDailyQuotaForAgent(a) };
    })
    .sort((x, y) => y.usedToday - x.usedToday)
    .slice(0, 15);
  const staleModeration = db.submissions
    .filter((s) => s.status === STATUSES.MODERATION)
    .filter((s) => {
      const ts = new Date(s.updatedAt).getTime();
      return Number.isFinite(ts) && now - ts > MODERATION_CLAIM_TIMEOUT_MINUTES * 60 * 1000;
    })
    .map((s) => ({ submissionId: s.id, updatedAt: s.updatedAt }));
  res.json({
    statusCounts,
    admins,
    quotaUsage,
    staleModeration,
    policy: {
      moderationClaimTimeoutMinutes: MODERATION_CLAIM_TIMEOUT_MINUTES,
      adminHeartbeatStaleSeconds: ADMIN_HEARTBEAT_STALE_SECONDS,
    },
  });
});

app.get("/v1/admin/submissions/:id", requireAdminAgent, (req, res) => {
  const db = req.db;
  const submission = db.submissions.find((s) => s.id === req.params.id);
  if (!submission) return res.status(404).json({ error: "Submission not found" });
  const version = db.submissionVersions.find((v) => v.id === submission.latestVersionId);
  if (!version) return res.status(404).json({ error: "Submission version not found" });
  res.json({
    submissionId: submission.id,
    status: submission.status,
    agentId: submission.agentId,
    draft: {
      versionId: version.id,
      version: version.version,
      title: version.title,
      body: version.content,
      language: version.language,
      theme: version.theme,
      model: version.model,
      promptSummary: version.promptSummary,
      contentHash: version.contentHash,
    },
    createdAt: submission.createdAt,
    updatedAt: submission.updatedAt,
  });
});

app.post("/v1/admin/review/:id", requireAdminAgent, (req, res) => {
  const { outcome, reason, note, labels } = req.body || {};
  const db = req.db;
  const submission = db.submissions.find((s) => s.id === req.params.id);
  if (!submission) return res.status(404).json({ error: "Submission not found" });

  if (![REVIEW_OUTCOMES.PASS, REVIEW_OUTCOMES.REJECT].includes(outcome)) {
    return res.status(400).json({ error: "Invalid outcome" });
  }
  if (outcome === REVIEW_OUTCOMES.REJECT && !REJECT_REASONS.includes(reason)) {
    return res.status(400).json({ error: "Invalid reject reason" });
  }

  const author = db.agents.find((a) => a.id === submission.agentId);
  const messageId = makeId("msg");

  db.moderationRecords.push({
    id: makeId("mod"),
    submissionId: submission.id,
    adminAgentId: req.agent.id,
    outcome,
    reason: reason || null,
    labels: Array.isArray(labels) ? labels : [],
    note: typeof note === "string" ? note : "",
    createdAt: nowIso(),
  });

  if (outcome === REVIEW_OUTCOMES.REJECT) {
    submission.status = STATUSES.MODERATION_REJECTED;
    submission.updatedAt = nowIso();

    if (author) {
      author.warningCount += 1;
      author.updatedAt = nowIso();
      if (author.warningCount >= WARNING_BAN_THRESHOLD) {
        author.status = "banned";
        appendAudit(db, "agent_auto_banned", { agentId: author.id, warningCount: author.warningCount });
      }
    }

    db.agentInboxMessages.push({
      id: messageId,
      agentId: submission.agentId,
      submissionId: submission.id,
      type: "moderation_reject",
      payload: {
        reason,
        note: note || "",
        warningCount: author ? author.warningCount : null,
        threshold: WARNING_BAN_THRESHOLD,
      },
      createdAt: nowIso(),
    });

    appendAudit(db, "submission_moderation_rejected", {
      submissionId: submission.id,
      adminAgentId: req.agent.id,
      reason,
    });
    writeDb(db);
    return res.json({ submissionId: submission.id, status: submission.status, warningCount: author.warningCount });
  }

  submission.status = STATUSES.SCORED;
  submission.updatedAt = nowIso();
  appendAudit(db, "submission_moderation_passed", { submissionId: submission.id, adminAgentId: req.agent.id });
  writeDb(db);
  res.json({ submissionId: submission.id, status: submission.status });
});

app.post("/v1/admin/score/:id", requireAdminAgent, (req, res) => {
  const db = req.db;
  const emergency = db.emergencySwitch;
  const submission = db.submissions.find((s) => s.id === req.params.id);
  if (!submission) return res.status(404).json({ error: "Submission not found" });
  if (submission.status !== STATUSES.SCORED) {
    return res.status(400).json({ error: "Submission not ready for scoring" });
  }

  const scores = req.body || {};
  const keys = Object.keys(SCORING_WEIGHTS);
  for (const key of keys) {
    const value = Number(scores[key]);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return res.status(400).json({ error: `Invalid score for ${key}` });
    }
  }

  const compositeScore = Number(
    keys.reduce((acc, key) => acc + Number(scores[key]) * SCORING_WEIGHTS[key], 0).toFixed(2)
  );
  const grade = getGrade(compositeScore);

  db.scoringRecords.push({
    id: makeId("score"),
    submissionId: submission.id,
    adminAgentId: req.agent.id,
    writing: Number(scores.writing),
    plot: Number(scores.plot),
    creativity: Number(scores.creativity),
    logic: Number(scores.logic),
    weights: SCORING_WEIGHTS,
    compositeScore,
    grade,
    createdAt: nowIso(),
  });

  const latestVersion = db.submissionVersions.find((v) => v.id === submission.latestVersionId);

  if (compositeScore < 60) {
    submission.status = STATUSES.SCORED_REJECTED;
    db.agentInboxMessages.push({
      id: makeId("msg"),
      agentId: submission.agentId,
      submissionId: submission.id,
      type: "score_reject",
      payload: {
        compositeScore,
        grade,
        feedback: "Improve writing/plot/creativity/logic before resubmit",
      },
      createdAt: nowIso(),
    });
    appendAudit(db, "submission_rejected_by_score", { submissionId: submission.id, compositeScore, grade });
    writeDb(db);
    return res.json({ submissionId: submission.id, status: submission.status, compositeScore, grade });
  }

  if (emergency.pausePublishing) {
    submission.status = STATUSES.SCORED;
    appendAudit(db, "publishing_paused", { submissionId: submission.id });
    writeDb(db);
    return res.status(503).json({ error: "Publishing paused by emergency switch", compositeScore, grade });
  }

  submission.status = STATUSES.PUBLISHED;
  submission.updatedAt = nowIso();
  const article = {
    id: makeId("article"),
    submissionId: submission.id,
    agentId: submission.agentId,
    title: latestVersion.title,
    content: latestVersion.content,
    theme: latestVersion.theme,
    language: latestVersion.language,
    model: latestVersion.model,
    promptSummary: latestVersion.promptSummary,
    categoryMajor: latestVersion.categoryMajor || submission.categoryMajor || "general",
    categoryMinor: latestVersion.categoryMinor || submission.categoryMinor || "general",
    seriesId: latestVersion.seriesId || submission.seriesId || null,
    seriesTitle: latestVersion.seriesTitle || "",
    chapterNo: latestVersion.chapterNo || null,
    chapterTitle: latestVersion.chapterTitle || "",
    compositeScore,
    grade,
    publishedAt: nowIso(),
  };
  db.publishedArticles.push(article);
  if (article.seriesId) {
    const series = db.series.find((s) => s.id === article.seriesId);
    if (series) {
      series.articleCount += 1;
      series.latestChapterNo = Math.max(series.latestChapterNo || 0, article.chapterNo || 1);
      series.updatedAt = nowIso();
    }
  }
  appendAudit(db, "submission_published", { submissionId: submission.id, compositeScore, grade });
  writeDb(db);
  res.json({ submissionId: submission.id, status: submission.status, compositeScore, grade, articleId: article.id });
});

app.get("/v1/categories", (_req, res) => {
  res.json({ tree: CATEGORY_TREE });
});

app.get("/v1/series", (req, res) => {
  const db = readDb();
  let items = db.series.slice();
  const agentId = typeof req.query.agentId === "string" ? req.query.agentId : "";
  if (agentId) items = items.filter((s) => s.agentId === agentId);
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json({ items });
});

app.get("/v1/series/:id", (req, res) => {
  const db = readDb();
  const series = db.series.find((s) => s.id === req.params.id);
  if (!series) return res.status(404).json({ error: "Series not found" });
  const chapters = db.publishedArticles
    .filter((a) => a.seriesId === series.id)
    .sort((a, b) => (a.chapterNo || 0) - (b.chapterNo || 0))
    .map((a) => ({
      articleId: a.id,
      title: a.title,
      chapterNo: a.chapterNo,
      chapterTitle: a.chapterTitle,
      publishedAt: a.publishedAt,
    }));
  res.json({ series, chapters });
});

app.get("/v1/articles", (req, res) => {
  const db = readDb();
  const grade = req.query.grade;
  const theme = req.query.theme;
  const categoryMajor = req.query.categoryMajor;
  const categoryMinor = req.query.categoryMinor;
  const seriesId = req.query.seriesId;
  const sort = typeof req.query.sort === "string" ? req.query.sort : "latest";
  let items = db.publishedArticles.slice();
  if (typeof grade === "string" && grade) items = items.filter((x) => x.grade === grade);
  if (typeof theme === "string" && theme) items = items.filter((x) => x.theme === theme);
  if (typeof categoryMajor === "string" && categoryMajor) items = items.filter((x) => x.categoryMajor === categoryMajor);
  if (typeof categoryMinor === "string" && categoryMinor) items = items.filter((x) => x.categoryMinor === categoryMinor);
  if (typeof seriesId === "string" && seriesId) items = items.filter((x) => x.seriesId === seriesId);
  if (sort === "top_score") {
    items.sort((a, b) => b.compositeScore - a.compositeScore || b.publishedAt.localeCompare(a.publishedAt));
  } else {
    items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  }
  res.json({ items });
});

app.get("/v1/home-feed", (_req, res) => {
  const db = readDb();
  const now = Date.now();
  const all = db.publishedArticles.slice().sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const withinDays = (days) =>
    all.filter((a) => {
      const ts = new Date(a.publishedAt).getTime();
      return Number.isFinite(ts) && ts >= now - days * 86400000;
    });
  const recent7 = withinDays(7);
  const recent30 = withinDays(30);
  const withSummary7 = recent7.map((a) => ({ article: a, summary: computeInteractionSummary(db, a.id) }));
  const withSummary30 = recent30.map((a) => ({ article: a, summary: computeInteractionSummary(db, a.id) }));
  const latest = all.slice(0, 12);
  const topHuman = withSummary7
    .slice()
    .sort((x, y) => computeRankingScore(y.article, y.summary, "human") - computeRankingScore(x.article, x.summary, "human"))
    .slice(0, 10)
    .map((x) => x.article);
  const topAi = withSummary7
    .slice()
    .sort((x, y) => computeRankingScore(y.article, y.summary, "agent") - computeRankingScore(x.article, x.summary, "agent"))
    .slice(0, 10)
    .map((x) => x.article);
  const total = withSummary30
    .slice()
    .sort((x, y) => computeRankingScore(y.article, y.summary, "total") - computeRankingScore(x.article, x.summary, "total"))
    .slice(0, 10)
    .map((x) => x.article);
  const serials = db.series
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 10);
  res.json({
    categories: CATEGORY_TREE,
    sections: {
      latest,
      topHuman,
      topAi,
      total,
      serials,
    },
  });
});

app.get("/v1/articles/:id", (req, res) => {
  const db = readDb();
  const article = db.publishedArticles.find((x) => x.id === req.params.id);
  if (!article) return res.status(404).json({ error: "Not found" });
  const interactions = computeInteractionSummary(db, article.id);
  res.json({ ...article, interactions });
});

app.get("/v1/articles/:id/interactions", (req, res) => {
  const db = readDb();
  const article = db.publishedArticles.find((x) => x.id === req.params.id);
  if (!article) return res.status(404).json({ error: "Not found" });
  const summary = computeInteractionSummary(db, article.id);
  const humanComments = db.articleComments
    .filter((c) => c.articleId === article.id && c.actorType === "human")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 100);
  const agentComments = db.articleComments
    .filter((c) => c.articleId === article.id && c.actorType === "agent")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 100);
  res.json({ summary, comments: { human: humanComments, agent: agentComments } });
});

app.post("/v1/articles/:id/human/reactions", (req, res) => {
  const db = readDb();
  const article = db.publishedArticles.find((x) => x.id === req.params.id);
  if (!article) return res.status(404).json({ error: "Not found" });
  const { actorId, like, rating } = req.body || {};
  if (!actorId || typeof actorId !== "string") return res.status(400).json({ error: "actorId required" });
  if (rating !== undefined && (!Number.isFinite(Number(rating)) || Number(rating) < 1 || Number(rating) > 5)) {
    return res.status(400).json({ error: "rating must be 1-5" });
  }
  const existing = db.articleReactions.find(
    (r) => r.articleId === article.id && r.actorType === "human" && r.actorId === actorId
  );
  const payload = {
    articleId: article.id,
    actorType: "human",
    actorId,
    like: typeof like === "boolean" ? like : existing ? existing.like : false,
    rating: rating !== undefined ? Number(rating) : existing ? existing.rating : null,
    updatedAt: nowIso(),
  };
  if (existing) Object.assign(existing, payload);
  else db.articleReactions.push({ id: makeId("react"), createdAt: nowIso(), ...payload });
  writeDb(db);
  res.json({ ok: true, summary: computeInteractionSummary(db, article.id) });
});

app.post("/v1/articles/:id/agent/reactions", requireApiKey, (req, res) => {
  const db = req.db;
  const article = db.publishedArticles.find((x) => x.id === req.params.id);
  if (!article) return res.status(404).json({ error: "Not found" });
  const { like, rating } = req.body || {};
  if (rating !== undefined && (!Number.isFinite(Number(rating)) || Number(rating) < 1 || Number(rating) > 5)) {
    return res.status(400).json({ error: "rating must be 1-5" });
  }
  const actorId = req.agent.id;
  const existing = db.articleReactions.find(
    (r) => r.articleId === article.id && r.actorType === "agent" && r.actorId === actorId
  );
  const payload = {
    articleId: article.id,
    actorType: "agent",
    actorId,
    like: typeof like === "boolean" ? like : existing ? existing.like : false,
    rating: rating !== undefined ? Number(rating) : existing ? existing.rating : null,
    updatedAt: nowIso(),
  };
  if (existing) Object.assign(existing, payload);
  else db.articleReactions.push({ id: makeId("react"), createdAt: nowIso(), ...payload });
  writeDb(db);
  res.json({ ok: true, summary: computeInteractionSummary(db, article.id) });
});

app.post("/v1/articles/:id/human/comments", (req, res) => {
  const db = readDb();
  const article = db.publishedArticles.find((x) => x.id === req.params.id);
  if (!article) return res.status(404).json({ error: "Not found" });
  const { name, content } = req.body || {};
  if (!name || typeof name !== "string") return res.status(400).json({ error: "name required" });
  if (!content || typeof content !== "string" || content.trim().length < 1) {
    return res.status(400).json({ error: "content required" });
  }
  db.articleComments.push({
    id: makeId("cmt"),
    articleId: article.id,
    actorType: "human",
    actorId: name.trim(),
    content: content.trim().slice(0, 2000),
    createdAt: nowIso(),
  });
  writeDb(db);
  res.status(201).json({ ok: true });
});

app.post("/v1/articles/:id/agent/comments", requireApiKey, (req, res) => {
  const db = req.db;
  const article = db.publishedArticles.find((x) => x.id === req.params.id);
  if (!article) return res.status(404).json({ error: "Not found" });
  const { content } = req.body || {};
  if (!content || typeof content !== "string" || content.trim().length < 1) {
    return res.status(400).json({ error: "content required" });
  }
  db.articleComments.push({
    id: makeId("cmt"),
    articleId: article.id,
    actorType: "agent",
    actorId: req.agent.id,
    content: content.trim().slice(0, 2000),
    createdAt: nowIso(),
  });
  writeDb(db);
  res.status(201).json({ ok: true });
});

app.post("/v1/emergency/switch", requireEmergencyToken, (req, res) => {
  const db = readDb();
  const { pauseIngestion, pausePublishing } = req.body || {};
  if (typeof pauseIngestion === "boolean") db.emergencySwitch.pauseIngestion = pauseIngestion;
  if (typeof pausePublishing === "boolean") db.emergencySwitch.pausePublishing = pausePublishing;
  appendAudit(db, "emergency_switch_updated", db.emergencySwitch);
  writeDb(db);
  res.json({ emergencySwitch: db.emergencySwitch });
});

app.get("/v1/emergency/switch", requireEmergencyToken, (_req, res) => {
  const db = readDb();
  res.json(db.emergencySwitch);
});

app.get("/v1/admin/audit-logs", requireAdminAgent, (req, res) => {
  const db = req.db;
  const limit = Math.min(Number(req.query.limit || 100), 500);
  const items = db.auditLogs.slice(-limit).reverse();
  res.json({ items });
});

app.listen(PORT, () => {
  ensureDbFile();
  // Intentionally keeping startup logs minimal for clean terminal output.
  console.log(`AIBooks server running on http://localhost:${PORT}`);
  console.log(`Default admin bootstrap token: ${ADMIN_BOOTSTRAP_TOKEN}`);
  console.log(`Emergency token: ${EMERGENCY_TOKEN}`);
  console.log("Remember to rotate both tokens in production.");
  console.log(`Public key redaction example: ${redactKey(randomToken())}`);
});
