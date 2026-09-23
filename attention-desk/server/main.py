from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
from collections import Counter
from datetime import date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, Body, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.concurrency import run_in_threadpool

try:
    from .completion_store import apply_completions, load_completions, set_completion
    from .official_monitor import OfficialMonitor
    from .wechat_bridge import WeChatBridge
except ImportError:  # pragma: no cover - direct module execution fallback
    from completion_store import apply_completions, load_completions, set_completion
    from official_monitor import OfficialMonitor
    from wechat_bridge import WeChatBridge


APP_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = APP_ROOT.parent
SKILL_SCRIPT = REPO_ROOT / ".agents" / "skills" / "attention-announcement-triage" / "scripts" / "triage_announcements.py"
SAMPLE_PATH = Path(os.environ.get("ATTENTION_SAMPLE_PATH", str(REPO_ROOT / "data" / "demo_messages.json"))).expanduser().resolve()
SAMPLE_TRIAGE = SAMPLE_PATH.parent / "announcement_triage" / "triage.json"
DIST_ROOT = APP_ROOT / "dist"


def load_skill_module():
    if not SKILL_SCRIPT.exists():
        raise RuntimeError(f"找不到公告分拣脚本: {SKILL_SCRIPT}")
    spec = importlib.util.spec_from_file_location("attention_triage", SKILL_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("无法载入公告分拣脚本")
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(SKILL_SCRIPT.parent))
    spec.loader.exec_module(module)
    return module


TRIAGE = load_skill_module()
WECHAT = WeChatBridge()
OFFICIAL = OfficialMonitor()
app = FastAPI(title="Attention Desk API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def load_json_bytes(raw: bytes) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8-sig"))
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=400, detail="文件不是 UTF-8 JSON") from exc
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"JSON 格式错误: {exc.msg}") from exc
    if isinstance(value, list):
        return {"contact_display": "上传群聊", "messages": value}
    if not isinstance(value, dict) or not isinstance(value.get("messages"), list):
        raise HTTPException(status_code=400, detail="需要 messages.json 对象，且包含 messages 数组")
    return value


def as_of_date(value: str | None) -> date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date() if value else date.today()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="as_of 必须是 YYYY-MM-DD") from exc


def optional_date(value: str | None, field_name: str) -> date | None:
    if value in (None, ""):
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"{field_name} 必须是 YYYY-MM-DD") from exc


def date_range(from_value: str | None = None, to_value: str | None = None) -> tuple[date | None, date | None]:
    from_date = optional_date(from_value, "from_date")
    to_date = optional_date(to_value, "to_date")
    if from_date and to_date and from_date > to_date:
        raise HTTPException(status_code=400, detail="from_date 不能晚于 to_date")
    return from_date, to_date


def archive_bounds(messages: list[dict[str, Any]]) -> tuple[str | None, str | None]:
    timestamps = [m.get("timestamp") for m in messages if isinstance(m.get("timestamp"), (int, float))]
    if not timestamps:
        return None, None
    return (
        datetime.fromtimestamp(min(timestamps)).date().isoformat(),
        datetime.fromtimestamp(max(timestamps)).date().isoformat(),
    )


def prepare_source(
    source: dict[str, Any],
    from_date: date | None = None,
    to_date: date | None = None,
) -> dict[str, Any]:
    """Apply an inclusive message-date filter before candidate clustering."""
    all_messages = list(source.get("messages") or [])
    if from_date or to_date:
        try:
            selected_messages = TRIAGE.filter_messages_by_date(all_messages, from_date, to_date)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    else:
        selected_messages = all_messages

    archive_start, archive_end = archive_bounds(all_messages)
    selected_start, selected_end = archive_bounds(selected_messages)
    filtered = dict(source)
    filtered["messages"] = selected_messages
    filtered["archive_start"] = archive_start
    filtered["archive_end"] = archive_end
    filtered["selected_start"] = selected_start
    filtered["selected_end"] = selected_end
    filtered["archive_message_count"] = len(all_messages)
    filtered["message_date_filter"] = {
        "from": from_date.isoformat() if from_date else None,
        "to": to_date.isoformat() if to_date else None,
    }
    filtered["file_total"] = sum(1 for message in selected_messages if isinstance(message.get("file"), dict))
    return filtered


