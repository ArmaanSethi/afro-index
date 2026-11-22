-- Supabase Setup SQL for The Afro Index
-- Run this in the Supabase SQL Editor (safe for both fresh installs and existing databases).

-- Create teams table (tracks ALL teams scanned, not just winners)
CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id INT NOT NULL,
  sport TEXT NOT NULL DEFAULT 'football',
  name TEXT NOT NULL,
  logo TEXT,
  country_name TEXT,
  country_flag TEXT,
  league_id TEXT NOT NULL,
  league_name TEXT,
  form TEXT,
  has_5_wins BOOLEAN DEFAULT FALSE,
  max_streak INT DEFAULT 0,
  streak_achieved_date DATE,
  first_detected TIMESTAMPTZ DEFAULT NOW(),
  last_checked TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(team_id, league_id, sport) -- Teams can appear in multiple competitions
);

-- Idempotent migration for existing databases created before streak_achieved_date was added
ALTER TABLE teams ADD COLUMN IF NOT EXISTS streak_achieved_date DATE;

-- Create scan_log to track which leagues have been scanned
CREATE TABLE IF NOT EXISTS scan_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sport TEXT NOT NULL DEFAULT 'football',
  league_id TEXT NOT NULL,
  league_name TEXT,
  teams_scanned INT DEFAULT 0,
  teams_qualified INT DEFAULT 0,
  scanned_at TIMESTAMPTZ DEFAULT NOW()
);

-- Helpful indexes for leaderboard and latest-scan-per-league queries
CREATE INDEX IF NOT EXISTS idx_teams_has_5_wins_date
  ON teams (has_5_wins, streak_achieved_date ASC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_scan_log_league_scanned
  ON scan_log (league_id, scanned_at DESC);

-- Enable Row Level Security
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_log ENABLE ROW LEVEL SECURITY;

-- Drop existing policies before recreating (idempotent)
DROP POLICY IF EXISTS "Public read teams" ON teams;
DROP POLICY IF EXISTS "Public read scan_log" ON scan_log;
DROP POLICY IF EXISTS "Service insert teams" ON teams;
DROP POLICY IF EXISTS "Service update teams" ON teams;
DROP POLICY IF EXISTS "Service insert scan_log" ON scan_log;

-- Allow public read access
CREATE POLICY "Public read teams" ON teams
  FOR SELECT USING (true);
CREATE POLICY "Public read scan_log" ON scan_log
  FOR SELECT USING (true);

-- Restrict write access to service_role only
CREATE POLICY "Service insert teams" ON teams
  FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "Service update teams" ON teams
  FOR UPDATE TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service insert scan_log" ON scan_log
  FOR INSERT TO service_role WITH CHECK (true);
