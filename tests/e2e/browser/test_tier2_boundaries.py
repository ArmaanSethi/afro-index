"""Tier 2 Browser E2E tests — Security (XSS), Timezones/DST, Edge Cases & Error States."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from playwright.sync_api import sync_playwright

from fixtures import (
    empty_teams_payload,
    invalid_dates_payload,
    normal_teams_payload,
    normal_united_payload,
    united_victory_payload,
    xss_teams_payload,
    xss_united_payload,
)
from server import LocalE2EServer, install_offline_routes, launch_browser


class Tier2BrowserBoundariesTest(unittest.TestCase):
    server: LocalE2EServer
    pw: object
    browser: object

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = LocalE2EServer().start()
        cls.pw = sync_playwright().start()
        cls.browser = launch_browser(
            cls.pw,
            extra_args=["--host-resolver-rules=MAP prod.hasunitedwon5.test 127.0.0.1"],
        )

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

    def test_xss_payloads_neutralized_in_teams_and_united(self) -> None:
        self.server.set_api_response("/api/teams", xss_teams_payload())
        self.server.set_api_response("/api/united", xss_united_payload())

        ctx, page, page_errors = self._new_page()
        try:
            page.goto(self.server.base_url + "/", wait_until="networkidle")
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 1")

            # Dispatch error events on all images to try triggering any broken inline onerror
            page.evaluate(
                "() => document.querySelectorAll('img').forEach(img => img.dispatchEvent(new Event('error')))"
            )
            page.wait_for_timeout(150)

            xss_flag = page.evaluate("() => window.__xss")
            self.assertIsNone(xss_flag, f"XSS payload executed! window.__xss = {xss_flag}")

            audit = page.evaluate(
                """() => {
                    const containers = ['#teams-grid', '#leagues-status', '#streak-circles', '#united-form'];
                    let scripts = 0;
                    let jsUrls = 0;
                    let eventAttrs = 0;
                    for (const sel of containers) {
                        const root = document.querySelector(sel);
                        if (!root) continue;
                        scripts += root.querySelectorAll('script').length;
                        jsUrls += root.querySelectorAll('[src^="javascript:"], [href^="javascript:"]').length;
                        for (const el of root.querySelectorAll('*')) {
                            for (const attr of el.attributes) {
                                if (/^on/i.test(attr.name)) eventAttrs++;
                            }
                        }
                    }
                    return { scripts, jsUrls, eventAttrs };
                }"""
            )
            self.assertEqual(audit["scripts"], 0, "Injected <script> tags must be escaped")
            self.assertEqual(audit["jsUrls"], 0, "javascript: URLs must be blocked")
            self.assertEqual(audit["eventAttrs"], 0, "Inline event handler attributes must not be injected")

            grid_text = page.locator("#teams-grid").inner_text()
            self.assertIn("Evil FC", grid_text)
            self.assertEqual(page_errors, [])
        finally:
            ctx.close()

    def test_dst_and_timezone_consistency(self) -> None:
        # 2025-04-01T00:30:00Z is Apr 1 in London (BST) & Tokyo, but Mar 31 in Los Angeles.
        # UK calendar days from 2024-10-05 to 2025-04-01 = 178 days.
        timezones = ["America/Los_Angeles", "Europe/London", "Asia/Tokyo"]

        for tz in timezones:
            with self.subTest(timezone=tz):
                self.server.set_api_response("/api/teams", normal_teams_payload(self.server.base_url))
                self.server.set_api_response("/api/united", normal_united_payload(self.server.base_url))

                ctx, page, page_errors = self._new_page(timezone_id=tz)
                try:
                    page.clock.set_fixed_time("2025-04-01T00:30:00Z")
                    page.goto(self.server.base_url + "/", wait_until="networkidle")
                    page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 5")

                    self.assertEqual(
                        page.locator("#days-count").inner_text().strip(),
                        "178",
                        f"#days-count must be 178 in {tz}",
                    )
                    self.assertEqual(
                        page.locator("#days-inline").inner_text().strip(),
                        "178",
                        f"#days-inline must be 178 in {tz}",
                    )

                    # Card tooltip for 2025-01-15 must show Jan 15 (not Jan 14 in LA)
                    arsenal_card = page.locator("#teams-grid > div", has_text="Arsenal FC").first
                    tooltip = arsenal_card.locator("[title*='Jan']").first.get_attribute("title") or ""
                    self.assertIn("Jan 15", tooltip, f"Date-only tooltip shifted in {tz}: {tooltip}")

                    # Best streak dates must be Jan 10 -> Jan 24 in all timezones
                    dates_text = page.locator("#best-streak-dates").inner_text()
                    self.assertIn("Jan 10", dates_text)
                    self.assertIn("Jan 24", dates_text)

                    # Victory overlay: 2025-03-15T16:30:00Z => 16:30:00 UK time & frozen 161 days
                    self.server.set_api_response(
                        "/api/united",
                        united_victory_payload(self.server.base_url, achievement_date="2025-03-15T16:30:00Z"),
                    )
                    page.reload(wait_until="networkidle")
                    overlay = page.locator("#celebration-overlay")
                    overlay.wait_for(state="visible", timeout=5000)
                    ov_text = overlay.inner_text()
                    self.assertIn("16:30:00", ov_text, f"Overlay must show UK time 16:30:00 in {tz}")
                    self.assertIn("161", ov_text, f"Overlay must show frozen day count 161 in {tz}")
                    self.assertEqual(page_errors, [])
                finally:
                    ctx.close()

    def test_search_diacritics_whitespace_and_zero_results(self) -> None:
        ctx, page, page_errors = self._new_page()
        try:
            page.goto(self.server.base_url + "/", wait_until="networkidle")
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 5")

            search = page.locator("#search-input")

            # Diacritic + whitespace normalization
            search.fill("  atletico  ")
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 1")
            self.assertIn("Atlético de Madrid", page.locator("#teams-grid").inner_text())

            search.fill("munchen")
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 1")
            self.assertIn("FC Bayern München", page.locator("#teams-grid").inner_text())

            # League ID search
            search.fill("PL")
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 2")

            # Country search
            search.fill("Spain")
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 1")
            self.assertIn("Atlético de Madrid", page.locator("#teams-grid").inner_text())

            # Zero-results state + reset button (may render in #empty-state or inline inside #teams-grid)
            search.fill("zzzz-no-match")
            page.wait_for_function(
                "() => !document.getElementById('teams-grid').innerText.includes('Arsenal FC')"
                " && !document.getElementById('teams-grid').innerText.includes('Bayern')",
                timeout=5000,
            )
            self.assertEqual(page.locator("#team-count").inner_text().strip(), "5", "Hero #team-count must stay 5")
            zero_container = page.locator("#empty-state") if page.locator("#empty-state").is_visible() else page.locator("#teams-grid")
            zero_text = zero_container.inner_text()
            self.assertTrue(len(zero_text.strip()) > 0, "Zero-results state must display a clear message")
            self.assertNotIn("Loading teams", zero_text)

            # Click clear/reset button
            reset_btn = page.locator(
                "#empty-state button:visible, #teams-grid button:visible, #clear-filters-btn:visible, #reset-filters-btn:visible, #clear-search-btn:visible"
            ).first
            self.assertTrue(reset_btn.count() > 0 and reset_btn.is_visible(), "Zero-results view must offer a visible clear/reset button")
            reset_btn.click()
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 5", timeout=5000)
            self.assertEqual(page_errors, [])
        finally:
            ctx.close()

    def test_leagues_scanned_zero_renders_zero(self) -> None:
        self.server.set_api_response("/api/teams", empty_teams_payload(leagues_scanned=0))

        ctx, page, page_errors = self._new_page()
        try:
            page.goto(self.server.base_url + "/", wait_until="networkidle")
            page.wait_for_function("document.getElementById('loading-state').classList.contains('hidden')")

            self.assertEqual(page.locator("#leagues-count").inner_text().strip(), "0", "#leagues-count must show 0, not --")
            self.assertEqual(page.locator("#team-count").inner_text().strip(), "0")
            self.assertTrue(page.locator("#empty-state").is_visible())
            self.assertNotIn("Loading teams", page.locator("#empty-state").inner_text())
            self.assertEqual(page_errors, [])
        finally:
            ctx.close()

    def test_null_league_id_does_not_crash_filter_or_sort(self) -> None:
        payload = normal_teams_payload(self.server.base_url)
        payload["teams"].append(
            {
                "team_id": 9999,
                "name": "Mystery FC",
                "logo": f"{self.server.base_url}/mock-crest/9999.png",
                "country_name": None,
                "country_flag": None,
                "league_id": None,
                "league_name": None,
                "form": "WWWWW",
                "has_5_wins": True,
                "max_streak": 5,
                "streak_achieved_date": "2025-02-01",
                "first_detected": "2025-02-01T12:00:00Z",
                "last_checked": "2025-03-01T12:00:00Z",
            }
        )
        payload["winnersCount"] = len(payload["teams"])
        self.server.set_api_response("/api/teams", payload)

        ctx, page, page_errors = self._new_page()
        try:
            page.goto(self.server.base_url + "/", wait_until="networkidle")
            page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 6")

            sort_select = page.locator("#sort-select, #leaderboard select").first
            if sort_select.count() > 0:
                options = sort_select.locator("option").evaluate_all("els => els.map(e => e.value)")
                for opt in options:
                    sort_select.select_option(opt)

            self.assertEqual(page_errors, [], f"Null league_id caused pageerror: {page_errors}")
        finally:
            ctx.close()

    def test_invalid_and_missing_dates_never_show_invalid_date(self) -> None:
        for null_variant in (False, True):
            with self.subTest(null_variant=null_variant):
                teams, united = invalid_dates_payload(null_variant=null_variant)
                self.server.set_api_response("/api/teams", teams)
                self.server.set_api_response("/api/united", united)

                ctx, page, page_errors = self._new_page()
                try:
                    page.goto(self.server.base_url + "/", wait_until="networkidle")
                    page.wait_for_function("document.querySelectorAll('#teams-grid > div').length === 1")

                    body_text = page.locator("body").inner_text()
                    self.assertNotIn("Invalid Date", body_text)
                    self.assertNotIn("NaNm ago", body_text)
                    self.assertNotIn("NaN", page.locator("#leagues-status").inner_text())
                    self.assertNotIn("NaN", page.locator("#united-status").inner_text())
                    self.assertEqual(page_errors, [])
                finally:
                    ctx.close()

    def test_http_500_and_network_offline_distinct_error_ui(self) -> None:
        # Subtest A: HTTP 500
        self.server.set_api_response("/api/teams", {"error": "Internal Server Error"}, status=500)
        self.server.set_api_response("/api/united", {"error": "Upstream Error"}, status=500)

        ctx, page, page_errors = self._new_page()
        try:
            page.goto(self.server.base_url + "/", wait_until="domcontentloaded")
            page.wait_for_function("document.getElementById('loading-state').classList.contains('hidden')", timeout=5000)

            empty_state = page.locator("#empty-state")
            self.assertTrue(empty_state.is_visible(), "Error state must be visible on HTTP 500")
            empty_text = empty_state.inner_text()
            self.assertNotIn("Loading teams", empty_text)
            self.assertTrue(
                any(w in empty_text.lower() for w in ("error", "unable", "failed", "retry", "try again")),
                f"Expected error messaging in #empty-state, got: {empty_text!r}",
            )
            self.assertNotIn("Loading coverage data", page.locator("#leagues-status").inner_text())
            self.assertNotIn("Checking United's form", page.locator("#united-status").inner_text())
            self.assertEqual(page_errors, [])
        finally:
            ctx.close()

        # Subtest B: Network offline (aborted requests)
        ctx2, page2, page_errors2 = self._new_page()
        try:
            page2.route("**/api/teams*", lambda r: r.abort())
            page2.route("**/api/united*", lambda r: r.abort())
            page2.goto(self.server.base_url + "/", wait_until="domcontentloaded")
            page2.wait_for_function("document.getElementById('loading-state').classList.contains('hidden')", timeout=5000)

            empty_text = page2.locator("#empty-state").inner_text()
            self.assertNotIn("Loading teams", empty_text)
            self.assertTrue(
                any(w in empty_text.lower() for w in ("error", "unable", "failed", "offline", "retry", "try again")),
                f"Expected error/offline messaging, got: {empty_text!r}",
            )
            self.assertEqual(page_errors2, [])
        finally:
            ctx2.close()

    def test_celebrate_query_param_gated_to_localhost_and_non_persistent(self) -> None:
        # Subtest A: Non-localhost domain must NOT trigger ?celebrate=true backdoor
        ctx_prod, page_prod, _ = self._new_page()
        try:
            prod_url = f"http://prod.hasunitedwon5.test:{self.server.port}/?celebrate=true"
            page_prod.goto(prod_url, wait_until="networkidle")
            page_prod.wait_for_timeout(2200)
            self.assertEqual(
                page_prod.locator("#celebration-overlay").count(),
                0,
                "/?celebrate=true must NOT trigger celebration on non-localhost hostnames",
            )
            self.assertEqual(page_prod.locator("#united-answer").inner_text().strip(), "NO")
        finally:
            ctx_prod.close()

        # Subtest B: localhost triggers preview celebration WITHOUT persisting united_achievement_time
        ctx_local, page_local, _ = self._new_page()
        try:
            local_url = f"http://localhost:{self.server.port}/?celebrate=true"
            page_local.goto(local_url, wait_until="networkidle")
            page_local.locator("#celebration-overlay").wait_for(state="visible", timeout=5000)
            self.assertEqual(page_local.locator("#celebration-overlay").count(), 1)
            stored = page_local.evaluate("() => localStorage.getItem('united_achievement_time')")
            self.assertIsNone(stored, "/?celebrate=true preview must NOT persist united_achievement_time to localStorage")
        finally:
            ctx_local.close()


if __name__ == "__main__":
    unittest.main()
