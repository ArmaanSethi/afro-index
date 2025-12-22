# Supabase Setup SQL

Run this in your Supabase SQL Editor:

```sql
-- Drop existing tables if re-running
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS scan_log;

-- Create teams table (tracks ALL teams scanned, not just winners)
CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id INT NOT NULL,
  sport TEXT DEFAULT 'football',
  name TEXT NOT NULL,
  logo TEXT,
  country_name TEXT,
  country_flag TEXT,
  league_id TEXT,
  league_name TEXT,
  form TEXT,
  has_5_wins BOOLEAN DEFAULT FALSE,
  max_streak INT DEFAULT 0,
  first_detected TIMESTAMPTZ DEFAULT NOW(),
  last_checked TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(team_id, league_id, sport)  -- Teams can appear in multiple competitions
);

-- Create scan_log to track which leagues we've scanned
CREATE TABLE scan_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sport TEXT DEFAULT 'football',
  league_id TEXT NOT NULL,
  league_name TEXT,
  teams_scanned INT DEFAULT 0,
  teams_qualified INT DEFAULT 0,
  scanned_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_log ENABLE ROW LEVEL SECURITY;

-- Allow public read access
CREATE POLICY "Public read teams" ON teams FOR SELECT USING (true);
CREATE POLICY "Public read scan_log" ON scan_log FOR SELECT USING (true);

-- Allow service role to write
CREATE POLICY "Service insert teams" ON teams FOR INSERT WITH CHECK (true);
CREATE POLICY "Service update teams" ON teams FOR UPDATE USING (true);
CREATE POLICY "Service insert scan_log" ON scan_log FOR INSERT WITH CHECK (true);
```

## To update existing table's unique constraint:

```sql
-- Drop old constraint and add new one
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_team_id_sport_key;
ALTER TABLE teams ADD CONSTRAINT teams_team_id_league_id_sport_key UNIQUE (team_id, league_id, sport);
```
