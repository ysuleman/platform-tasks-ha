"""sensor.platform_tasks_upcoming — feeds the countdown Lovelace card."""
from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, UPCOMING_WINDOW_DAYS
from .coordinator import PlatformTasksCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: PlatformTasksCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([UpcomingTasksSensor(coordinator, entry)])


class UpcomingTasksSensor(CoordinatorEntity[PlatformTasksCoordinator], SensorEntity):
    """Single sensor exposing the rolling upcoming + overdue task list."""

    _attr_has_entity_name = False
    _attr_icon = "mdi:calendar-clock"
    _attr_name = "Platform Tasks Upcoming"

    def __init__(self, coordinator: PlatformTasksCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry.entry_id}_upcoming"
        self.entity_id = "sensor.platform_tasks_upcoming"

    @property
    def native_value(self) -> int:
        return len(self.coordinator.data.upcoming)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        upcoming = self.coordinator.data.upcoming
        return {
            "tasks": upcoming,
            "overdue_count": sum(1 for t in upcoming if t["is_overdue"]),
            "today_count": sum(1 for t in upcoming if t["is_today"]),
            "window_days": UPCOMING_WINDOW_DAYS,
        }
