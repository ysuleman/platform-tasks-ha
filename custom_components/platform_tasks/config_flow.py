"""Config flow for Platform Tasks — URL + token."""
from __future__ import annotations

from typing import Any

import aiohttp
import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    CONF_BASE_URL,
    CONF_TOKEN,
    DEFAULT_BASE_URL,
    DOMAIN,
    PATH_AUTH_ME,
)


class PlatformTasksConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            base_url = user_input[CONF_BASE_URL].rstrip("/")
            token = user_input[CONF_TOKEN].strip()
            if not token.startswith("pat_"):
                errors[CONF_TOKEN] = "bad_token_format"
            else:
                ok, who = await self._validate(base_url, token)
                if not ok:
                    errors["base"] = "auth_failed"
                else:
                    await self.async_set_unique_id(f"{base_url}::{who}")
                    self._abort_if_unique_id_configured()
                    return self.async_create_entry(
                        title=f"Platform Tasks ({who})",
                        data={CONF_BASE_URL: base_url, CONF_TOKEN: token},
                    )

        schema = vol.Schema({
            vol.Required(CONF_BASE_URL, default=DEFAULT_BASE_URL): str,
            vol.Required(CONF_TOKEN): str,
        })
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    async def _validate(self, base_url: str, token: str) -> tuple[bool, str]:
        session = async_get_clientsession(self.hass)
        try:
            async with session.get(
                f"{base_url}{PATH_AUTH_ME}",
                headers={"Authorization": f"Bearer {token}"},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status != 200:
                    return False, ""
                data = await resp.json()
                if not data.get("authenticated"):
                    return False, ""
                user = data.get("user") or {}
                return True, user.get("display_name") or user.get("username") or "user"
        except (aiohttp.ClientError, TimeoutError):
            return False, ""
