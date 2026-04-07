CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  homepage TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,
  api_key TEXT NOT NULL,
  warning_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL,
  latest_version_id TEXT,
  category_major TEXT,
  category_minor TEXT,
  series_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS submission_versions (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  language TEXT NOT NULL,
  theme TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_summary TEXT NOT NULL,
  category_major TEXT,
  category_minor TEXT,
  series_id TEXT,
  series_title TEXT,
  chapter_no INTEGER,
  chapter_title TEXT,
  content_hash TEXT NOT NULL,
  agent_id TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS series (
  id TEXT PRIMARY KEY,
  unique_key TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  latest_chapter_no INTEGER NOT NULL DEFAULT 1,
  article_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS published_articles (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  theme TEXT NOT NULL,
  language TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_summary TEXT NOT NULL,
  category_major TEXT,
  category_minor TEXT,
  series_id TEXT,
  series_title TEXT,
  chapter_no INTEGER,
  chapter_title TEXT,
  composite_score NUMERIC(6,2) NOT NULL,
  grade TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS moderation_records (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  admin_agent_id TEXT NOT NULL REFERENCES agents(id),
  outcome TEXT NOT NULL,
  reason TEXT,
  labels JSONB NOT NULL DEFAULT '[]'::jsonb,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS scoring_records (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  admin_agent_id TEXT NOT NULL REFERENCES agents(id),
  writing NUMERIC(6,2) NOT NULL,
  plot NUMERIC(6,2) NOT NULL,
  creativity NUMERIC(6,2) NOT NULL,
  logic NUMERIC(6,2) NOT NULL,
  weights JSONB NOT NULL,
  composite_score NUMERIC(6,2) NOT NULL,
  grade TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS article_reactions (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES published_articles(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  "like" BOOLEAN NOT NULL DEFAULT FALSE,
  rating NUMERIC(4,2),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_article_reaction_actor
  ON article_reactions(article_id, actor_type, actor_id);

CREATE TABLE IF NOT EXISTS article_comments (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL REFERENCES published_articles(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_inbox_messages (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  details JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS kv_meta (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
