# The Afro Index 🔴

> **Tracking every team that achieved 5+ consecutive wins since Frank Ilett's hair vow on October 5, 2024.**

A meme leaderboard documenting all the teams doing what Manchester United can't.

## 🎯 The Story

On **October 5, 2024**, Manchester United fan **Frank Ilett** made a bold vow: he wouldn't cut his hair until United won 5 games in a row.

He's still waiting.

This site tracks every other team in the world that has achieved this feat while Frank waits.

---

## 🚀 Live Site

**[afro-index.vercel.app](https://afro-index.vercel.app)** *(after deployment)*

---

## ⚡ How It Works

1. **Fixtures API** - Fetches all match results since Oct 5, 2024 for each league
2. **Streak Detection** - Analyzes each team's match history for any 5+ consecutive wins
3. **Historical Tracking** - If a team had WWWWW at ANY point, they qualify
4. **Priority Queue** - Scans top leagues first (Premier League, La Liga, etc.)

**API Economics:**
- 1 API call = 1 league = ~20 teams = full history since Oct 5
- Free tier = 100 calls/day = can scan all major leagues daily

---

## 🛠️ Setup

### 1. Supabase Database

1. Create account at [supabase.com](https://supabase.com)
2. Create new project
3. Go to **SQL Editor** and run the contents of `supabase-setup.sql`
4. Get credentials from **Settings > API**:
   - `Project URL` → `SUPABASE_URL`
   - `service_role` secret → `SUPABASE_SERVICE_KEY`

### 2. API-Football

1. Sign up at [api-sports.io](https://api-sports.io)
2. Subscribe to API-Football (free tier: 100 req/day)
3. Copy your API key → `API_FOOTBALL_KEY`

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
├── index.html          # Frontend: hero, leaderboard, about section
├── api/
│   ├── scan.js         # Scan league fixtures, detect 5-win streaks
│   └── teams.js        # Fetch qualifying teams from database
├── supabase-setup.sql  # Database schema
├── package.json
├── vercel.json
└── README.md
```

---

## 🗄️ Database Schema

**teams** - All scanned teams
| Column | Description |
|--------|-------------|
| `team_id` | API-Football team ID |
| `name` | Team name |
| `form` | Full result sequence since Oct 5 (e.g., "WWLWWWWWDL") |
| `has_5_wins` | True if achieved 5+ consecutive wins at ANY point |
| `max_streak` | Longest win streak achieved |

**scan_log** - Tracking scan history
| Column | Description |
|--------|-------------|
| `league_id` | League scanned |
| `teams_scanned` | Number of teams in league |
| `teams_qualified` | Teams with 5+ win streak |

---

## 🎮 Usage

- Click **"Scan Random League"** to analyze a league's fixtures
- Priority leagues (PL, La Liga, etc.) are scanned first
- Teams with 5+ consecutive wins appear on the leaderboard
- Check Supabase dashboard for full scan history

---

## 🏆 Leagues Tracked

Premier League, La Liga, Bundesliga, Serie A, Ligue 1, Eredivisie, Primeira Liga, Belgian Pro League, Turkish Süper Lig, Greek Super League, Brasileirão, MLS, Saudi Pro League

---

## � Cost

**$0** - All free tiers:
- Vercel: 100GB bandwidth
- Supabase: 500MB database
- API-Football: 100 requests/day

---

Made with ❤️ and frustration for **The United Strand** 🔴
