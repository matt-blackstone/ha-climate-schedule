"""Climate Schedule integration entry point."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import voluptuous as vol
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.const import Platform

from .const import (
    DOMAIN,
    SEASON_IDS,
    SERVICE_APPLY_NOW,
    SERVICE_SET_ACTIVE_SEASON,
)
from .manager import ClimateScheduleManager
from .websocket_api import async_register as async_register_websocket

FRONTEND_URL = f"/{DOMAIN}/climate-schedule-card.js"
PLATFORMS = (Platform.SELECT,)
_SET_ACTIVE_SCHEMA = vol.Schema(
    {vol.Required("season_id"): vol.In(SEASON_IDS)}
)


async def async_setup(hass: HomeAssistant, config: dict[str, Any]) -> bool:
    """Register process-lifetime HTTP and WebSocket endpoints."""
    hass.data.setdefault(DOMAIN, {})
    frontend_file = (
        Path(__file__).parent / "frontend" / "climate-schedule-card.js"
    )
    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(
                FRONTEND_URL,
                str(frontend_file),
                # The resource URL is stable across HACS upgrades. Avoid
                # pinning users to an older card bundle in their browser.
                cache_headers=False,
            )
        ]
    )
    async_register_websocket(hass)
    return True


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry
) -> bool:
    """Load storage, start execution, and expose service actions."""
    manager = ClimateScheduleManager(hass)
    await manager.async_initialize()
    hass.data[DOMAIN]["manager"] = manager

    async def async_set_active_season(call: ServiceCall) -> None:
        await manager.async_set_active_season(call.data["season_id"])

    async def async_apply_now(call: ServiceCall) -> None:
        await manager.async_apply(force=True)

    hass.services.async_register(
        DOMAIN,
        SERVICE_SET_ACTIVE_SEASON,
        async_set_active_season,
        schema=_SET_ACTIVE_SCHEMA,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_APPLY_NOW,
        async_apply_now,
    )
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(
    hass: HomeAssistant, entry: ConfigEntry
) -> bool:
    """Stop execution and remove services for the config entry."""
    if not await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        return False

    manager: ClimateScheduleManager | None = hass.data[DOMAIN].pop(
        "manager", None
    )
    if manager is not None:
        await manager.async_stop()

    hass.services.async_remove(DOMAIN, SERVICE_SET_ACTIVE_SEASON)
    hass.services.async_remove(DOMAIN, SERVICE_APPLY_NOW)
    return True
