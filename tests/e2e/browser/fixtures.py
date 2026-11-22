"""Reusable API payload fixtures for browser E2E tests (conforms to PROJECT.md contracts)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any


def _recent_iso(minutes_ago: int = 5) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def normal_teams_payload(base_url: str = "") -> dict[str, Any]:
    """5 qualifying teams across 4 leagues (includes diacritics & varied dates/streaks)."""
    crest = lambda tid: f"{base_url}/mock-crest/{tid}.png" if base_url else "/united-crest.png"
    teams = [
        {
            "team_id": 57,
            "name": "Arsenal FC",
            "logo": crest(57),
            "country_name": "England",
            "country_flag": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
            "league_id": "PL",
            "league_name": "Premier League",
            "form": "WWWWW",
            "has_5_wins": True,
            "max_streak": 7,
            "streak_achieved_date": "2025-01-15",
            "first_detected": "2025-01-15T18:00:00Z",
            "last_checked": _recent_iso(5),
        },
        {
            "team_id": 64,
            "name": "Liverpool FC",
            "logo": crest(64),
            "country_name": "England",
            "country_flag": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
            "league_id": "PL",
            "league_name": "Premier League",
            "form": "WWWWW",
            "has_5_wins": True,
            "max_streak": 6,
            "streak_achieved_date": "2024-12-01",
            "first_detected": "2024-12-01T18:00:00Z",
            "last_checked": _recent_iso(5),
        },
        {
            "team_id": 78,
            "name": "Atlético de Madrid",
            "logo": crest(78),
            "country_name": "Spain",
            "country_flag": "🇪🇸",
            "league_id": "PD",
            "league_name": "La Liga",
            "form": "WWWWL",
            "has_5_wins": True,
            "max_streak": 5,
            "streak_achieved_date": "2025-02-10",
            "first_detected": "2025-02-10T20:00:00Z",
            "last_checked": _recent_iso(8),
        },
        {
            "team_id": 5,
            "name": "FC Bayern München",
            "logo": crest(5),
            "country_name": "Germany",
            "country_flag": "🇩🇪",
            "league_id": "BL1",
            "league_name": "Bundesliga",
            "form": "WWWWW",
            "has_5_wins": True,
            "max_streak": 8,
            "streak_achieved_date": "2024-11-20",
            "first_detected": "2024-11-20T19:00:00Z",
            "last_checked": _recent_iso(10),
        },
        {
            "team_id": 108,
            "name": "FC Internazionale Milano",
            "logo": crest(108),
            "country_name": "Italy",
            "country_flag": "🇮🇹",
            "league_id": "SA",
            "league_name": "Serie A",
            "form": "WWWDW",
            "has_5_wins": True,
            "max_streak": 5,
            "streak_achieved_date": "2025-01-02",
            "first_detected": "2025-01-02T20:00:00Z",
            "last_checked": _recent_iso(12),
        },
    ]
    return {
        "success": True,
        "winnersCount": len(teams),
        "totalScanned": 96,
        "leaguesScanned": 12,
        "teams": teams,
        "recentScans": [
            {"league_id": "PL", "league_name": "Premier League", "teams_scanned": 20, "teams_qualified": 2, "scanned_at": _recent_iso(4)},
            {"league_id": "PD", "league_name": "La Liga", "teams_scanned": 20, "teams_qualified": 1, "scanned_at": _recent_iso(7)},
            {"league_id": "BL1", "league_name": "Bundesliga", "teams_scanned": 18, "teams_qualified": 1, "scanned_at": _recent_iso(10)},
            {"league_id": "SA", "league_name": "Serie A", "teams_scanned": 20, "teams_qualified": 1, "scanned_at": _recent_iso(15)},
        ],
    }


def normal_united_payload(
    base_url: str = "",
    has_won_5: bool = False,
    best_streak: int = 3,
    current_streak: int = 2,
    form: str = "WWLDW",
    last_updated: str | None = None,
) -> dict[str, Any]:
    crest = lambda tid: f"{base_url}/mock-crest/{tid}.png" if base_url else "/united-crest.png"
    matches = [
        {"opponent": "Arsenal", "opponentId": 57, "opponentTla": "ARS", "opponentCrest": crest(57), "score": "2-1", "home": True, "date": "2025-01-10"},
        {"opponent": "Chelsea", "opponentId": 61, "opponentTla": "CHE", "opponentCrest": crest(61), "score": "3-0", "home": False, "date": "2025-01-17"},
        {"opponent": "Fulham", "opponentId": 63, "opponentTla": "FUL", "opponentCrest": crest(63), "score": "1-0", "home": True, "date": "2025-01-24"},
    ][:best_streak]

    return {
        "scope": "all_competitions",
        "hasWon5": has_won_5,
        "achievementDate": None,
        "currentStreak": current_streak,
        "bestStreak": best_streak,
        "bestStreakDetails": {
            "length": best_streak,
            "startDate": "2025-01-10",
            "endDate": "2025-01-24",
            "matches": matches,
        }
        if best_streak > 0
        else None,
        "form": form,
        "recentMatches": matches,
        "lastUpdated": last_updated if last_updated is not None else _recent_iso(2),
    }


def united_victory_payload(
    base_url: str = "",
    achievement_date: str = "2025-03-15T16:30:00Z",
) -> dict[str, Any]:
    crest = lambda tid: f"{base_url}/mock-crest/{tid}.png" if base_url else "/united-crest.png"
    matches = [
        {"opponent": "Arsenal", "opponentId": 57, "opponentTla": "ARS", "opponentCrest": crest(57), "score": "2-1", "home": True, "date": "2025-03-01"},
        {"opponent": "Chelsea", "opponentId": 61, "opponentTla": "CHE", "opponentCrest": crest(61), "score": "3-0", "home": False, "date": "2025-03-04"},
        {"opponent": "Fulham", "opponentId": 63, "opponentTla": "FUL", "opponentCrest": crest(63), "score": "1-0", "home": True, "date": "2025-03-08"},
        {"opponent": "Everton", "opponentId": 62, "opponentTla": "EVE", "opponentCrest": crest(62), "score": "2-0", "home": False, "date": "2025-03-11"},
        {"opponent": "Liverpool", "opponentId": 64, "opponentTla": "LIV", "opponentCrest": crest(64), "score": "3-1", "home": True, "date": "2025-03-15"},
    ]
    return {
        "scope": "all_competitions",
        "hasWon5": True,
        "achievementDate": achievement_date,
        "currentStreak": 5,
        "bestStreak": 5,
        "bestStreakDetails": {
            "length": 5,
            "startDate": "2025-03-01",
            "endDate": "2025-03-15",
            "matches": matches,
        },
        "form": "WWWWW",
        "recentMatches": matches,
        "lastUpdated": _recent_iso(1),
    }


def teams_with_united_winner_payload(base_url: str = "") -> dict[str, Any]:
    payload = normal_teams_payload(base_url)
    payload["teams"].append(
        {
            "team_id": 66,
            "name": "Manchester United FC",
            "logo": "/united-crest.png",
            "country_name": "England",
            "country_flag": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
            "league_id": "PL",
            "league_name": "Premier League",
            "form": "WWWWW",
            "has_5_wins": True,
            "max_streak": 5,
            "streak_achieved_date": "2025-03-15",
            "first_detected": "2025-03-15T16:30:00Z",
            "last_checked": _recent_iso(1),
        }
    )
    payload["winnersCount"] = len(payload["teams"])
    return payload


def xss_teams_payload() -> dict[str, Any]:
    return {
        "success": True,
        "winnersCount": 1,
        "totalScanned": 10,
        "leaguesScanned": 1,
        "teams": [
            {
                "team_id": 999,
                "name": '<img src=x onerror="window.__xss=1">Evil FC',
                "logo": "javascript:window.__xss=4",
                "country_name": '"><svg onload="window.__xss=3">Spain',
                "country_flag": "javascript:alert(1)",
                "league_id": "PL",
                "league_name": "<script>window.__xss=2</script>Liga",
                "form": "WWWWW",
                "has_5_wins": True,
                "max_streak": 5,
                "streak_achieved_date": "2025-01-15",
                "first_detected": "2025-01-15T18:00:00Z",
                "last_checked": _recent_iso(3),
            }
        ],
        "recentScans": [
            {
                "league_id": "PL",
                "league_name": '<img src=x onerror="window.__xss=5">Premier',
                "teams_scanned": 20,
                "teams_qualified": 1,
                "scanned_at": _recent_iso(3),
            }
        ],
    }


def xss_united_payload() -> dict[str, Any]:
    return {
        "scope": "all_competitions",
        "hasWon5": False,
        "achievementDate": None,
        "currentStreak": 1,
        "bestStreak": 1,
        "bestStreakDetails": {
            "length": 1,
            "startDate": "2025-01-10",
            "endDate": "2025-01-10",
            "matches": [
                {
                    "opponent": 'Arsenal" onmouseover="window.__xss=6',
                    "opponentId": 57,
                    "opponentTla": "ARS'\"><img src=x onerror=\"window.__xss=7\">",
                    "opponentCrest": "javascript:window.__xss=8",
                    "score": '<svg onload="window.__xss=9">2-0',
                    "home": True,
                    "date": "2025-01-10",
                }
            ],
        },
        "form": 'W<img src=x onerror="window.__xss=10">',
        "recentMatches": [],
        "lastUpdated": _recent_iso(2),
    }


def empty_teams_payload(leagues_scanned: int = 0) -> dict[str, Any]:
    return {
        "success": True,
        "winnersCount": 0,
        "totalScanned": 0,
        "leaguesScanned": leagues_scanned,
        "teams": [],
        "recentScans": [],
    }


def invalid_dates_payload(null_variant: bool = False) -> tuple[dict[str, Any], dict[str, Any]]:
    bad = None if null_variant else "not-a-date"
    teams = {
        "success": True,
        "winnersCount": 1,
        "totalScanned": 10,
        "leaguesScanned": 1,
        "teams": [
            {
                "team_id": 57,
                "name": "Arsenal FC",
                "logo": "/united-crest.png",
                "country_name": "England",
                "country_flag": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
                "league_id": "PL",
                "league_name": "Premier League",
                "form": "WWWWW",
                "has_5_wins": True,
                "max_streak": 5,
                "streak_achieved_date": bad,
                "first_detected": bad,
                "last_checked": bad,
            }
        ],
        "recentScans": [
            {
                "league_id": "PL",
                "league_name": "Premier League",
                "teams_scanned": 20,
                "teams_qualified": 1,
                "scanned_at": bad,
            }
        ],
    }
    united = {
        "scope": "all_competitions",
        "hasWon5": False,
        "achievementDate": None,
        "currentStreak": 2,
        "bestStreak": 2,
        "bestStreakDetails": None,
        "form": "WW",
        "recentMatches": [],
        "lastUpdated": bad,
    }
    return teams, united
