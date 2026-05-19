"""Data coordinator for Platform Tasks — polls projects + tasks every 60s."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
import logging
from typing import Any

import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed
from homeassistant.util import dt as dt_util

from .const import (
    CONF_BASE_URL,
    CONF_TOKEN,
    DEFAULT_SCAN_INTERVAL_SECONDS,
    DOMAIN,
    PATH_PROJECTS,
    PATH_SMART_ALL,
    PATH_TASK,
    PATH_TASK_COMPLETE,
    PATH_TASKS,
    PATH_USERS,
    UPCOMING_WINDOW_DAYS,
)
from .parser import parse_quick_add

_LOGGER = logging.getLogger(__name__)


@dataclass
class CoordinatorData:
    """Snapshot of platform state shared between todo + sensor entities."""

    projects: list[dict[str, Any]] = field(default_factory=list)
    tasks_by_project: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    upcoming: list[dict[str, Any]] = field(default_factory=list)
    users: list[dict[str, Any]] = field(default_factory=list)


class PlatformTasksCoordinator(DataUpdateCoordinator[CoordinatorData]):
    """Owns the HTTP client and the polled snapshot."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=timedelta(seconds=DEFAULT_SCAN_INTERVAL_SECONDS),
        )
        self.entry = entry
        self._base_url: str = entry.data[CONF_BASE_URL].rstrip("/")
        self._token: str = entry.data[CONF_TOKEN]
        self._session: aiohttp.ClientSession = async_get_clientsession(hass)

    @property
    def base_url(self) -> str:
        return self._base_url

    # ── HTTP helpers ──────────────────────────────────────────────────

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/json",
        }

    async def _get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        url = f"{self._base_url}{path}"
        async with self._session.get(url, headers=self._headers(), params=params, timeout=aiohttp.ClientTimeout(total=20)) as resp:
            resp.raise_for_status()
            return await resp.json()

    async def _post(self, path: str, body: dict[str, Any] | None = None) -> Any:
        url = f"{self._base_url}{path}"
        async with self._session.post(url, headers=self._headers(), json=body, timeout=aiohttp.ClientTimeout(total=20)) as resp:
            resp.raise_for_status()
            if resp.status == 204:
                return None
            try:
                return await resp.json()
            except aiohttp.ContentTypeError:
                return None

    async def _patch(self, path: str, body: dict[str, Any]) -> Any:
        url = f"{self._base_url}{path}"
        async with self._session.patch(url, headers=self._headers(), json=body, timeout=aiohttp.ClientTimeout(total=20)) as resp:
            resp.raise_for_status()
            try:
                return await resp.json()
            except aiohttp.ContentTypeError:
                return None

    async def _delete(self, path: str) -> None:
        url = f"{self._base_url}{path}"
        async with self._session.delete(url, headers=self._headers(), timeout=aiohttp.ClientTimeout(total=20)) as resp:
            resp.raise_for_status()

    # ── Coordinator hook ──────────────────────────────────────────────

    async def _async_update_data(self) -> CoordinatorData:
        import asyncio
        # Users endpoint is small + cheap and lets smart_add resolve
        # `@username` chips and trailing-name assignees. We tolerate a
        # failure on it — older platform builds may not expose it yet.
        try:
            projects_resp, all_resp, users_resp = await asyncio.gather(
                self._get(PATH_PROJECTS),
                self._get(PATH_SMART_ALL),
                self._get_or_empty(PATH_USERS),
            )
        except aiohttp.ClientResponseError as err:
            raise UpdateFailed(f"HTTP {err.status} from platform: {err.message}") from err
        except aiohttp.ClientError as err:
            raise UpdateFailed(f"Network error: {err}") from err

        projects = projects_resp.get("projects", []) if isinstance(projects_resp, dict) else []
        all_tasks = all_resp.get("tasks", []) if isinstance(all_resp, dict) else []
        users = users_resp.get("users", []) if isinstance(users_resp, dict) else []

        # Filter out virtual recurring occurrences for the todo entity (v1
        # decision — they don't have stable ids round-trippable to the API).
        # Real tasks only.
        real_tasks = [t for t in all_tasks if not t.get("isVirtual")]

        tasks_by_project: dict[str, list[dict[str, Any]]] = {p["id"]: [] for p in projects}
        for task in real_tasks:
            pid = task.get("projectId")
            if pid in tasks_by_project:
                tasks_by_project[pid].append(task)
            # tasks whose project the user can't see: drop silently.

        upcoming = self._compute_upcoming(real_tasks, projects)

        return CoordinatorData(
            projects=projects,
            tasks_by_project=tasks_by_project,
            upcoming=upcoming,
            users=users,
        )

    async def _get_or_empty(self, path: str) -> dict[str, Any]:
        """Like `_get` but degrades to `{}` on 404 — lets the integration
        keep working against platform builds that haven't shipped a given
        endpoint yet (e.g. `/api/tasks/users` on pre-v0.4.0 deployments)."""
        try:
            return await self._get(path)
        except aiohttp.ClientResponseError as err:
            if err.status == 404:
                _LOGGER.debug("Optional endpoint %s returned 404 — skipping.", path)
                return {}
            raise

    @staticmethod
    def _compute_upcoming(tasks: list[dict[str, Any]], projects: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Build the data feed for the countdown sensor + Lovelace card.

        Includes any open task with a due date inside the next UPCOMING_WINDOW_DAYS,
        plus all overdue tasks. Sorted by due-soonest first.
        """
        from homeassistant.util import slugify

        project_meta = {p["id"]: p for p in projects}
        now = datetime.now(timezone.utc)
        today = now.date()
        out: list[dict[str, Any]] = []

        # Include every open task with a due date, regardless of how far
        # out — the card filters client-side via Today / Tomorrow / 7d / All
        # pills. Overdue tasks always come through.
        for t in tasks:
            due_iso = t.get("dueDate") or t.get("startDate")
            if not due_iso:
                continue
            try:
                due_dt = datetime.fromisoformat(due_iso.replace("Z", "+00:00"))
            except (ValueError, AttributeError):
                continue
            if due_dt.tzinfo is None:
                due_dt = due_dt.replace(tzinfo=timezone.utc)

            due_date = due_dt.astimezone().date()

            days_until = (due_date - today).days
            project = project_meta.get(t.get("projectId"), {})
            project_name = project.get("name") or t.get("_projectName") or ""
            project_slug = slugify(project_name or (t.get("projectId") or ""))
            out.append({
                "id": t.get("id"),
                "title": t.get("title", ""),
                "due_at": due_dt.isoformat(),
                "due_date": due_date.isoformat(),
                "days_until": days_until,
                "is_overdue": days_until < 0,
                "is_today": days_until == 0,
                "is_all_day": bool(t.get("isAllDay", True)),
                "project_id": t.get("projectId"),
                "project_name": project_name,
                "project_color": project.get("color") or t.get("color") or "",
                "project_entity_id": f"todo.platform_{project_slug}" if project_slug else "",
                "is_shared_project": bool(t.get("isSharedProject", False)),
                # Hidden helper for a stable timezone-correct chronological
                # sort below. Stripped before return so the sensor payload
                # stays clean.
                "_sort_ts": due_dt.astimezone(timezone.utc).timestamp(),
                # All-day tasks share a date with timed ones; keep all-day
                # AFTER timed entries on the same day so "8am gym" lands
                # before "(all-day) pay bills". A 1 sorts after 0.
                "_sort_grouped": (due_date.isoformat(), 1 if t.get("isAllDay", True) else 0),
            })

        out.sort(key=lambda x: (x["_sort_grouped"], x["_sort_ts"], x["title"].lower()))
        for row in out:
            row.pop("_sort_ts", None)
            row.pop("_sort_grouped", None)
        return out

    # ── Mutations called by the todo entity ──────────────────────────

    async def create_task(self, project_id: str, title: str, due: date | datetime | None) -> dict[str, Any]:
        body: dict[str, Any] = {"title": title, "projectId": project_id}
        if isinstance(due, datetime):
            if due.tzinfo is None:
                due = due.astimezone()
            body["dueDate"] = due.isoformat()
            body["isAllDay"] = False
        elif isinstance(due, date):
            body["dueDate"] = dt_util.start_of_local_day(due).isoformat()
            body["isAllDay"] = True
        return await self._post(PATH_TASKS, body)

    async def update_task(self, task_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return await self._patch(PATH_TASK.format(id=task_id), body)

    async def complete_task(self, task_id: str) -> dict[str, Any]:
        return await self._post(PATH_TASK_COMPLETE.format(id=task_id))

    async def delete_task(self, task_id: str) -> None:
        await self._delete(PATH_TASK.format(id=task_id))

    async def smart_add(self, text: str, default_project_id: str | None = None) -> dict[str, Any]:
        """Parse a natural-language task input and POST it as a new task.

        Returns the parsed payload alongside the created task. Raises a
        ``ValueError`` if `text` parses to an empty title — the caller
        should surface that to the user rather than silently creating
        an "(no title)" task. HTTP errors bubble up as
        ``aiohttp.ClientResponseError``.
        """
        if not text or not text.strip():
            raise ValueError("Empty input")
        snapshot = self.data
        projects = snapshot.projects if snapshot else []
        users = snapshot.users if snapshot else []
        parsed = parse_quick_add(
            text,
            projects=projects,
            users=users,
            default_project_id=default_project_id,
        )
        if not parsed.title:
            raise ValueError("Parsed title is empty — refine your input.")
        payload = parsed.to_payload()
        _LOGGER.info("smart_add: raw=%r → payload=%s", text, payload)
        task = await self._post(PATH_TASKS, payload)
        await self.async_request_refresh()
        return {
            "task": task,
            "parsed": {
                "title": parsed.title,
                "due_at": parsed.due_at.isoformat() if parsed.due_at else None,
                "is_all_day": parsed.is_all_day,
                "priority": parsed.priority,
                "tags": parsed.tags,
                "project_id": parsed.project_id,
                "project_hint": parsed.project_hint,
                "assignee_user_id": parsed.assignee_user_id,
                "assignee_username": parsed.assignee_username,
                "repeat_flag": parsed.repeat_flag,
            },
        }