def safe_int(value: Any, fallback: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def message_evidence(message: dict[str, Any]) -> dict[str, Any]:
    timestamp = message.get("timestamp", 0)
    try:
        timestamp_text = datetime.fromtimestamp(timestamp).isoformat(sep=" ", timespec="minutes")
    except (TypeError, ValueError, OSError):
        timestamp_text = "时间未知"
    return {
        "id": f"m-{message.get('message_uid', message.get('local_id'))}",
        "timestamp": timestamp_text,
        "sender": message.get("sender", "unknown"),
        "content": str(message.get("content") or "")[:800],
    }


def public_file_meta(message: dict[str, Any], file_meta: dict[str, Any]) -> dict[str, Any]:
    """Expose file inventory without leaking absolute cache paths."""
    size = file_meta.get("size")
    parsed_size = safe_int(size, 0) if size not in (None, "") else None
    return {
        "message_uid": message.get("message_uid", message.get("local_id")),
        "timestamp": message.get("timestamp"),
        "sender": message.get("sender", "unknown"),
        "name": str(file_meta.get("name") or "未命名文件"),
        "extension": str(file_meta.get("extension") or ""),
        "size": parsed_size,
        "md5": file_meta.get("md5"),
        "local_available": bool(file_meta.get("local_path")),
    }


def file_inventory(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    inventory = []
    for message in messages:
        file_meta = message.get("file")
        if isinstance(file_meta, dict):
            inventory.append(public_file_meta(message, file_meta))
    return inventory


def public_export_summary(exported: dict[str, Any]) -> dict[str, Any]:
    source = exported.get("source") or {}
    files = exported.get("files") or []
    return {
        "contact_username": source.get("contact_username"),
        "contact_display": source.get("contact_display"),
        "bundle_dir": source.get("bundle_dir"),
        "source_kind": source.get("source_kind"),
        "source_strategy": source.get("source_strategy"),
        "provider": source.get("provider"),
        "message_count": exported.get("message_count", source.get("total", 0)),
        "file_count": exported.get("file_count", source.get("file_total", 0)),
        "resolved_file_count": sum(1 for item in files if item.get("local_path")),
        "files": [
            public_file_meta(
                {"message_uid": item.get("message_uid"), "timestamp": item.get("timestamp"), "sender": item.get("sender")},
                item,
            )
            for item in files
        ],
    }


def item_evidence(
    item: dict[str, Any],
    candidate_lookup: dict[str, dict[str, Any]],
    message_lookup: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Resolve evidence from source messages, including IDs merged during dedupe."""
    evidence = []
    seen_messages: set[tuple[Any, Any, Any]] = set()
    candidate_ids = item.get("merged_candidate_ids") or [item.get("candidate_id")]
    for candidate_id in candidate_ids:
        candidate = candidate_lookup.get(candidate_id, {})
        for message in candidate.get("messages", []):
            message_key = (message.get("timestamp"), message.get("sender"), message.get("content"))
            if message_key in seen_messages:
                continue
            seen_messages.add(message_key)
            evidence.append(message_evidence(message))
            if len(evidence) >= 6:
                return evidence
    if evidence:
        return evidence

    message_ids = item.get("message_ids", [])
    if message_ids:
        for message_id in message_ids:
            message = message_lookup.get(message_id)
            if message is not None:
                evidence.append(message_evidence(message))
            if len(evidence) >= 6:
                break
    return evidence


def compact_item(
    item: dict[str, Any],
    candidate_lookup: dict[str, dict[str, Any]],
    message_lookup: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    copy = dict(item)
    copy["evidence"] = item_evidence(item, candidate_lookup, message_lookup)
    copy["judgments"] = {
        key: value
        for key, value in item.get("judgments", {}).items()
        if key in {"is_announcement", "record_kind", "category", "audience", "deadline", "action_required", "importance", "urgency", "risk"}
    }
    return copy


def build_summary(
    items: list[dict[str, Any]],
    raw_count: int,
    archive_start: str | None,
    archive_end: str | None,
    as_of: date,
    total_messages: int,
) -> dict[str, Any]:
    category_counts = Counter(item["judgments"]["category"]["value"] for item in items)
    priority_counts = Counter(item["decision"]["priority"] for item in items)
    deadline_status_counts = Counter(item["decision"].get("deadline_status", "unknown") for item in items)
    queue_state_counts = Counter(item["decision"].get("queue_state", "active") for item in items)
    archive_reason_counts = Counter(
        item["decision"].get("archive_reason")
        for item in items
        if item["decision"].get("queue_state") == "archived"
    )
    return {
        "raw_candidate_count": raw_count,
        "candidate_count": len(items),
        "priority_counts": dict(priority_counts),
        "category_counts": dict(category_counts),
        "deadline_status_counts": dict(deadline_status_counts),
        "queue_state_counts": dict(queue_state_counts),
        "archive_reason_counts": dict(archive_reason_counts),
        "active_count": queue_state_counts.get("active", 0),
        "archived_count": queue_state_counts.get("archived", 0),
        "completed_count": archive_reason_counts.get("completed", 0),
        "overdue_count": archive_reason_counts.get("deadline_passed", 0),
        "needs_review_count": sum(1 for item in items if item["decision"].get("queue_state", "active") == "active" and item["decision"].get("needs_review")),
        "deduplicated_count": max(0, raw_count - len(items)),
        "archive_stale": bool(archive_end and archive_end < as_of.isoformat()),
        "visible_count": 0,
        "total_messages": total_messages,
    }


def make_result(
    source: dict[str, Any],
    all_items: list[dict[str, Any]],
    raw_count: int,
    as_of: date,
    provider: dict[str, Any],
    candidate_lookup: dict[str, dict[str, Any]],
    visible_limit: int = 2500,
) -> dict[str, Any]:
    messages = source.get("messages", [])
    files = file_inventory(messages)
    archive_start = source.get("archive_start") or archive_bounds(messages)[0]
    archive_end = source.get("archive_end") or archive_bounds(messages)[1]
    selected_start = source.get("selected_start") or archive_bounds(messages)[0]
    selected_end = source.get("selected_end") or archive_bounds(messages)[1]
    message_lookup = {
        f"m-{message.get('message_uid', message.get('local_id'))}": message
        for message in messages
        if message.get("local_id") is not None
    }
    classified = apply_completions(
        {**source, "archive_start": archive_start}, all_items, load_completions()
    )
    compacted = [compact_item(item, candidate_lookup, message_lookup) for item in classified]
    visible = compacted[:visible_limit]
    summary = build_summary(classified, raw_count, archive_start, archive_end, as_of, len(messages))
    summary["visible_count"] = len(visible)
    return {
        "schema_version": "1.1",
        "algorithm_version": getattr(TRIAGE, "ALGORITHM_VERSION", "unknown"),
        "architecture": "jev-style",
        "provider": provider,
        "source": {
            "conversation": source.get("contact_display") or "上传群聊",
            "input": source.get("bundle_dir") or "uploaded messages.json",
            "source_kind": source.get("source_kind", "file"),
            "file_count": len(files),
            "files": files,
            "as_of": as_of.isoformat(),
            "archive_start": archive_start,
            "archive_end": archive_end,
            "selected_start": selected_start,
            "selected_end": selected_end,
            "archive_message_count": safe_int(source.get("archive_message_count"), len(messages)),
            "message_count": len(messages),
            "message_date_filter": source.get("message_date_filter") or {"from": None, "to": None},
        },
        "summary": summary,
        "items": visible,
        "pagination": {"returned": len(visible), "total": len(compacted), "truncated": len(compacted) > len(visible)},
    }


def local_items(source: dict[str, Any], as_of: date) -> tuple[list[dict[str, Any]], int, dict[str, dict[str, Any]]]:
    messages = source.get("messages", [])
    candidates = TRIAGE.cluster_candidates(messages)
    candidate_lookup = {candidate["candidate_id"]: candidate for candidate in candidates}
    raw_items = [TRIAGE.reduce_priority(TRIAGE.judge_candidate(candidate, as_of), as_of) for candidate in candidates]
    items = TRIAGE.dedupe_items(raw_items)
    items.sort(key=TRIAGE.sort_key)
    return items, len(raw_items), candidate_lookup


def load_cached_sample(
    as_of: date,
    from_date: date | None = None,
    to_date: date | None = None,
) -> dict[str, Any] | None:
    if from_date or to_date:
        return None
    if not SAMPLE_TRIAGE.exists() or not SAMPLE_PATH.exists():
        return None
    try:
        cached = json.loads(SAMPLE_TRIAGE.read_text(encoding="utf-8"))
        if cached.get("source", {}).get("as_of") != as_of.isoformat():
            return None
        if cached.get("algorithm_version") != getattr(TRIAGE, "ALGORITHM_VERSION", None):
            return None
        source = prepare_source(json.loads(SAMPLE_PATH.read_text(encoding="utf-8")))
        candidates = TRIAGE.cluster_candidates(source.get("messages", []))
        candidate_lookup = {candidate["candidate_id"]: candidate for candidate in candidates}
        return make_result(
            source,
            cached.get("items", []),
            cached.get("summary", {}).get("raw_candidate_count", len(cached.get("items", []))),
            as_of,
            {"kind": "local", "label": "本地 Jev 基线", "calls": 0, "fallbacks": 0},
            candidate_lookup,
        )
    except (OSError, json.JSONDecodeError, KeyError, TypeError):
        return None


def question_payload(
    candidate: dict[str, Any],
    source: dict[str, Any],
    as_of: date,
    model: str = "jev-system-one",
) -> dict[str, Any]:
    # Keep the shared state structured.  The model sees only this candidate's
    # immutable evidence, while the reducer and DDL parser remain local.
    state = {
        "source": {
            "conversation": source.get("contact_display") or "上传群聊",
            "as_of": as_of.isoformat(),
            "source_kind": source.get("source_kind", "file"),
            "message_date_filter": source.get("message_date_filter") or {"from": None, "to": None},
        },
        "candidate": {
            "candidate_id": candidate.get("candidate_id"),
            "text": candidate.get("text", ""),
            "message_ids": [
                TRIAGE.evidence_id(message) if hasattr(TRIAGE, "evidence_id") else f"m-{message.get('message_uid', message.get('local_id'))}"
                for message in candidate.get("messages", [])
            ],
        },
        "messages": [
            {
                "id": TRIAGE.evidence_id(message) if hasattr(TRIAGE, "evidence_id") else f"m-{message.get('message_uid', message.get('local_id'))}",
                "timestamp": message.get("timestamp"),
                "sender": message.get("sender", "unknown"),
                "content": str(message.get("content") or ""),
                "type": message.get("type", "text"),
            }
            for message in candidate.get("messages", [])
        ],
        "instruction": "只依据候选消息判断，不补造缺失日期；返回窄的 typed judgments，不要改写最终优先级。",
    }
    categories = ["course", "assignment", "exam", "activity", "admin", "safety", "employment", "resource", "noise", "other"]
    record_kinds = ["announcement", "resource", "conversation", "noise", "other"]
    return {
        "protocol": "jev-typed-judgments-v1",
        "model": model or "jev-system-one",
        "state": state,
        "questions": {
            "is_announcement": {"type": "noul"},
            "record_kind": {"type": "choice", "options": record_kinds},
            "category": {"type": "choice", "options": categories},
            "audience": {"type": "choice", "options": ["all", "subgroup", "volunteers", "unknown"]},
            "action_required": {"type": "noul"},
            "importance": {"type": "score", "criteria": ["0-20: reference/noise", "21-40: useful but low consequence", "41-60: important", "61-80: high importance", "81-100: critical"]},
            "risk": {"type": "score", "criteria": ["0-20: no special risk", "21-40: mild review", "41-60: sensitive", "61-80: high review", "81-100: safety/payment/identity risk"]},
        },
    }


def unwrap_answer(answer: Any) -> dict[str, Any]:
    if isinstance(answer, dict):
        for key in ("answer", "result", "output"):
            nested = answer.get(key)
            if isinstance(nested, dict):
                merged = dict(answer)
                merged.update(nested)
                return merged
        return answer
    return {"value": answer}


def confidence_of(answer: dict[str, Any], fallback: float = 0.55) -> float:
    raw = answer.get("confidence", answer.get("probability"))
    if isinstance(raw, dict):
        raw = max(raw.values()) if raw else None
    try:
        value = float(raw)
        return max(0.0, min(1.0, value if value <= 1 else value / 100))
    except (TypeError, ValueError):
        return fallback


def noul_probability(answer: dict[str, Any]) -> float | None:
    for key in ("probability", "p_yes", "yes_probability", "noul", "score", "value"):
        value = answer.get(key)
        if isinstance(value, dict):
            for nested_key in ("yes", "true", "positive"):
                if nested_key in value:
                    value = value[nested_key]
                    break
        try:
            number = float(value)
            if number > 1:
                number /= 100
            if 0 <= number <= 1:
                return number
        except (TypeError, ValueError):
            continue
    return None


def choice_value(answer: dict[str, Any]) -> str | None:
    for key in ("choice", "selected", "value", "answer"):
        value = answer.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def score_value(answer: dict[str, Any]) -> float | None:
    for key in ("score", "value", "rating", "answer"):
        value = answer.get(key)
        try:
            score = float(value)
        except (TypeError, ValueError):
            continue
        if score <= 1:
            score *= 100
        elif score <= 5:
            score = (score - 1) * 25
        elif score <= 10:
            score *= 10
        return max(0.0, min(100.0, score))
    return None


def extract_answers(payload: dict[str, Any]) -> dict[str, Any]:
    for key in ("answers", "results", "decisions"):
        value = payload.get(key)
        if isinstance(value, dict):
            return value
    data = payload.get("data")
    if isinstance(data, dict):
        for key in ("answers", "results", "decisions"):
            if isinstance(data.get(key), dict):
                return data[key]
    return payload


async def call_jev(endpoint: str, api_key: str, payload: dict[str, Any]) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=45) as client:
        response = await client.post(endpoint, headers=headers, json=payload)
    if response.status_code >= 400:
        detail = response.text[:500].replace(api_key, "[redacted]")
        raise RuntimeError(f"Jev API {response.status_code}: {detail}")
    body = response.json()
    if not isinstance(body, dict):
        raise RuntimeError("Jev API 返回不是 JSON 对象")
    return body


def apply_jev_answers(base: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    answers = extract_answers(payload)
    judgments = base["judgments"]
    allowed_choices = {
        "record_kind": {"announcement", "resource", "conversation", "noise", "other"},
        "category": {"course", "assignment", "exam", "activity", "admin", "safety", "employment", "resource", "noise", "other"},
        "audience": {"all", "subgroup", "volunteers", "unknown"},
    }
    accepted: list[str] = []
    rejected: list[str] = []
    ignored: list[str] = []

    def baseline_for(key: str) -> None:
        judgment = judgments.get(key)
        if judgment is None:
            return
        judgment.setdefault("baseline", {
            "value": judgment.get("value"),
            "confidence": judgment.get("confidence"),
            "reason": judgment.get("reason"),
        })

    for key, answer_raw in answers.items():
        if key not in judgments:
            continue
        # DDL and urgency are application-owned.  A remote model may discuss
        # them in free text, but it cannot overwrite the deterministic parser.
        if key in {"deadline", "urgency"}:
            ignored.append(key)
            continue
        answer = unwrap_answer(answer_raw)
        conf = confidence_of(answer, fallback=0.0)
        threshold = 0.72 if key in {"is_announcement", "record_kind", "category", "audience"} else 0.68
        if conf < threshold:
            rejected.append(f"{key}:low_confidence")
            continue
        baseline_for(key)
        if key in {"is_announcement", "action_required"}:
            probability = noul_probability(answer)
            if probability is None:
                rejected.append(f"{key}:invalid_probability")
                continue
            value = probability >= 0.5
            if key == "is_announcement":
                local_kind = judgments.get("record_kind", {}).get("value")
                # A model is allowed to demote an uncertain local candidate,
                # but it cannot promote a resource/conversation into an
                # announcement without a local structural signal.
                if value and local_kind != "announcement":
                    rejected.append(f"{key}:local_gate")
                    continue
            judgments[key]["value"] = value
            judgments[key]["confidence"] = max(conf, abs(probability - 0.5) * 2)
            judgments[key]["probabilities"] = {"true": probability, "false": 1 - probability}
            judgments[key]["answer_type"] = "Noul"
            judgments[key]["reason"] = f"Jev Noul 概率 {probability:.0%}"
            if key == "action_required":
                kind = "required" if probability >= 0.65 else "optional" if probability >= 0.4 else "informational"
                judgments[key]["metadata"] = {"kind": kind, "signals": ["jev"]}
            accepted.append(key)
        elif key in {"category", "audience"}:
            value = choice_value(answer)
            if value is None or value not in allowed_choices[key]:
                rejected.append(f"{key}:invalid_choice")
                continue
            judgments[key]["value"] = value
            judgments[key]["confidence"] = conf
            judgments[key]["probabilities"] = {value: conf}
            judgments[key]["answer_type"] = "Choice"
            judgments[key]["reason"] = f"Jev Choice → {value}"
            accepted.append(key)
        elif key == "record_kind":
            value = choice_value(answer)
            if value is None or value not in allowed_choices[key]:
                rejected.append(f"{key}:invalid_choice")
                continue
            local_kind = judgments.get("record_kind", {}).get("value")
            if value == "announcement" and local_kind != "announcement":
                rejected.append(f"{key}:local_gate")
                continue
            judgments[key]["value"] = value
            judgments[key]["confidence"] = conf
            judgments[key]["probabilities"] = {value: conf}
            judgments[key]["answer_type"] = "Choice"
            judgments[key]["reason"] = f"Jev Choice → {value}（本地结构门控通过）"
            if "is_announcement" in judgments:
                judgments["is_announcement"]["value"] = value == "announcement"
                judgments["is_announcement"]["metadata"] = {"record_kind": value, "source": "jev"}
            accepted.append(key)
        elif key in {"importance", "risk"}:
            value = score_value(answer)
            if value is None:
                rejected.append(f"{key}:invalid_score")
                continue
            judgments[key]["value"] = round(value)
            judgments[key]["confidence"] = conf
            judgments[key]["probabilities"] = {"score": conf}
            judgments[key]["answer_type"] = "Score"
            judgments[key]["reason"] = f"Jev Score → {round(value)}/100"
            accepted.append(key)
    base["provider_trace"] = {
        "kind": "jev",
        "typed_answers": list(answers.keys()),
        "accepted": accepted,
        "rejected": rejected,
        "ignored_application_owned": ignored,
    }
    return base


async def jev_items(
    source: dict[str, Any],
    as_of: date,
    endpoint: str,
    api_key: str,
    max_candidates: int,
    model: str = "jev-system-one",
) -> tuple[list[dict[str, Any]], int, dict[str, dict[str, Any]], dict[str, Any]]:
    messages = source.get("messages", [])
    candidates = TRIAGE.cluster_candidates(messages)
    candidate_lookup = {candidate["candidate_id"]: candidate for candidate in candidates}
    baselines = [TRIAGE.reduce_priority(TRIAGE.judge_candidate(candidate, as_of), as_of) for candidate in candidates]
    baselines.sort(key=TRIAGE.sort_key)
    # Remote Jev is a second opinion for structurally plausible announcements,
    # not a bulk classifier for every resource and chat reply.  Keep uncertain
    # announcement candidates eligible while leaving clear resources local.
    eligible = [
        item for item in baselines
        if item["judgments"].get("record_kind", {}).get("value") == "announcement"
        or item["judgments"].get("record_kind", {}).get("confidence", 0) < 0.72
    ]
    selected_ids = {
        item["candidate_id"] for item in eligible[: max(1, min(max_candidates, 160))]
    }
    by_id = {item["candidate_id"]: item for item in baselines}
    semaphore = asyncio.Semaphore(5)
    calls = 0
    fallbacks = 0
    errors: list[str] = []

    async def enrich(item: dict[str, Any]) -> None:
        nonlocal calls, fallbacks
        candidate = candidate_lookup[item["candidate_id"]]
        try:
            async with semaphore:
                response = await call_jev(endpoint, api_key, question_payload(candidate, source, as_of, model))
            calls += 1
            apply_jev_answers(item, response)
            TRIAGE.reduce_priority(item, as_of)
        except Exception as exc:
            fallbacks += 1
            errors.append(f"{item['candidate_id']}: {str(exc)[:180]}")
            item["provider_trace"] = {"kind": "local-fallback", "error": str(exc)[:180]}

    await asyncio.gather(*(enrich(by_id[candidate_id]) for candidate_id in selected_ids))
    items = TRIAGE.dedupe_items(list(by_id.values()))
    items.sort(key=TRIAGE.sort_key)
    return items, len(baselines), candidate_lookup, {
        "kind": "jev",
        "label": "TypeSafe Jev / 自定义 Jev",
        "endpoint": f"{urlparse(endpoint).scheme}://{urlparse(endpoint).netloc}{urlparse(endpoint).path}",
        "calls": calls,
        "fallbacks": fallbacks,
        "max_candidates": len(selected_ids),
        "algorithm_version": getattr(TRIAGE, "ALGORITHM_VERSION", "unknown"),
        "errors": errors[:8],
    }


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "sample_available": SAMPLE_PATH.exists(),
        "skill_available": SKILL_SCRIPT.exists(),
        "algorithm_version": getattr(TRIAGE, "ALGORITHM_VERSION", "unknown"),
        "wechat_ready": WECHAT.status().get("ready", False),
    }


@app.post("/api/items/completion")
def complete_item(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        return set_completion(payload.get("item_key", ""), payload.get("completed"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/official/overview")
def official_overview() -> dict[str, Any]:
    return OFFICIAL.overview()


@app.post("/api/official/scan")
def official_scan(payload: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:
    source_ids = payload.get("source_ids")
    if source_ids is not None and (not isinstance(source_ids, list) or not all(isinstance(value, str) for value in source_ids)):
        raise HTTPException(status_code=400, detail="source_ids 必须是学院 ID 数组")
    try:
        return OFFICIAL.start_scan(source_ids)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/official/read")
def official_set_read(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    try:
        count = OFFICIAL.set_read(
            str(payload["source_id"]) if payload.get("source_id") else None,
            str(payload["url"]) if payload.get("url") else None,
            payload.get("read"),
        )
        return {"updated_count": count}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/official/settings")
def official_settings(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    hours = payload.get("auto_interval_hours")
    if type(hours) is not int:
        raise HTTPException(status_code=400, detail="auto_interval_hours 必须是整数")
    try:
        OFFICIAL.set_interval(hours)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"auto_interval_hours": hours}


@app.get("/api/wechat/status")
def wechat_status() -> dict[str, Any]:
    """Report local read-only WeChat availability without exposing raw paths."""
    return WECHAT.status()


@app.get("/api/wechat/groups")
def wechat_groups(q: str = "", limit: int = 80) -> dict[str, Any]:
    status = WECHAT.status()
    if not status.get("ready"):
        exporter = status.get("exporter") or {}
        if exporter.get("install_hint"):
            raise HTTPException(status_code=503, detail=f"微信数据源未就绪；{exporter['install_hint']}")
        raise HTTPException(status_code=503, detail="本机微信数据源不可读")
    return {"groups": WECHAT.groups(q, limit), "query": q, "read_only": True}


@app.post("/api/wechat/export")
def wechat_export(payload: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:
    identifier = payload.get("username") or payload.get("display_name") or payload.get("group")
    if not isinstance(identifier, str) or not identifier.strip():
        raise HTTPException(status_code=400, detail="需要 username 或 display_name")
    status = WECHAT.status()
    if not status.get("ready"):
        raise HTTPException(status_code=503, detail="本机微信解密数据库尚未准备好")
    try:
        exported = WECHAT.export_group(
            identifier.strip(),
            resolve_files=bool(payload.get("resolve_files", False)),
        )
    except (ValueError, RuntimeError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    export_public = public_export_summary(exported)
    return {
        "status": "ok",
        "source": export_public,
        "messages_path": exported["messages_path"],
        "files_path": exported["files_path"],
        "message_count": exported["message_count"],
        "file_count": exported["file_count"],
        "resolved_file_count": export_public["resolved_file_count"],
        "files": export_public["files"],
        "refresh": exported.get("refresh"),
        "read_only": True,
    }


@app.post("/api/wechat/analyze")
async def wechat_analyze(payload: dict[str, Any] = Body(default_factory=dict)) -> JSONResponse:
    identifier = payload.get("username") or payload.get("display_name") or payload.get("group")
    if not isinstance(identifier, str) or not identifier.strip():
        raise HTTPException(status_code=400, detail="需要 username 或 display_name")
    status = WECHAT.status()
    if not status.get("ready"):
        raise HTTPException(status_code=503, detail="本机微信解密数据库尚未准备好")
    try:
        exported = await run_in_threadpool(
            WECHAT.export_group,
            identifier.strip(),
            resolve_files=bool(payload.get("resolve_files", False)),
        )
    except (ValueError, RuntimeError, OSError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    from_date, to_date = date_range(payload.get("from_date"), payload.get("to_date"))
    source = prepare_source(exported["source"], from_date, to_date)
    source["source_kind"] = "wechat-local"
    target_date = as_of_date(payload.get("as_of"))
    provider = str(payload.get("provider") or "local").strip().lower()
    if provider == "local":
        items, raw_count, lookup = local_items(source, target_date)
        result = make_result(
            source,
            items,
            raw_count,
            target_date,
            {"kind": "local", "label": "本地 Jev 基线", "calls": 0, "fallbacks": 0, "read_only_import": True},
            lookup,
        )
        export_public = public_export_summary(exported)
        result["source_export"] = {
            "messages_path": exported["messages_path"],
            "files_path": exported["files_path"],
            "file_count": exported["file_count"],
            "resolved_file_count": export_public["resolved_file_count"],
            "files": export_public["files"],
            "refresh": exported.get("refresh"),
        }
        return JSONResponse(result)

    api_key = str(payload.get("api_key") or "").strip()
    endpoint = str(payload.get("endpoint") or "https://api.typesafe.ai/v1/systemone").strip()
    if not api_key:
        raise HTTPException(status_code=400, detail="Jev 模式需要 API key；本地微信导入本身不需要")
    if not endpoint.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="endpoint 必须是 http:// 或 https:// 地址")
    limit = max(1, min(safe_int(payload.get("max_candidates"), 48), 160))
    selected_model = str(payload.get("model") or "jev-system-one")
    items, raw_count, lookup, provider_meta = await jev_items(source, target_date, endpoint, api_key, limit, selected_model)
    provider_meta["model"] = selected_model
    provider_meta["read_only_import"] = True
    result = make_result(source, items, raw_count, target_date, provider_meta, lookup)
    export_public = public_export_summary(exported)
    result["source_export"] = {
        "messages_path": exported["messages_path"],
        "files_path": exported["files_path"],
        "file_count": exported["file_count"],
        "resolved_file_count": export_public["resolved_file_count"],
        "files": export_public["files"],
    }
    return JSONResponse(result)


@app.get("/api/sample")
def sample(
    as_of: str | None = None,
    from_date: str | None = None,
    to_date: str | None = None,
) -> dict[str, Any]:
    target_date = as_of_date(as_of)
    start_date, end_date = date_range(from_date, to_date)
    cached = load_cached_sample(target_date, start_date, end_date)
    if cached:
        return cached
    if not SAMPLE_PATH.exists():
        raise HTTPException(status_code=404, detail="未找到演示数据；请上传 messages.json 或配置 ATTENTION_SAMPLE_PATH")
    source = prepare_source(json.loads(SAMPLE_PATH.read_text(encoding="utf-8")), start_date, end_date)
    items, raw_count, lookup = local_items(source, target_date)
    return make_result(source, items, raw_count, target_date, {"kind": "local", "label": "本地 Jev 基线", "calls": 0, "fallbacks": 0}, lookup)


@app.post("/api/analyze")
async def analyze(
    file: UploadFile | None = File(default=None),
    provider: str = Form(default="local"),
    api_key: str = Form(default=""),
    endpoint: str = Form(default="https://api.typesafe.ai/v1/systemone"),
    model: str = Form(default="jev-system-one"),
    as_of: str | None = Form(default=None),
    from_date: str | None = Form(default=None),
    to_date: str | None = Form(default=None),
    max_candidates: str = Form(default="48"),
    use_sample: str = Form(default="true"),
) -> JSONResponse:
    target_date = as_of_date(as_of)
    start_date, end_date = date_range(from_date, to_date)
    if file is not None:
        source = load_json_bytes(await file.read())
    elif use_sample.lower() == "true" and SAMPLE_PATH.exists():
        source = json.loads(SAMPLE_PATH.read_text(encoding="utf-8"))
    else:
        raise HTTPException(status_code=400, detail="请选择 messages.json 文件")

    source = prepare_source(source, start_date, end_date)

    normalized_provider = (provider or "local").strip().lower()
    if normalized_provider == "local":
        cached = load_cached_sample(target_date, start_date, end_date) if file is None else None
        if cached:
            return JSONResponse(cached)
        items, raw_count, lookup = local_items(source, target_date)
        result = make_result(source, items, raw_count, target_date, {"kind": "local", "label": "本地 Jev 基线", "calls": 0, "fallbacks": 0}, lookup)
        return JSONResponse(result)

    if not api_key.strip():
        raise HTTPException(status_code=400, detail="Jev 模式需要 API key；本地模式不需要")
    if not endpoint.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="endpoint 必须是 http:// 或 https:// 地址")
    limit = max(1, min(safe_int(max_candidates, 48), 160))
    selected_model = model.strip() or "jev-system-one"
    items, raw_count, lookup, provider_meta = await jev_items(source, target_date, endpoint.strip(), api_key.strip(), limit, selected_model)
    provider_meta["model"] = selected_model
    result = make_result(source, items, raw_count, target_date, provider_meta, lookup)
    return JSONResponse(result)


if DIST_ROOT.exists():
    @app.get("/{path:path}")
    def frontend(path: str):
        requested = (DIST_ROOT / path).resolve()
        if requested.is_file() and str(requested).startswith(str(DIST_ROOT.resolve())):
            return FileResponse(requested)
        return FileResponse(DIST_ROOT / "index.html")
