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
    UPCOMING_WINDOW_DAYS,
)

_LOGGER = logging.getLogger(__name__)


@dataclass
class CoordinatorData:
    """Snapshot of platform state shared between todo + sensor entities."""

    projects: list[dict[str, Any]] = field(default_factory=list)
    tasks_by_project: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    upcoming: list[dict[str, Any]] = field(default_factory=list)


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
        try:
            projects_resp, all_resp = await asyncio.gather(
                self._get(PATH_PROJECTS),
                self._get(PATH_SMART_ALL),
            )
        except aiohttp.ClientResponseError as err:
            raise UpdateFailed(f"HTTP {err.status} from platform: {err.message}") from err
        except aiohttp.ClientError as err:
            raise UpdateFailed(f"Network error: {err}") from err

        projects = projects_resp.get("projects", []) if isinstance(projects_resp, dict) else []
        all_tasks = all_resp.get("tasks", []) if isinstance(all_resp, dict) else []

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
        )

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
        cutoff = today + timedelta(days=UPCOMING_WINDOW_DAYS)
        out: list[dict[str, Any]] = []

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
            if due_date > cutoff:
                continue

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
            })

        out.sort(key=lambda x: (x["due_date"], x["title"].lower()))
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
            body["dueDate"] = datetime(due.year, due.month, due.day, tzinfo=timezone.utc).isoformat()
            body["isAllDay"] = True
        return await self._post(PATH_TASKS, body)

    async def update_task(self, task_id: str, body: dict[str, Any]) -> dict[str, Any]:
        return await self._patch(PATH_TASK.format(id=task_id), body)

    async def complete_task(self, task_id: str) -> dict[str, Any]:
        return await self._post(PATH_TASK_COMPLETE.format(id=task_id))

    async def delete_task(self, task_id: str) -> None:
        await self._delete(PATH_TASK.format(id=task_id))
