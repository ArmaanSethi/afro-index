# The Afro Index 🔴

> Tracking every team that achieved 5+ consecutive wins since Frank Ilett's hair vow on October 5, 2024.

A meme leaderboard showing all the teams doing what Manchester United can't.

## 🚀 Live Site

**[afro-index.vercel.app](https://afro-index.vercel.app)** *(after deployment)*

---

## 🛠️ Setup

### 1. Supabase Database

1. Create account at [supabase.com](https://supabase.com)
2. Create new project
3. Go to **SQL Editor** and run:

```sql
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

-- Enable public read access
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON teams FOR SELECT USING (true);
CREATE POLICY "Service insert" ON teams FOR INSERT WITH CHECK (true);
CREATE POLICY "Service update" ON teams FOR UPDATE USING (true);
```

4. Get your credentials from **Settings > API**:
   - `Project URL` → `SUPABASE_URL`
   - `service_role` secret → `SUPABASE_SERVICE_KEY`

### 2. API-Football

1. Sign up at [api-sports.io](https://api-sports.io)
2. Subscribe to API-Football (free tier: 100 req/day)
3. Copy your API key from dashboard → `API_FOOTBALL_KEY`

### 3. Vercel Deployment

1. Push this repo to GitHub
2. Connect to [Vercel](https://vercel.com)
3. Add environment variables:

| Variable | Value |
|----------|-------|
| `API_FOOTBALL_KEY` | Your API-Football key |
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Your Supabase service role key |

4. Deploy!

### 4. Whitelist Domain

After deployment, go to [API-Sports Dashboard](https://dashboard.api-football.com):
- **My Access > Authorized Domains**
- Add your `*.vercel.app` domain

---

## 📁 Project Structure

```
afro-index/
├── index.html          # Main site
├── api/
│   ├── scan.js         # Scan random league for 5-win streaks
│   └── teams.js        # Fetch all teams from database
├── package.json
├── vercel.json
└── README.md
```

---

## 🎮 Usage

- Click **"Scan Random League"** to check a random top league for teams with 5+ consecutive wins
- Teams are automatically saved to the database
- Free tier allows ~100 scans per day

### Leagues Tracked

Premier League, La Liga, Bundesliga, Serie A, Ligue 1, Eredivisie, Primeira Liga, Belgian Pro League, Turkish Süper Lig, Greek Super League, Brasileirão, MLS, Saudi Pro League

---

## 📜 The Story

On **October 5, 2024**, Manchester United fan **Frank Ilett** vowed not to cut his hair until United won 5 games in a row.

He's still waiting.

---

Made with ❤️ and frustration for The United Strand.
