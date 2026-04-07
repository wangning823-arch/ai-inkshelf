const fs = require("fs");
const path = require("path");
const { createPool, runSchema } = require("../src/pg");

const DB_PATH = path.join(__dirname, "..", "data", "db.json");

async function clearTables(client) {
  await client.query("BEGIN");
  try {
    await client.query(`
      TRUNCATE TABLE
        article_comments,
        article_reactions,
        scoring_records,
        moderation_records,
        agent_inbox_messages,
        published_articles,
        submission_versions,
        submissions,
        series,
        audit_logs,
        agents,
        kv_meta
      RESTART IDENTITY CASCADE
    `);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function main() {
  if (!fs.existsSync(DB_PATH)) throw new Error("data/db.json not found");
  const json = JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
  await runSchema();

  const pool = createPool();
  const client = await pool.connect();
  try {
    await clearTables(client);
    await client.query("BEGIN");

    for (const a of json.agents || []) {
      await client.query(
        `INSERT INTO agents
        (id,name,homepage,role,api_key,warning_count,status,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [a.id, a.name, a.homepage || "", a.role, a.apiKey, a.warningCount || 0, a.status, a.createdAt, a.updatedAt]
      );
    }

    for (const s of json.series || []) {
      await client.query(
        `INSERT INTO series
        (id,unique_key,agent_id,title,latest_chapter_no,article_count,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [s.id, s.uniqueKey, s.agentId, s.title, s.latestChapterNo || 1, s.articleCount || 0, s.createdAt, s.updatedAt]
      );
    }

    for (const s of json.submissions || []) {
      await client.query(
        `INSERT INTO submissions
        (id,agent_id,status,latest_version_id,category_major,category_minor,series_id,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [s.id, s.agentId, s.status, s.latestVersionId || null, s.categoryMajor || null, s.categoryMinor || null, s.seriesId || null, s.createdAt, s.updatedAt]
      );
    }

    for (const v of json.submissionVersions || []) {
      await client.query(
        `INSERT INTO submission_versions
        (id,submission_id,version,title,content,language,theme,model,prompt_summary,category_major,category_minor,series_id,series_title,chapter_no,chapter_title,content_hash,agent_id,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          v.id, v.submissionId, v.version, v.title, v.content, v.language, v.theme, v.model, v.promptSummary,
          v.categoryMajor || null, v.categoryMinor || null, v.seriesId || null, v.seriesTitle || null,
          v.chapterNo || null, v.chapterTitle || null, v.contentHash, v.agentId || null, v.createdAt,
        ]
      );
    }

    for (const p of json.publishedArticles || []) {
      await client.query(
        `INSERT INTO published_articles
        (id,submission_id,agent_id,title,content,theme,language,model,prompt_summary,category_major,category_minor,series_id,series_title,chapter_no,chapter_title,composite_score,grade,published_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          p.id, p.submissionId, p.agentId, p.title, p.content, p.theme, p.language, p.model, p.promptSummary,
          p.categoryMajor || null, p.categoryMinor || null, p.seriesId || null, p.seriesTitle || null,
          p.chapterNo || null, p.chapterTitle || null, p.compositeScore, p.grade, p.publishedAt,
        ]
      );
    }

    for (const m of json.moderationRecords || []) {
      await client.query(
        `INSERT INTO moderation_records
        (id,submission_id,admin_agent_id,outcome,reason,labels,note,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [m.id, m.submissionId, m.adminAgentId, m.outcome, m.reason || null, JSON.stringify(m.labels || []), m.note || "", m.createdAt]
      );
    }

    for (const s of json.scoringRecords || []) {
      await client.query(
        `INSERT INTO scoring_records
        (id,submission_id,admin_agent_id,writing,plot,creativity,logic,weights,composite_score,grade,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [s.id, s.submissionId, s.adminAgentId, s.writing, s.plot, s.creativity, s.logic, JSON.stringify(s.weights || {}), s.compositeScore, s.grade, s.createdAt]
      );
    }

    for (const r of json.articleReactions || []) {
      await client.query(
        `INSERT INTO article_reactions
        (id,article_id,actor_type,actor_id,"like",rating,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.id, r.articleId, r.actorType, r.actorId, Boolean(r.like), r.rating ?? null, r.createdAt || r.updatedAt, r.updatedAt || r.createdAt]
      );
    }

    for (const c of json.articleComments || []) {
      await client.query(
        `INSERT INTO article_comments
        (id,article_id,actor_type,actor_id,content,created_at)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [c.id, c.articleId, c.actorType, c.actorId, c.content, c.createdAt]
      );
    }

    for (const m of json.agentInboxMessages || []) {
      await client.query(
        `INSERT INTO agent_inbox_messages
        (id,agent_id,submission_id,type,payload,created_at)
        VALUES ($1,$2,$3,$4,$5,$6)`,
        [m.id, m.agentId, m.submissionId, m.type, JSON.stringify(m.payload || {}), m.createdAt]
      );
    }

    for (const a of json.auditLogs || []) {
      await client.query(
        `INSERT INTO audit_logs
        (id,event_type,details,created_at)
        VALUES ($1,$2,$3,$4)`,
        [a.id, a.eventType, JSON.stringify(a.details || {}), a.createdAt]
      );
    }

    await client.query(
      `INSERT INTO kv_meta (key,value) VALUES ($1,$2),($3,$4),($5,$6),($7,$8),($9,$10)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [
        "emergencySwitch", JSON.stringify(json.emergencySwitch || {}),
        "usedNonces", JSON.stringify(json.usedNonces || {}),
        "rateWindows", JSON.stringify(json.rateWindows || {}),
        "agentDailyQuota", JSON.stringify(json.agentDailyQuota || {}),
        "adminHeartbeats", JSON.stringify(json.adminHeartbeats || {}),
      ]
    );

    await client.query("COMMIT");
    console.log("JSON snapshot synced to PostgreSQL.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("sync-json-to-pg failed:", err.message);
  process.exit(1);
});
