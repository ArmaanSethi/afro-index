# The Afro Index 🔴

**Every team that's done what United can't.**

A meme leaderboard tracking football teams that have achieved 5+ consecutive wins since October 5, 2024 — the day Manchester United fan Frank Ilett vowed not to cut his hair until United won 5 in a row.

**Live site:** [afro-index.vercel.app](https://afro-index.vercel.app)

## The Story

On October 5, 2024, Manchester United fan **Frank Ilett** made a bold vow: he would not cut his hair until United won 5 games in a row. As of today, Frank is still waiting. His hair grows longer with each disappointing result.

Meanwhile, we've been tracking every other team in the world that has managed to achieve this seemingly impossible feat. Spoiler alert: it's a lot of teams.

## Tech Stack

- **Frontend:** Single HTML file with Tailwind CSS (via CDN)
- **Backend:** Vercel Serverless Functions
- **Database:** Supabase (PostgreSQL)
- **API:** [football-data.org](https://www.football-data.org) (free tier)

## Features

- 📊 **Live Leaderboard** - Teams sorted by longest win streak
- ⚽ **12 Competitions** - Premier League, La Liga, Bundesliga, Serie A, Ligue 1, and more
- 🔄 **Auto-updating** - Scan leagues to find new qualifying teams
- 📱 **Responsive** - Dark theme with glassmorphism design

## Setup

### 1. Database (Supabase)

1. Create a project at [supabase.com](https://supabase.com)
2. Run the SQL in `supabase-setup.sql`
3. Copy your **Project URL** and **service_role key**

### 2. API Key (football-data.org)

1. Register at [football-data.org](https://www.football-data.org)
2. Copy your API key from the dashboard

### 3. Deploy (Vercel)

1. Import this repo to [vercel.com](https://vercel.com)
2. Add environment variables:
   - `SUPABASE_URL` - Your Supabase project URL
   - `SUPABASE_SERVICE_KEY` - Your Supabase service_role key  
   - `FOOTBALL_DATA_API_KEY` - Your football-data.org API key
3. Deploy!

### 4. Populate Data

Visit `/api/scan` to scan one competition at a time. Each scan:
- Fetches all matches since Oct 5, 2024
- Analyzes each team for 5+ consecutive wins
- Saves qualifying teams to the database

Free tier allows 10 calls/minute, 12 competitions total.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/teams` | Returns all qualifying teams, sorted by max streak |
| `GET /api/scan` | Scans the next unscanned competition |
| `GET /api/scan?competition=PL` | Scans a specific competition |

## Competitions (Free Tier)

| Code | League |
|------|--------|
| PL | Premier League |
| PD | La Liga |
| BL1 | Bundesliga |
| SA | Serie A |
| FL1 | Ligue 1 |
| DED | Eredivisie |
| PPL | Primeira Liga |
| ELC | Championship |
| CL | Champions League |
| BSA | Brasileirão |

## License

MIT - Built with ❤️ and frustration for The United Strand.
