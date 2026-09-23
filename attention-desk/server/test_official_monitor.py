import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from fastapi.testclient import TestClient

from server import main
from server import official_monitor as monitor_module


def notice(news_id, date):
    return {
        "title": f"关于第 {news_id} 项学生事务的通知",
        "url": f"https://ai.wzu.edu.cn/info/1001/{news_id}.htm",
        "published_at": date,
        "column": "通知公告",
    }


def outcome(items):
    return {"status": "ok", "error": "", "checked_at": "2026-09-24T12:00:00+08:00", "request_count": 1, "notices": items}


class OfficialMonitorTests(unittest.TestCase):
    def make_monitor(self, directory):
        root = Path(directory)
        catalog = root / "sites.json"
        catalog.write_text(json.dumps({"学院": [{"name": "计算机与人工智能学院", "url": "https://ai.wzu.edu.cn/"}]}), encoding="utf-8")
        return monitor_module.OfficialMonitor(root / "state.json", catalog, start_scheduler=False)

    def test_catalog_uses_22_official_college_hosts(self):
        sources = monitor_module.load_catalog()
        self.assertEqual(len(sources), 22)
        self.assertTrue(all(monitor_module.official_host(source["home"]) for source in sources))
        self.assertFalse(monitor_module.official_host("https://ai.wzu.edu.cn.evil.example/"))
        self.assertFalse(monitor_module.official_host("http://ai.wzu.edu.cn/"))

    def test_teammate_parser_reads_hidden_article_dates(self):
        html = '<span id="time12345">2026-09-23</span><a href="/info/1001/12345.htm">关于奖学金申请安排的通知</a>'
        items = monitor_module.parse_notice_page(html, "https://ai.wzu.edu.cn/xwzx/xsgg.htm", "学生公告")
        self.assertEqual(items[0]["date"], "2026-09-23")
        self.assertEqual(items[0]["url"], "https://ai.wzu.edu.cn/info/1001/12345.htm")

    def test_partial_source_keeps_homepage_notices_when_list_fails(self):
        html = '''<div><h2>通知公告</h2><ul>
          <li><span id="time12345">2026-09-23</span><a href="/info/1001/12345.htm">关于奖学金申请安排的通知</a></li>
          <li><span id="time12346">2026-09-24</span><a href="/info/1001/12346.htm">关于学生会议时间安排的通知</a></li>
        </ul></div>'''

        def fake_fetch(_session, url, **_kwargs):
            if url.endswith("xsgg.htm"):
                return None, url, "", "列表页暂时不可用"
            return 200, url, html, ""

        source = {"home": "https://ai.wzu.edu.cn/", "list_url": "https://ai.wzu.edu.cn/xwzx/xsgg.htm"}
        with patch.object(monitor_module, "fetch", side_effect=fake_fetch), patch.object(monitor_module, "jitter"):
            result = monitor_module.collect_source(source)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(len(result["notices"]), 2)
        self.assertIn("列表页暂时不可用", result["error"])

    def test_first_scan_is_read_and_later_new_notice_is_unread(self):
        with TemporaryDirectory() as directory:
            monitor = self.make_monitor(directory)
            source_id = "ai.wzu.edu.cn"
            with patch.object(monitor_module, "collect_source", side_effect=[
                outcome([notice(12345, "2026-09-23")]),
                outcome([notice(12345, "2026-09-23"), notice(12346, "2026-09-24")]),
            ]):
                monitor._run_scan([source_id])
                self.assertEqual(monitor.overview()["summary"]["unread_count"], 0)
                monitor._run_scan([source_id])
            overview = monitor.overview()
            self.assertEqual(overview["summary"]["unread_count"], 1)
            self.assertEqual(overview["notices"][0]["url"], notice(12346, "2026-09-24")["url"])
            self.assertEqual(monitor.set_read(source_id, notice(12346, "2026-09-24")["url"], True), 1)
            self.assertEqual(monitor.overview()["summary"]["unread_count"], 0)
            reloaded = self.make_monitor(directory)
            self.assertEqual(reloaded.overview()["summary"]["notice_count"], 2)

    def test_failed_first_scan_does_not_consume_baseline(self):
        with TemporaryDirectory() as directory:
            monitor = self.make_monitor(directory)
            with patch.object(monitor_module, "collect_source", side_effect=[
                monitor_module.AuthRequired("需认证"), outcome([notice(12345, "2026-09-23")]),
            ]):
                monitor._run_scan(["ai.wzu.edu.cn"])
                self.assertEqual(monitor.overview()["sources"][0]["status"], "auth_required")
                monitor._run_scan(["ai.wzu.edu.cn"])
            self.assertEqual(monitor.overview()["summary"]["unread_count"], 0)

    def test_api_rejects_invalid_scan_and_settings(self):
        with TemporaryDirectory() as directory:
            monitor = self.make_monitor(directory)
            with patch.object(main, "OFFICIAL", monitor):
                client = TestClient(main.app)
                self.assertEqual(client.get("/api/official/overview").json()["summary"]["source_count"], 1)
                self.assertEqual(client.post("/api/official/scan", json={"source_ids": ["evil.example"]}).status_code, 400)
                self.assertEqual(client.post("/api/official/settings", json={"auto_interval_hours": 3}).status_code, 400)
                self.assertEqual(client.post("/api/official/settings", json={"auto_interval_hours": 6}).status_code, 200)


if __name__ == "__main__":
    unittest.main()
