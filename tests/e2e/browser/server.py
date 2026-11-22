"""Ephemeral static + controllable mock-API HTTP server and Playwright helpers for E2E browser tests."""

from __future__ import annotations

import base64
import json
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

CHROME_PATH = "/usr/bin/google-chrome"

# Valid 1x1 transparent PNG fallback
MINIMAL_PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".woff2": "font/woff2",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json",
    ".json": "application/json; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
}


@dataclass
class MockRoute:
    status: int = 200
    body: Any = None
    headers: dict[str, str] = field(default_factory=dict)
    delay_ms: int = 0
    handler: Callable[[dict[str, Any]], tuple[int, Any, dict[str, str]]] | None = None


class _ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


class LocalE2EServer:
    """Ephemeral local HTTP server serving `public/` static files and runtime-mutable `/api/*` mocks."""

    def __init__(self, public_dir: Path | None = None, debug: bool = False) -> None:
        self.repo_root = Path(__file__).resolve().parents[3]
        self.public_dir = (public_dir or (self.repo_root / "public")).resolve()
        self.debug = debug

        crest_file = self.public_dir / "united-crest.png"
        self._crest_bytes = crest_file.read_bytes() if crest_file.is_file() else MINIMAL_PNG_BYTES

        self._lock = threading.Lock()
        self._routes: dict[str, MockRoute] = self._default_routes()
        self._requests: list[dict[str, Any]] = []
        self._httpd: _ReusableThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @staticmethod
    def _default_routes() -> dict[str, MockRoute]:
        return {
            "/api/teams": MockRoute(
                status=200,
                body={
                    "success": True,
                    "winnersCount": 0,
                    "totalScanned": 0,
                    "leaguesScanned": 0,
                    "teams": [],
                    "recentScans": [],
                },
            ),
            "/api/united": MockRoute(
                status=200,
                body={
                    "scope": "all_competitions",
                    "hasWon5": False,
                    "achievementDate": None,
                    "currentStreak": 0,
                    "bestStreak": 0,
                    "bestStreakDetails": None,
                    "form": "",
                    "recentMatches": [],
                    "lastUpdated": "2025-03-15T12:00:00Z",
                },
            ),
            "/api/scan": MockRoute(
                status=200,
                body={"success": True, "skipped": True, "reason": "mock default"},
            ),
        }

    @property
    def port(self) -> int:
        if self._httpd is None:
            raise RuntimeError("LocalE2EServer is not started")
        return int(self._httpd.server_address[1])

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def start(self) -> "LocalE2EServer":
        if self._httpd is not None:
            return self

        server_ref = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format: str, *args: Any) -> None:
                if server_ref.debug:
                    super().log_message(format, *args)

            def _record(self, method: str, parsed) -> dict[str, Any]:
                entry = {
                    "method": method,
                    "path": parsed.path,
                    "query": parsed.query,
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                    "ts": time.monotonic(),
                }
                with server_ref._lock:
                    server_ref._requests.append(entry)
                return entry

            def _send_bytes(
                self,
                status: int,
                payload: bytes,
                content_type: str,
                extra_headers: dict[str, str] | None = None,
                head_only: bool = False,
            ) -> None:
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                if extra_headers:
                    for k, v in extra_headers.items():
                        self.send_header(k, v)
                self.end_headers()
                if not head_only and payload:
                    self.wfile.write(payload)

            def do_OPTIONS(self) -> None:
                parsed = urlparse(self.path)
                self._record("OPTIONS", parsed)
                self._send_bytes(
                    204,
                    b"",
                    "text/plain; charset=utf-8",
                    extra_headers={
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "GET, OPTIONS",
                        "Access-Control-Allow-Headers": "Content-Type, Authorization",
                    },
                    head_only=True,
                )

            def do_HEAD(self) -> None:
                self._handle_get_or_head(head_only=True)

            def do_GET(self) -> None:
                self._handle_get_or_head(head_only=False)

            def _handle_get_or_head(self, head_only: bool) -> None:
                parsed = urlparse(self.path)
                req_info = self._record("HEAD" if head_only else "GET", parsed)
                path_str = parsed.path

                # 1. Mock crest route for 100% offline image loading
                if path_str.startswith("/mock-crest/"):
                    self._send_bytes(
                        200,
                        server_ref._crest_bytes,
                        "image/png",
                        head_only=head_only,
                    )
                    return

                # 2. Mock API routes
                if path_str.startswith("/api/"):
                    with server_ref._lock:
                        route = server_ref._routes.get(path_str)
                    if route is None:
                        self._send_bytes(
                            404,
                            json.dumps({"error": f"No mock route for {path_str}"}).encode("utf-8"),
                            "application/json; charset=utf-8",
                            extra_headers={"Access-Control-Allow-Origin": "*"},
                            head_only=head_only,
                        )
                        return

                    if route.delay_ms > 0:
                        time.sleep(route.delay_ms / 1000.0)

                    if route.handler is not None:
                        status, body, headers = route.handler(req_info)
                    else:
                        status, body, headers = route.status, route.body, dict(route.headers)

                    out_headers = {"Access-Control-Allow-Origin": "*", **headers}
                    if isinstance(body, (bytes, bytearray)):
                        payload = bytes(body)
                        ctype = out_headers.pop("Content-Type", "application/octet-stream")
                    elif isinstance(body, str):
                        payload = body.encode("utf-8")
                        ctype = out_headers.pop("Content-Type", "text/plain; charset=utf-8")
                    else:
                        payload = json.dumps(body).encode("utf-8")
                        ctype = out_headers.pop("Content-Type", "application/json; charset=utf-8")

                    self._send_bytes(status, payload, ctype, extra_headers=out_headers, head_only=head_only)
                    return

                # 3. Static files from public/
                rel_path = "index.html" if path_str in ("", "/") else path_str.lstrip("/")
                target = (server_ref.public_dir / rel_path).resolve()

                if not target.is_relative_to(server_ref.public_dir):
                    self._send_bytes(403, b"Forbidden", "text/plain; charset=utf-8", head_only=head_only)
                    return

                if not target.is_file():
                    self._send_bytes(404, b"Not Found", "text/plain; charset=utf-8", head_only=head_only)
                    return

                ctype = MIME_TYPES.get(target.suffix.lower(), "application/octet-stream")
                data = target.read_bytes()
                self._send_bytes(200, data, ctype, head_only=head_only)

        self._httpd = _ReusableThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(
            target=self._httpd.serve_forever,
            kwargs={"poll_interval": 0.1},
            name="e2e-http-server",
            daemon=True,
        )
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._httpd is None:
            return
        httpd = self._httpd
        thread = self._thread
        self._httpd = None
        self._thread = None
        try:
            httpd.shutdown()
        finally:
            if thread is not None:
                thread.join(timeout=5)
            httpd.server_close()

    def __enter__(self) -> "LocalE2EServer":
        return self.start()

    def __exit__(self, exc_type, exc, tb) -> None:
        self.stop()

    def set_api_response(
        self,
        path: str,
        body: Any,
        status: int = 200,
        delay_ms: int = 0,
        headers: dict[str, str] | None = None,
    ) -> None:
        with self._lock:
            self._routes[path] = MockRoute(
                status=status,
                body=body,
                delay_ms=delay_ms,
                headers=dict(headers or {}),
            )

    def set_api_handler(
        self,
        path: str,
        handler: Callable[[dict[str, Any]], tuple[int, Any, dict[str, str]]],
        delay_ms: int = 0,
    ) -> None:
        with self._lock:
            self._routes[path] = MockRoute(handler=handler, delay_ms=delay_ms)

    def reset(self, default_routes: dict[str, MockRoute] | None = None) -> None:
        with self._lock:
            self._routes = dict(default_routes) if default_routes is not None else self._default_routes()
            self._requests.clear()

    def get_requests(self, path_prefix: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            if path_prefix is None:
                return list(self._requests)
            return [r for r in self._requests if r["path"].startswith(path_prefix)]

    def count_requests(self, path: str) -> int:
        with self._lock:
            return sum(1 for r in self._requests if r["path"] == path)

    def clear_requests(self) -> None:
        with self._lock:
            self._requests.clear()


def install_offline_routes(target, local_origin: str) -> list[str]:
    """Intercept external requests on a Playwright Page or BrowserContext.

    - Allows requests to local_origin (and localhost/127.0.0.1/prod.hasunitedwon5.test on the same port).
    - Fulfills https://crests.football-data.org/** with a valid 200 PNG so tests stay 100% offline.
    - Aborts any other external http(s) request and appends its URL to the returned list.
    """
    unexpected_external: list[str] = []
    local_parsed = urlparse(local_origin)
    allowed_hosts = {local_parsed.hostname, "127.0.0.1", "localhost", "prod.hasunitedwon5.test"}

    def _route_handler(route) -> None:
        url = route.request.url
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            route.continue_()
            return
        if parsed.hostname in allowed_hosts and parsed.port == local_parsed.port:
            route.continue_()
            return
        if parsed.hostname == "crests.football-data.org":
            route.fulfill(status=200, content_type="image/png", body=MINIMAL_PNG_BYTES)
            return
        unexpected_external.append(url)
        route.abort()

    target.route("**/*", _route_handler)
    return unexpected_external


def launch_browser(playwright, extra_args: list[str] | None = None):
    """Launch headless Google Chrome using the zero-install system binary."""
    args = ["--no-sandbox", "--disable-dev-shm-usage"]
    if extra_args:
        args.extend(extra_args)
    return playwright.chromium.launch(
        executable_path=CHROME_PATH,
        headless=True,
        args=args,
    )
