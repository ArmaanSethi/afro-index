# Supabase Setup SQL

Run this in your Supabase SQL Editor:

```sql
-- Create teams table
CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id INT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  logo TEXT,
  country_name TEXT,
  country_flag TEXT,
  league_id INT,
  league_name TEXT,
  form TEXT,
  first_detected TIMESTAMPTZ DEFAULT NOW(),
  last_checked TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;

-- Allow public read access
CREATE POLICY "Public read" ON teams FOR SELECT USING (true);

-- Allow service role to insert
CREATE POLICY "Service insert" ON teams FOR INSERT WITH CHECK (true);

-- Allow service role to update
CREATE POLICY "Service update" ON teams FOR UPDATE USING (true);
```
