-- veille-submit database schema
-- Run this once to set up the required tables

CREATE SCHEMA IF NOT EXISTS veille;

-- Agents table (the veille-submit instance)
CREATE TABLE IF NOT EXISTS veille.agents (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Insert default agent
INSERT INTO veille.agents (id, name) VALUES (1, 'Veille Submit')
ON CONFLICT (id) DO NOTHING;

-- Feed items — the core table where submitted URLs are stored
CREATE TABLE IF NOT EXISTS veille.feed_items (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER REFERENCES veille.agents(id),
  source_id INTEGER,
  source_type TEXT,              -- youtube, article, instagram, tiktok, twitter, linkedin
  source_url TEXT,
  title TEXT,
  summary TEXT,
  content_path TEXT,
  video_path TEXT,
  extracts_path TEXT,
  relevance_score DOUBLE PRECISION,  -- 5.0 = unscored, higher = more relevant
  review_status TEXT DEFAULT 'pending',
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  image_url TEXT,
  screenshots JSONB DEFAULT '[]',
  transcript TEXT
);

-- Useful indexes
CREATE INDEX IF NOT EXISTS idx_feed_items_agent ON veille.feed_items(agent_id);
CREATE INDEX IF NOT EXISTS idx_feed_items_url ON veille.feed_items(source_url);
CREATE INDEX IF NOT EXISTS idx_feed_items_created ON veille.feed_items(created_at DESC);
