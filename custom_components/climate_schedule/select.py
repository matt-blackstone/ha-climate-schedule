"""Select entity exposing the active Climate Schedule season."""

from __future__ import annotations

from typing import Any

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, EVENT_UPDATED, SEASONS
from .manager import ClimateScheduleManager

_OPTION_TO_ID = {season["name"]: season["id"] for season in SEASONS}
_ID_TO_OPTION = {season_id: option for option, season_id in _OPTION_TO_ID.items()}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the active-season selector."""
    manager: ClimateScheduleManager = hass.data[DOMAIN]["manager"]
    async_add_entities([ClimateScheduleSeasonSelect(manager)])


class ClimateScheduleSeasonSelect(SelectEntity):
    """Select and expose the schedule season Home Assistant executes."""

    _attr_name = "Climate Schedule Active Season"
    _attr_unique_id = "climate_schedule_active_season"
    _attr_icon = "mdi:calendar-sync"
    _attr_should_poll = False
    _attr_options = list(_OPTION_TO_ID)

    def __init__(self, manager: ClimateScheduleManager) -> None:
        self._manager = manager

    @property
    def current_option(self) -> str:
        """Return the human-readable active season."""
        return _ID_TO_OPTION[self._manager.active_season]

    async def async_select_option(self, option: str) -> None:
        """Activate the selected seasonal schedule."""
        await self._manager.async_set_active_season(_OPTION_TO_ID[option])
        self.async_write_ha_state()

    async def async_added_to_hass(self) -> None:
        """Subscribe to changes made by the card or service action."""
        await super().async_added_to_hass()
        self.async_on_remove(
            self.hass.bus.async_listen(EVENT_UPDATED, self._handle_update)
        )

    @callback
    def _handle_update(self, event: Event[Any]) -> None:
        """Publish the manager's latest active season."""
        self.async_write_ha_state()
