"""Read-only, serial monitoring of public Wenzhou University college notices.

The source catalogue and HTML parsers come from the repository's scraper. The
workbench stores only notice metadata, not article bodies or attachments.
"""

from __future__ import annotations

import json
import sys
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from bs4 import BeautifulSoup


REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from _common import PAGE_DELAY, fetch, is_auth_wall, jitter, new_session  # noqa: E402
from scrape import (  # noqa: E402
    build_date_map,
    clean_column,
    extract_items,
    find_notice_blocks,
    is_noise,
    pick_list_pages,
)


STORE_PATH = REPO_ROOT / "data" / "attention-desk" / "official_monitor.json"
CATALOG_PATH = REPO_ROOT / "data" / "sites.json"
CATALOG_URL = "https://www.wzu.edu.cn/xxgk/xysz.htm"
DIRECT_LISTS = {
    "ai.wzu.edu.cn": "https://ai.wzu.edu.cn/xwzx/xsgg.htm",
    "slxy.wzu.edu.cn": "https://slxy.wzu.edu.cn/xxzx/xsgg.htm",
    "shxy.wzu.edu.cn": "https://shxy.wzu.edu.cn/xwzx/xsgg.htm",
    "jdxy.wzu.edu.cn": "https://jdxy.wzu.edu.cn/xstz.htm",
    "eee.wzu.edu.cn": "https://eee.wzu.edu.cn/xwzx1/xsgg.htm",
    "chem.wzu.edu.cn": "https://chem.wzu.edu.cn/index/tzgg/xsgg1.htm",
    "cace.wzu.edu.cn": "https://cace.wzu.edu.cn/ywgk/xsgg.htm",
    "yyxy.wzu.edu.cn": "https://yyxy.wzu.edu.cn/xstz1/xstz.htm",
    "art.wzu.edu.cn": "https://art.wzu.edu.cn/xwzx/xsgg.htm",
    "hum.wzu.edu.cn": "https://hum.wzu.edu.cn/xysy/xstz.htm",
    "jsjyxy.wzu.edu.cn": "https://jsjyxy.wzu.edu.cn/index/xsgg.htm",
}
INTERVAL_OPTIONS = {0, 6, 12, 24}


class AuthRequired(RuntimeError):
    pass


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def official_host(url: str) -> bool:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    return parsed.scheme == "https" and (host == "wzu.edu.cn" or host.endswith(".wzu.edu.cn"))


