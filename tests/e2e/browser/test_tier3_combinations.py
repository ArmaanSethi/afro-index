"""Tier 3 Browser E2E tests — Cross-Feature Combinations & Celebration SEO Integrity."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from urllib.parse import unquote

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.sync_api import sync_playwright

from fixtures import (
    normal_teams_payload,
    normal_united_payload,
    teams_with_united_winner_payload,
    united_victory_payload,
)
from server import LocalE2EServer, install_offline_routes, launch_browser


class Tier3BrowserCombinationsTest(unittest.TestCase):
    server: LocalE2EServer
    pw: object
    browser: object

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = LocalE2EServer().start()
        cls.pw = sync_playwright().start()
        cls.browser = launch_browser(cls.pw)

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            if getattr(cls, "browser", None):
                cls.browser.close()
        finally:
            try:
                if getattr(cls, "pw", None):
                    cls.pw.stop()
            finally:
                if getattr(cls, "server", None):
                    cls.server.stop()

    def setUp(self) -> None:
        self.server.reset()
        self.server.set_api_response("/api/teams", normal_teams_payload(self.server.base_url))
        self.server.set_api_response("/api/united", normal_united_payload(self.server.base_url))

    def _new_page(self, **context_kwargs):
        ctx = self.browser.new_context(**context_kwargs)
        install_offline_routes(ctx, self.server.base_url)
        page = ctx.new_page()
        page_errors: list[str] = []
        page.on("pageerror", lambda err: page_errors.append(str(err)))
        return ctx, page, page_errors

    def test_search_multifilter_sort_preserved_across_background_refresh(self) -> None:
        ctx, page, page_errors = self._new_page()
        try:
            page.clock.install()
            page.goto(self.server.base_url + "/", wait_until="domcontentloaded")
            page.clock.run_for(500)
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 5")

            # Apply multi-league filter: PL + BL1 + search "a" + non-default sort
            page.locator('.filter-btn[data-league="PL"]').click()
            page.locator('.filter-btn[data-league="BL1"]').click()
            page.locator("#search-input").fill("a")

            sort_select = page.locator("#sort-select, #leaderboard select").first
            options = sort_select.locator("option").evaluate_all("els => els.map(e => e.value)")
            chosen_sort = options[1] if len(options) > 1 else options[0]
            sort_select.select_option(chosen_sort)

            # Update backend: add Aston Villa (PL, matches "a"), remove SA league
            updated = normal_teams_payload(self.server.base_url)
            updated["teams"] = [t for t in updated["teams"] if t["league_id"] != "SA"]
            updated["teams"].append(
                {
                    "team_id": 58,
                    "name": "Aston Villa FC",
                    "logo": f"{self.server.base_url}/mock-crest/58.png",
                    "country_name": "England",
                    "country_flag": "🏴󠁧󠁢󠁥󠁮󠁧󠁿",
                    "league_id": "PL",
                    "league_name": "Premier League",
                    "form": "WWWWW",
                    "has_5_wins": True,
                    "max_streak": 6,
                    "streak_achieved_date": "2025-02-20",
                    "first_detected": "2025-02-20T18:00:00Z",
                    "last_checked": "2025-03-15T12:00:00Z",
                }
            )
            updated["winnersCount"] = len(updated["teams"])  # 5 teams total
            self.server.set_api_response("/api/teams", updated)

            # Clear request log before triggering 3-minute refresh cycle
            self.server.clear_requests()

            # Track whether #loading-state ever flashes visible during silent refresh
            page.evaluate(
                """() => {
                    window.__loadingFlashed = false;
                    const el = document.getElementById('loading-state');
                    const obs = new MutationObserver(() => {
                        if (el && !el.classList.contains('hidden')) window.__loadingFlashed = true;
                    });
                    if (el) obs.observe(el, { attributes: true, attributeFilter: ['class'] });
                }"""
            )

            # Fast-forward 3m05s
            page.clock.run_for(185_000)
            page.wait_for_function("document.getElementById('teams-grid').innerText.includes('Aston Villa')")

            self.assertFalse(page.evaluate("() => window.__loadingFlashed"), "Silent refresh must NOT flash #loading-state")
            self.assertEqual(page.locator("#team-count").inner_text().strip(), "5", "Hero #team-count must reflect backend total")
            self.assertEqual(page.locator("#search-input").input_value(), "a", "Search input must be preserved")
            self.assertEqual(sort_select.input_value(), chosen_sort, "Sort selection must be preserved")
            self.assertEqual(page.locator('.filter-btn[data-league="PL"]').get_attribute("aria-pressed"), "true")
            self.assertEqual(page.locator('.filter-btn[data-league="BL1"]').get_attribute("aria-pressed"), "true")
            self.assertIn("Aston Villa FC", page.locator("#teams-grid").inner_text())

            scan_calls = self.server.count_requests("/api/scan")
            self.assertLessEqual(scan_calls, 1, f"3m refresh must not double-fire /api/scan (got {scan_calls})")
            self.assertEqual(page_errors, [])
        finally:
            ctx.close()

    def test_swr_cached_5win_plus_live_5win_single_celebration_no_reload_loop(self) -> None:
        victory = united_victory_payload(self.server.base_url)
        self.server.set_api_response("/api/teams", teams_with_united_winner_payload(self.server.base_url))
        # Delay live /api/united by 150ms so SWR cache renders first and live fetch resolves mid-delay
        self.server.set_api_response("/api/united", victory, delay_ms=150)

        ctx, page, page_errors = self._new_page()
        navigations = 0

        def _on_nav(_frame):
            nonlocal navigations
            if _frame == page.main_frame:
                navigations += 1

        page.on("framenavigated", _on_nav)

        try:
            page.add_init_script(
                f"localStorage.setItem('united_data_cache', {json.dumps(json.dumps(victory))});"
            )
            page.goto(self.server.base_url + "/", wait_until="networkidle")
            page.locator("#celebration-overlay").wait_for(state="visible", timeout=5000)
            page.wait_for_timeout(1200)

            self.assertEqual(
                page.locator("#celebration-overlay").count(),
                1,
                "SWR cache + live 5-win race must spawn strictly ONE #celebration-overlay",
            )
            self.assertLessEqual(page.locator("#confetti-canvas").count(), 1)
            self.assertTrue(
                page.locator("#leaderboard").count() == 1,
                "Man United in /api/teams must NOT wipe document.body.innerHTML",
            )

            # Dismiss overlay and verify NO reload loop
            navs_before_dismiss = navigations
            page.keyboard.press("Escape")
            page.wait_for_function("!document.getElementById('celebration-overlay')", timeout=3000)
            page.wait_for_timeout(400)
            self.assertEqual(navigations, navs_before_dismiss, "Dismissing overlay must NOT trigger location.reload()")
            self.assertTrue(page.locator("#leaderboard").is_visible())
            self.assertEqual(page_errors, [])
        finally:
            ctx.close()

    def test_tab_switching_hides_controls_and_preserves_filter_state(self) -> None:
        ctx, page, page_errors = self._new_page()
        try:
            page.goto(self.server.base_url + "/", wait_until="networkidle")
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 5")

            page.locator("#search-input").fill("Bayern")
            page.locator('.filter-btn[data-league="BL1"]').click()
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 1")

            # Switch to Other tab
            page.locator('.tab-btn[data-tab="other"]').click()
            self.assertTrue(page.locator("#other-tab").is_visible())
            self.assertFalse(page.locator("#football-tab").is_visible())
            self.assertFalse(page.locator("#search-input").is_visible(), "Search input must hide on Other tab")
            self.assertFalse(page.locator("#filter-container").is_visible(), "Filter pills must hide on Other tab")
            self.assertEqual(page.locator('.tab-btn[data-tab="other"]').get_attribute("aria-selected"), "true")

            # Switch back to Football tab
            page.locator('.tab-btn[data-tab="football"]').click()
            self.assertTrue(page.locator("#football-tab").is_visible())
            self.assertTrue(page.locator("#search-input").is_visible())
            self.assertTrue(page.locator("#filter-container").is_visible())
            self.assertEqual(page.locator("#search-input").input_value(), "Bayern")
            self.assertEqual(page.locator('.filter-btn[data-league="BL1"]').get_attribute("aria-pressed"), "true")
            self.assertIn("FC Bayern München", page.locator("#teams-grid").inner_text())
            self.assertEqual(page_errors, [])
        finally:
            ctx.close()

    def test_celebration_seo_heading_links_and_canonical_share(self) -> None:
        self.server.set_api_response("/api/united", united_victory_payload(self.server.base_url))

        ctx, page, page_errors = self._new_page()
        try:
            page.goto(self.server.base_url + "/", wait_until="networkidle")
            overlay = page.locator("#celebration-overlay")
            overlay.wait_for(state="visible", timeout=5000)

            # T3-SEO-03: Celebration overlay must NOT add a second <h1> (use <h2> instead)
            h1_count = page.locator("h1").count()
            self.assertEqual(h1_count, 1, f"Total <h1> count must remain 1 during celebration, got {h1_count}")
            self.assertGreaterEqual(overlay.locator("h2").count(), 1, "Celebration overlay should use <h2>")

            # Every target="_blank" link inside overlay has rel="noopener noreferrer"
            bad_overlay_links = overlay.evaluate(
                """el => [...el.querySelectorAll('a[target="_blank"]')]
                    .filter(a => {
                        const tokens = (a.getAttribute('rel') || '').toLowerCase().split(/\\s+/);
                        return !(tokens.includes('noopener') && tokens.includes('noreferrer'));
                    })
                    .map(a => a.outerHTML)"""
            )
            self.assertEqual(bad_overlay_links, [], f"Overlay links missing noopener noreferrer: {bad_overlay_links}")

            # Share links use canonical https://www.hasunitedwon5.com/ (not bare https://hasunitedwon5.com)
            hrefs = overlay.evaluate("el => [...el.querySelectorAll('a[href]')].map(a => a.getAttribute('href') || '')")
            share_hrefs = [unquote(h) for h in hrefs if "hasunitedwon5.com" in unquote(h)]
            self.assertTrue(len(share_hrefs) > 0, "Expected at least one share link referencing hasunitedwon5.com")
            for sh in share_hrefs:
                self.assertIn("https://www.hasunitedwon5.com", sh, f"Share link must use www. canonical URL: {sh}")
                self.assertNotIn("https://hasunitedwon5.com", sh, f"Share link must not use non-www URL: {sh}")

            self.assertEqual(page_errors, [])
        finally:
            ctx.close()


if __name__ == "__main__":
    unittest.main()
