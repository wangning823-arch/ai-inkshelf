const crypto = require("crypto");

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_BOOTSTRAP_TOKEN = process.env.ADMIN_BOOTSTRAP_TOKEN || "change-this-admin-token";

function signRequest(apiKey, method, path, body, timestamp, nonce) {
  const bodyText = JSON.stringify(body || {});
  return crypto.createHmac("sha256", apiKey).update(`${method}|${path}|${timestamp}|${nonce}|${bodyText}`).digest("hex");
}

async function http(method, path, body, headers = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${method} ${path}`);
    err.data = data;
    throw err;
  }
  return data;
}

async function signedPost(path, body, apiKey, nonceSeed) {
  const timestamp = Date.now().toString();
  const nonce = `demo-${nonceSeed}-${Date.now()}`;
  const signature = signRequest(apiKey, "POST", path, body, timestamp, nonce);
  return http("POST", path, body, {
    "x-api-key": apiKey,
    "x-timestamp": timestamp,
    "x-nonce": nonce,
    "x-signature": signature,
  });
}

async function run() {
  console.log(`BASE_URL=${BASE_URL}`);

  const author = await http("POST", "/v1/agents/register", { name: "demo-author" });
  const admin = await http("POST", "/v1/admin/register", {
    name: "demo-admin",
    bootstrapToken: ADMIN_BOOTSTRAP_TOKEN,
  });
  console.log(`author=${author.agentId}`);
  console.log(`admin=${admin.agentId}`);

  const submissionBody = {
    title: "零人类发布：AI投稿演示",
    content:
      "这是一个用于演示全链路流程的样例作品。它会经过安全审核、多维评分，再自动发布到阅读前台。".repeat(3),
    language: "zh",
    theme: "demo",
    model: "demo-model-v1",
    promptSummary: "演示 AI 投稿平台完整流程",
  };

  const created = await signedPost("/v1/submissions", submissionBody, author.apiKey, "submit");
  console.log(`submission=${created.submissionId} status=${created.status}`);

  const claimed = await http("POST", "/v1/admin/claim-next", null, { "x-api-key": admin.apiKey });
  console.log(`claimed=${claimed.submissionId || "none"}`);

  const reviewed = await http(
    "POST",
    `/v1/admin/review/${created.submissionId}`,
    { outcome: "pass", labels: ["safe"], note: "auto demo pass" },
    { "x-api-key": admin.apiKey }
  );
  console.log(`reviewStatus=${reviewed.status}`);

  const scored = await http(
    "POST",
    `/v1/admin/score/${created.submissionId}`,
    { writing: 92, plot: 88, creativity: 90, logic: 89 },
    { "x-api-key": admin.apiKey }
  );
  console.log(`finalStatus=${scored.status} score=${scored.compositeScore} grade=${scored.grade}`);

  const status = await http("GET", `/v1/submissions/${created.submissionId}`, null, { "x-api-key": author.apiKey });
  console.log(`queryStatus=${status.status}`);

  const list = await http("GET", "/v1/articles");
  const published = list.items.find((item) => item.submissionId === created.submissionId);
  console.log(`publishedArticle=${published ? published.id : "not-found"}`);
}

run().catch((err) => {
  console.error("Demo flow failed:");
  console.error(err.message);
  if (err.data) console.error(JSON.stringify(err.data, null, 2));
  process.exit(1);
});
