"""TodoListEntity per project — full add / update / complete / delete loop."""
from __future__ import annotations

from datetime import date, datetime, timezone
import logging
from typing import Any

import aiohttp
from homeassistant.components.todo import (
    TodoItem,
    TodoItemStatus,
    TodoListEntity,
    TodoListEntityFeature,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.util import slugify

from .const import DOMAIN
from .coordinator import PlatformTasksCoordinator

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: PlatformTasksCoordinator = hass.data[DOMAIN][entry.entry_id]

    known: dict[str, PlatformTaskList] = {}

    @callback
    def _sync_entities() -> None:
        new: list[PlatformTaskList] = []
        seen: set[str] = set()
        for project in coordinator.data.projects:
            pid = project["id"]
            seen.add(pid)
            if pid in known:
                continue
            entity = PlatformTaskList(coordinator, entry, project)
            known[pid] = entity
            new.append(entity)
        if new:
            async_add_entities(new)
        # Note: we don't tear down entities for vanished projects on the fly
        # here — HA's entity registry persists them and a reload of the
        # integration removes any stale ones. Keeps state-machine simple.

    _sync_entities()
    entry.async_on_unload(coordinator.async_add_listener(_sync_entities))


def _to_status(task: dict[str, Any]) -> TodoItemStatus:
    return TodoItemStatus.COMPLETED if task.get("status") == 2 else TodoItemStatus.NEEDS_ACTION


def _to_due(task: dict[str, Any]) -> date | datetime | None:
    iso = task.get("dueDate") or task.get("startDate")
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    if task.get("isAllDay"):
        return dt.date()
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


class PlatformTaskList(CoordinatorEntity[PlatformTasksCoordinator], TodoListEntity):
    """One TodoListEntity per platform project."""

    _attr_supported_features = (
        TodoListEntityFeature.CREATE_TODO_ITEM
        | TodoListEntityFeature.UPDATE_TODO_ITEM
        | TodoListEntityFeature.DELETE_TODO_ITEM
        | TodoListEntityFeature.SET_DUE_DATE_ON_ITEM
        | TodoListEntityFeature.SET_DUE_DATETIME_ON_ITEM
        | TodoListEntityFeature.SET_DESCRIPTION_ON_ITEM
    )
    _attr_has_entity_name = False

    def __init__(
        self,
        coordinator: PlatformTasksCoordinator,
        entry: ConfigEntry,
        project: dict[str, Any],
    ) -> None:
        super().__init__(coordinator)
        self._project_id: str = project["id"]
        self._attr_unique_id = f"{entry.entry_id}_{project['id']}"
        # Fixed entity_id slug so card configs are stable even if the project
        # is renamed in the platform later.
        self._attr_name = f"Platform: {project.get('name', 'Untitled')}"
        self.entity_id = f"todo.platform_{slugify(project.get('name') or project['id'])}"

    @property
    def project(self) -> dict[str, Any] | None:
        for p in self.coordinator.data.projects:
            if p["id"] == self._project_id:
                return p
        return None

    @property
    def todo_items(self) -> list[TodoItem] | None:
        tasks = self.coordinator.data.tasks_by_project.get(self._project_id, [])
        items: list[TodoItem] = []
        for t in tasks:
            items.append(
                TodoItem(
                    summary=t.get("title") or "(no title)",
                    uid=t.get("id"),
                    status=_to_status(t),
                    due=_to_due(t),
                    description=t.get("content") or None,
                )
            )
        return items

    # ── Mutations ────────────────────────────────────────────────────

    async def async_create_todo_item(self, item: TodoItem) -> None:
        try:
            await self.coordinator.create_task(
                project_id=self._project_id,
                title=item.summary or "(no title)",
                due=item.due,
            )
        except aiohttp.ClientResponseError as err:
            _LOGGER.error("create_todo_item failed: HTTP %s %s", err.status, err.message)
            raise
        await self.coordinator.async_request_refresh()

    async def async_update_todo_item(self, item: TodoItem) -> None:
        if not item.uid:
            return
        # Completion is its own endpoint (server spawns next recurrence).
        if item.status == TodoItemStatus.COMPLETED:
            try:
                await self.coordinator.complete_task(item.uid)
            except aiohttp.ClientResponseError as err:
                _LOGGER.error("complete_task failed: HTTP %s %s", err.status, err.message)
                raise
            await self.coordinator.async_request_refresh()
            return

        body: dict[str, Any] = {}
        if item.summary is not None:
            body["title"] = item.summary
        if item.description is not None:
            body["content"] = item.description
        if item.due is not None:
            if isinstance(item.due, datetime):
                d = item.due if item.due.tzinfo else item.due.astimezone()
                body["dueDate"] = d.isoformat()
                body["isAllDay"] = False
            else:
                body["dueDate"] = datetime(item.due.year, item.due.month, item.due.day, tzinfo=timezone.utc).isoformat()
                body["isAllDay"] = True
        if not body:
            return
        try:
            await self.coordinator.update_task(item.uid, body)
        except aiohttp.ClientResponseError as err:
            _LOGGER.error("update_todo_item failed: HTTP %s %s", err.status, err.message)
            raise
        await self.coordinator.async_request_refresh()

    async def async_delete_todo_items(self, uids: list[str]) -> None:
        for uid in uids:
            try:
                await self.coordinator.delete_task(uid)
            except aiohttp.ClientResponseError as err:
                _LOGGER.error("delete_task failed: HTTP %s %s", err.status, err.message)
                raise
        await self.coordinator.async_request_refresh()
