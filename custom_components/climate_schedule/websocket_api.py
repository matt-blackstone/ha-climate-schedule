"""WebSocket commands for the Climate Schedule card."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN, EVENT_UPDATED
from .manager import (
    ClimateScheduleManager,
    RevisionConflictError,
    ScheduleValidationError,
)


def _manager(hass: HomeAssistant) -> ClimateScheduleManager:
    """Return the configured schedule manager."""
    return hass.data[DOMAIN]["manager"]


@websocket_api.websocket_command({"type": f"{DOMAIN}/get"})
@websocket_api.async_response
async def websocket_get(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Return the complete schedule document."""
    connection.send_result(msg["id"], _manager(hass).snapshot)


@websocket_api.websocket_command(
    {
        "type": f"{DOMAIN}/save",
        vol.Required("schedule"): dict,
        vol.Required("expected_revision"): vol.Coerce(int),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def websocket_save(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Validate and persist a complete schedule document."""
    try:
        document = await _manager(hass).async_save(
            msg["schedule"], msg["expected_revision"]
        )
    except RevisionConflictError as err:
        connection.send_error(msg["id"], "revision_conflict", str(err))
        return
    except ScheduleValidationError as err:
        connection.send_error(msg["id"], "invalid_schedule", str(err))
        return
    connection.send_result(msg["id"], document)


@websocket_api.websocket_command(
    {
        "type": f"{DOMAIN}/set_active_season",
        vol.Required("season_id"): str,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def websocket_set_active_season(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Change and immediately apply the active season."""
    try:
        document = await _manager(hass).async_set_active_season(
            msg["season_id"]
        )
    except ScheduleValidationError as err:
        connection.send_error(msg["id"], "invalid_season", str(err))
        return
    connection.send_result(msg["id"], document)


@websocket_api.websocket_command({"type": f"{DOMAIN}/subscribe"})
@websocket_api.async_response
async def websocket_subscribe(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
) -> None:
    """Push a revision event when another client updates the schedule."""

    @callback
    def async_forward_update(event: Any) -> None:
        connection.send_event(msg["id"], event.data)

    connection.subscriptions[msg["id"]] = hass.bus.async_listen(
        EVENT_UPDATED, async_forward_update
    )
    connection.send_result(msg["id"])


def async_register(hass: HomeAssistant) -> None:
    """Register all frontend commands."""
    websocket_api.async_register_command(hass, websocket_get)
    websocket_api.async_register_command(hass, websocket_save)
    websocket_api.async_register_command(hass, websocket_set_active_season)
    websocket_api.async_register_command(hass, websocket_subscribe)