def load_catalog(path: Path = CATALOG_PATH) -> list[dict[str, str]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    sources: list[dict[str, str]] = []
    seen: set[str] = set()
    for entry in payload.get("学院", []):
        home = str(entry.get("url") or "").rstrip("/") + "/"
        host = (urlparse(home).hostname or "").lower()
        if not official_host(home) or host in seen:
            continue
        seen.add(host)
        sources.append({
            "id": host,
            "name": str(entry.get("name") or host),
            "home": home,
            "list_url": DIRECT_LISTS.get(host, ""),
        })
    return sources


def parse_notice_page(html: str, url: str, column: str) -> list[dict[str, str]]:
    soup = BeautifulSoup(html, "lxml")
    return extract_items(soup, url, column, build_date_map(soup))


def normalize_notices(raw: list[dict[str, str]]) -> list[dict[str, str]]:
    notices: dict[str, dict[str, str]] = {}
    for item in raw:
        title = " ".join(str(item.get("title") or "").split())[:240]
        url = str(item.get("url") or "")
        date = str(item.get("date") or "")
        if not title or not official_host(url) or is_noise(title, date):
            continue
        current = notices.get(url)
        if current:
            if not current["published_at"] and date:
                current["published_at"] = date
            continue
        notices[url] = {
            "title": title,
            "url": url,
            "published_at": date,
            "column": clean_column(str(item.get("column") or "通知公告")),
        }
    return sorted(notices.values(), key=lambda item: (item["published_at"], item["title"]), reverse=True)[:160]


def collect_source(source: dict[str, str]) -> dict[str, Any]:
    """Fetch one college at a time using the teammate scraper's parser/rate limit."""
    session = new_session()
    request_count = 0

    def read_page(url: str, referer: str | None = None) -> tuple[str, str]:
        nonlocal request_count
        if not official_host(url):
            raise ValueError("来源地址不是温州大学官方域名")
        status, final, html, error = fetch(session, url, referer=referer, timeout=12, tries=1)
        request_count += 1
        if error:
            raise RuntimeError(error[:180])
        if is_auth_wall(status, final, html):
            raise AuthRequired("页面需要认证，已跳过")
        if status != 200 or not html:
            raise RuntimeError(f"HTTP {status or 'unknown'}")
        if not official_host(final):
            raise RuntimeError("页面跳转到非温大域名，已跳过")
        return final, html

    raw: list[dict[str, str]] = []
    errors: list[Exception] = []
    successful_pages = 0

    def try_page(url: str, referer: str | None = None) -> tuple[str, str] | None:
        nonlocal successful_pages
        if request_count:
            jitter(PAGE_DELAY)
        try:
            page = read_page(url, referer)
        except (AuthRequired, RuntimeError, ValueError) as exc:
            errors.append(exc)
            return None
        successful_pages += 1
        return page

    if source["list_url"]:
        page = try_page(source["list_url"], referer=source["home"])
        if page:
            raw.extend(parse_notice_page(page[1], page[0], "学生公告"))

    home_page = try_page(source["home"])
    if home_page:
        final, html = home_page
        soup = BeautifulSoup(html, "lxml")
        date_map = build_date_map(soup)
        blocks = find_notice_blocks(soup, final)
        for block in blocks:
            raw.extend(extract_items(block["node"], final, "/".join(block["labels"]), date_map))
        if not raw:
            raw.extend(extract_items(soup, final, "首页公告", date_map))
        for candidate in pick_list_pages(soup, final, blocks)[:2]:
            if candidate["url"] == source["list_url"]:
                continue
            page = try_page(candidate["url"], referer=final)
            if page:
                raw.extend(parse_notice_page(page[1], page[0], candidate["label"] or "通知公告"))

    if not successful_pages:
        raise errors[0] if errors else RuntimeError("没有可访问的公开页面")

    notices = normalize_notices(raw)
    return {
        "status": "partial" if errors else ("ok" if notices else "empty"),
        "error": "; ".join(str(error) for error in errors[:2])[:240],
        "notices": notices,
        "request_count": request_count,
        "checked_at": now_iso(),
    }


def merge_notices(previous: dict[str, Any], fetched: list[dict[str, str]], checked_at: str) -> dict[str, Any]:
    old = previous.get("notices") or {}
    first_scan = not previous.get("baseline_complete")
    merged = dict(old)
    for item in fetched:
        url = item["url"]
        existing = old.get(url) or {}
        merged[url] = {
            **item,
            "first_seen": existing.get("first_seen") or checked_at,
            "last_seen": checked_at,
            "read": existing.get("read", True) if existing else first_scan,
        }
    return merged


class OfficialMonitor:
    def __init__(self, store_path: Path = STORE_PATH, catalog_path: Path = CATALOG_PATH, start_scheduler: bool = True):
        self.store_path = store_path
        self.catalog = load_catalog(catalog_path)
        self.by_id = {source["id"]: source for source in self.catalog}
        self._state_lock = threading.Lock()
        self._run_lock = threading.Lock()
        self._run: dict[str, Any] = {"running": False, "done": 0, "total": 0, "failed": 0, "current": ""}
        self._state = self._load_state()
        if start_scheduler:
            threading.Thread(target=self._schedule_loop, name="official-monitor-scheduler", daemon=True).start()

    def _load_state(self) -> dict[str, Any]:
        if not self.store_path.exists():
            return {"version": 1, "auto_interval_hours": 12, "last_full_scan_at": None, "sources": {}}
        payload = json.loads(self.store_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict) or not isinstance(payload.get("sources"), dict):
            raise ValueError("官网监测记录文件格式不正确")
        return payload

    def _save_state(self) -> None:
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.store_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self._state, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.store_path)

    def overview(self) -> dict[str, Any]:
        with self._state_lock:
            snapshots = json.loads(json.dumps(self._state))
        sources = []
        notices = []
        for source in self.catalog:
            snapshot = snapshots["sources"].get(source["id"], {})
            stored = list((snapshot.get("notices") or {}).values())
            unread = sum(notice.get("read") is False for notice in stored)
            sources.append({
                **source,
                "status": snapshot.get("status", "not_checked"),
                "checked_at": snapshot.get("checked_at"),
                "error": snapshot.get("error", ""),
                "notice_count": len(stored),
                "unread_count": unread,
                "latest_notice_date": max((notice.get("published_at") or "" for notice in stored), default=""),
            })
            notices.extend({**notice, "source_id": source["id"], "source_name": source["name"]} for notice in stored)
        notices.sort(key=lambda item: (item.get("read") is False, item.get("first_seen") or "", item.get("published_at") or ""), reverse=True)
        with self._run_lock:
            run = dict(self._run)
        return {
            "catalog_url": CATALOG_URL,
            "sources": sources,
            "notices": notices[:2000],
            "summary": {
                "source_count": len(sources),
                "checked_count": sum(source["status"] != "not_checked" for source in sources),
                "healthy_count": sum(source["status"] in {"ok", "empty"} for source in sources),
                "error_count": sum(source["status"] in {"error", "auth_required", "partial"} for source in sources),
                "notice_count": len(notices),
                "unread_count": sum(notice.get("read") is False for notice in notices),
                "last_full_scan_at": snapshots.get("last_full_scan_at"),
                "auto_interval_hours": snapshots.get("auto_interval_hours", 12),
            },
            "scan": run,
        }

    def start_scan(self, source_ids: list[str] | None = None) -> dict[str, Any]:
        ids = source_ids if source_ids is not None else [source["id"] for source in self.catalog]
        if not ids or any(source_id not in self.by_id for source_id in ids):
            raise ValueError("请选择有效的学院来源")
        ids = list(dict.fromkeys(ids))
        with self._run_lock:
            if self._run["running"]:
                raise RuntimeError("已有检查任务正在运行")
            self._run = {
                "running": True,
                "done": 0,
                "total": len(ids),
                "failed": 0,
                "current": "",
                "started_at": now_iso(),
                "finished_at": None,
            }
        threading.Thread(target=self._run_scan, args=(ids,), name="official-monitor-scan", daemon=True).start()
        return dict(self._run)

    def _run_scan(self, ids: list[str]) -> None:
        try:
            self._scan_sources(ids)
        except Exception as exc:
            with self._run_lock:
                self._run["error"] = f"扫描中断：{str(exc)[:180]}"
        finally:
            with self._run_lock:
                self._run["running"] = False
                self._run["current"] = ""
                self._run["finished_at"] = now_iso()

    def _scan_sources(self, ids: list[str]) -> None:
        for index, source_id in enumerate(ids):
            source = self.by_id[source_id]
            with self._run_lock:
                self._run["current"] = source["name"]
            try:
                outcome = collect_source(source)
                with self._state_lock:
                    previous = self._state["sources"].get(source_id, {})
                    self._state["sources"][source_id] = {
                        **previous,
                        "status": outcome["status"],
                        "checked_at": outcome["checked_at"],
                        "error": outcome.get("error", ""),
                        "request_count": outcome["request_count"],
                        "baseline_complete": True,
                        "notices": merge_notices(previous, outcome["notices"], outcome["checked_at"]),
                    }
                    self._save_state()
            except Exception as exc:
                status = "auth_required" if isinstance(exc, AuthRequired) else "error"
                with self._state_lock:
                    previous = self._state["sources"].get(source_id, {})
                    self._state["sources"][source_id] = {
                        **previous,
                        "status": status,
                        "checked_at": now_iso(),
                        "error": str(exc)[:240],
                    }
                    self._save_state()
                with self._run_lock:
                    self._run["failed"] += 1
            with self._run_lock:
                self._run["done"] = index + 1
            if index + 1 < len(ids):
                jitter(PAGE_DELAY)
        if len(ids) == len(self.catalog):
            with self._state_lock:
                self._state["last_full_scan_at"] = now_iso()
                self._save_state()

    def set_read(self, source_id: str | None, url: str | None, read: bool) -> int:
        if (source_id is not None and source_id not in self.by_id) or type(read) is not bool or (url and not source_id):
            raise ValueError("无效的学院或已读状态")
        with self._state_lock:
            groups = [self._state["sources"].get(source_id, {}).get("notices") or {}] if source_id else [
                entry.get("notices") or {} for entry in self._state["sources"].values()
            ]
            if url and url not in groups[0]:
                raise ValueError("未找到公告")
            targets = [groups[0][url]] if url else [notice for group in groups for notice in group.values()]
            for notice in targets:
                notice["read"] = read
            self._save_state()
            return len(targets)

    def set_interval(self, hours: int) -> None:
        if hours not in INTERVAL_OPTIONS:
            raise ValueError("自动检查间隔只能是 0、6、12 或 24 小时")
        with self._state_lock:
            self._state["auto_interval_hours"] = hours
            self._save_state()

    def _schedule_loop(self) -> None:
        while True:
            time.sleep(60)
            with self._state_lock:
                hours = self._state.get("auto_interval_hours", 12)
                last = self._state.get("last_full_scan_at")
            if not hours or not last:
                continue
            try:
                due = datetime.fromisoformat(last) + timedelta(hours=hours)
                if datetime.now().astimezone() >= due:
                    self.start_scan()
            except (ValueError, RuntimeError):
                continue
