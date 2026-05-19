"""Platform Tasks integration — entry point."""
from __future__ import annotations

import logging
import os

import voluptuous as vol

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN, SERVICE_SMART_ADD
from .coordinator import PlatformTasksCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.TODO, Platform.SENSOR]

# Path the integration uses to expose its bundled frontend assets.
# Bumped per release so browser caches don't serve stale JS after a
# HACS update — querystring change forces a re-fetch.
FRONTEND_VERSION = "0.4.0"
FRONTEND_URL = f"/platform_tasks_static/platform-task-countdown-list-card.js?v={FRONTEND_VERSION}"
FRONTEND_FS_PATH = os.path.join(os.path.dirname(__file__), "frontend")


SMART_ADD_SCHEMA = vol.Schema(
    {
        vol.Required("text"): cv.string,
        vol.Optional("default_project_id"): cv.string,
        vol.Optional("entry_id"): cv.string,
    }
)


async def _ensure_frontend_registered(hass: HomeAssistant) -> None:
    """Idempotently mount the bundled JS so dashboards can reference it.

    The JS file ships inside the integration package, so HACS updates
    automatically deliver new card versions — no /config/www/ drops.
    """
    flag = f"{DOMAIN}_frontend_registered"
    if hass.data.get(flag):
        return
    await hass.http.async_register_static_paths([
        StaticPathConfig(
            "/platform_tasks_static",
            FRONTEND_FS_PATH,
            cache_headers=False,
        )
    ])
    add_extra_js_url(hass, FRONTEND_URL)
    hass.data[flag] = True
    _LOGGER.info("Platform Tasks: registered frontend module at %s", FRONTEND_URL)


def _pick_coordinator(hass: HomeAssistant, entry_id: str | None) -> PlatformTasksCoordinator:
    bucket: dict[str, PlatformTasksCoordinator] = hass.data.get(DOMAIN, {})
    if not bucket:
        raise HomeAssistantError("Platform Tasks is not configured yet.")
    if entry_id:
        coord = bucket.get(entry_id)
        if not coord:
            raise HomeAssistantError(f"No Platform Tasks config entry with id {entry_id}.")
        return coord
    # Multi-account setups must specify entry_id; single-account picks the
    # one we have.
    if len(bucket) > 1:
        raise HomeAssistantError(
            "Multiple Platform Tasks accounts configured — pass entry_id."
        )
    return next(iter(bucket.values()))


async def _register_services(hass: HomeAssistant) -> None:
    flag = f"{DOMAIN}_services_registered"
    if hass.data.get(flag):
        return

    async def _handle_smart_add(call: ServiceCall) -> ServiceResponse:
        text: str = call.data["text"]
        default_project_id: str | None = call.data.get("default_project_id")
        entry_id: str | None = call.data.get("entry_id")
        coord = _pick_coordinator(hass, entry_id)
        try:
            result = await coord.smart_add(text, default_project_id=default_project_id)
        except ValueError as err:
            raise HomeAssistantError(str(err)) from err
        return result if call.return_response else None

    hass.services.async_register(
        DOMAIN,
        SERVICE_SMART_ADD,
        _handle_smart_add,
        schema=SMART_ADD_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.data[flag] = True
    _LOGGER.info("Platform Tasks: registered service %s.%s", DOMAIN, SERVICE_SMART_ADD)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Platform Tasks from a config entry."""
    await _ensure_frontend_registered(hass)
    await _register_services(hass)

    coordinator = PlatformTasksCoordinator(hass, entry)
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unload_ok


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Reload integration when options change."""
    await hass.config_entries.async_reload(entry.entry_id)
