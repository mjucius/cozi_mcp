#!/usr/bin/env python3
"""
Cozi MCP Server for Smithery deployment

This module implements an MCP server that exposes Cozi Family Organizer API functionality
as tools that can be used by AI assistants like Claude Desktop, configured for deployment
on Smithery.ai.

The server uses py-cozi-client>=1.3.0 which uses pydantic models for all data objects.
All tools return the API objects directly as JSON using the pydantic model_dump() method.
"""

import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from mcp.server.fastmcp import FastMCP, Context
from smithery.decorators import smithery
from pydantic import BaseModel, Field

# Import from py-cozi-client>=1.3.0
from cozi_client import (
    CoziClient, 
    CoziList, 
    CoziAppointment,
    ListType, 
    ItemStatus,
    CoziException,
    AuthenticationError
)

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("cozi-mcp")

# Configuration schema for Smithery deployment
class CoziConfigSchema(BaseModel):
    username: str = Field(description="Cozi account username/email")
    password: str = Field(description="Cozi account password")

# Global client instance
cozi_client: Optional[CoziClient] = None

async def get_cozi_client(username: str, password: str) -> CoziClient:
    """Get or create the Cozi client instance."""
    global cozi_client
    
    if cozi_client is None:
        if not username or not password:
            raise AuthenticationError("Cozi username and password must be provided")
        
        cozi_client = CoziClient(username, password)
        await cozi_client.authenticate()
    
    return cozi_client

@smithery.server(config_schema=CoziConfigSchema)
def create_server():
    """Create the Cozi MCP server for Smithery deployment."""
    mcp = FastMCP("cozi-mcp")
    
    # Family member tools
    @mcp.tool()
    async def get_family_members(ctx: Context) -> List[Dict[str, Any]]:
        """Get all family members in the Cozi account.
        
        Returns:
            List of family member objects with their details
        """
        try:
            config = ctx.session_config
            client = await get_cozi_client(config.username, config.password)
            family_members = await client.get_family_members()
            
            # Return the pydantic models as dictionaries directly
            return [member.model_dump() for member in family_members]
        
        except CoziException as e:
            logger.error(f"Cozi API error in get_family_members: {e}")
            raise
        except Exception as e:
            logger.exception("Unexpected error in get_family_members")
            raise

    # List management tools
    @mcp.tool()
    async def get_lists(ctx: Context) -> List[Dict[str, Any]]:
        """Get all lists (shopping and todo lists).
        
        Returns:
            List of list objects with their items
        """
        try:
            config = ctx.session_config
            client = await get_cozi_client(config.username, config.password)
            lists = await client.get_lists()
            
            # Return the pydantic models as dictionaries directly
            return [list_item.model_dump() for list_item in lists]
        
        except CoziException as e:
            logger.error(f"Cozi API error in get_lists: {e}")
            raise
        except Exception as e:
            logger.exception("Unexpected error in get_lists")
            raise

    @mcp.tool()
    async def get_lists_by_type(list_type: str, ctx: Context) -> List[Dict[str, Any]]:
        """Get lists filtered by type.
        
        Args:
            list_type: Type of lists to retrieve ('shopping' or 'todo')
            
        Returns:
            List of list objects filtered by type
        """
        try:
            # Convert string to ListType enum
            list_type_enum = ListType.SHOPPING if list_type.lower() == 'shopping' else ListType.TODO
            
            config = ctx.session_config
            client = await get_cozi_client(config.username, config.password)
            lists = await client.get_lists_by_type(list_type_enum)
            
            # Return the pydantic models as dictionaries directly
            return [list_item.model_dump() for list_item in lists]
        
        except CoziException as e:
            logger.error(f"Cozi API error in get_lists_by_type: {e}")
            raise
        except Exception as e:
            logger.exception("Unexpected error in get_lists_by_type")
            raise

    @mcp.tool()
    async def create_list(name: str, list_type: str, ctx: Context) -> Dict[str, Any]:
        """Create a new list.
        
        Args:
            name: Name of the new list
            list_type: Type of list to create ('shopping' or 'todo')
            
        Returns:
            Created list object
        """
        try:
            # Convert string to ListType enum
            list_type_enum = ListType.SHOPPING if list_type.lower() == 'shopping' else ListType.TODO
            
            config = ctx.session_config
            client = await get_cozi_client(config.username, config.password)
            new_list = await client.create_list(name, list_type_enum)
            
            # Return the pydantic model as dictionary directly
            return new_list.model_dump()
        
        except CoziException as e:
            logger.error(f"Cozi API error in create_list: {e}")
            raise
        except Exception as e:
            logger.exception("Unexpected error in create_list")
            raise

    @mcp.tool()
    async def delete_list(list_id: str, ctx: Context) -> bool:
        """Delete an existing list.
        
        Args:
            list_id: ID of the list to delete
            
        Returns:
            True if deletion was successful
        """
        try:
            config = ctx.session_config
            client = await get_cozi_client(config.username, config.password)
            result = await client.delete_list(list_id)
            
            return result
        
        except CoziException as e:
            logger.error(f"Cozi API error in delete_list: {e}")
            raise
        except Exception as e:
            logger.exception("Unexpected error in delete_list")
            raise

    # Item management tools
    @mcp.tool()
    async def add_item(list_id: str, item_text: str, ctx: Context) -> Dict[str, Any]:
        """Add an item to a list.
        
        Args:
            list_id: ID of the list to add item to
            item_text: Text content of the item to add
            
        Returns:
            Updated list object with the new item
        """
        try:
            config = ctx.session_config
            client = await get_cozi_client(config.username, config.password)
            updated_list = await client.add_item(list_id, item_text)
            
            # Return the pydantic model as dictionary directly
            return updated_list.model_dump()
        
        except CoziException as e:
            logger.error(f"Cozi API error in add_item: {e}")
            raise
        except Exception as e:
            logger.exception("Unexpected error in add_item")
            raise

    @mcp.tool()
    async def update_item_text(list_id: str, item_id: str, new_text: str, ctx: Context) -> Dict[str, Any]:
        """Update the text of an existing item.
        
        Args:
            list_id: ID of the list containing the item
            item_id: ID of the item to update
            new_text: New text content for the item
            
        Returns:
            Updated list object
        """
        try:
            config = ctx.session_config
            client = await get_cozi_client(config.username, config.password)
            updated_list = await client.update_item_text(list_id, item_id, new_text)
            
            # Return the pydantic model as dictionary directly
            return updated_list.model_dump()
        
        except CoziException as e:
            logger.error(f"Cozi API error in update_item_text: {e}")
            raise
        except Exception as e:
            logger.exception("Unexpected error in update_item_text")
            raise

    @mcp.tool()
    async def mark_item(list_id: str, item_id: str, completed: bool, ctx: Context) -> Dict[str, Any]:
        """Mark an item as complete or incomplete.
        
        Args:
            list_id: ID of the list containing the item
            item_id: ID of the item to mark
            completed: True to mark complete, False to mark incomplete
            
        Returns:
            Updated list object
        """
        try:
            status = ItemStatus.COMPLETE if completed else ItemStatus.INCOMPLETE
            
            config = ctx.session_config
            client = await get_cozi_client(config.username, config.password)
            updated_list = await client.mark_item(list_id, item_id, status)
            
            # Return the pydantic model as dictionary directly
            return updated_list.model_dump()
        
        except CoziException as e:
            logger.error(f"Cozi API error in mark_item: {e}")
            raise
        except Exception as e:
            logger.exception("Unexpected error in mark_item")
            raise

    @mcp.tool()
    async def remove_items(list_id: str, item_ids: List[str], ctx: Context) -> bool:
        """Remove items from a list.

        Args:
            list_id: ID of the list to remove items from
            item_ids: List of item IDs to remove

        Returns:
            True if removal was successful
        """
        try:
            config = ctx.session_config
            client = await get_cozi_client(config.username, config.password)
            result = await client.remove_items(list_id, item_ids)

            return result

        except CoziException as e:
            logger.error(f"Cozi API error in remove_items: {e}")
            raise
        except Exception as e:
            logger.exception("Unexpected error in remove_items")
            raise

    # Calendar management tools
    @mcp.tool()
    async def get_calendar(year: int, month: int, ctx: Context) -> List[Dict[str, Any]]:
        """Get calendar appointments for a specific month.
        
        Args:
            year: Year (e.g., 2024)
            month: Month number (1-12)
            
        Returns:
            List of appointment objects for the specified month
        """
        try:
            config = ctx.session_config
            client = await get_cozi_client(config.username, config.password)
            appointments = await client.get_calendar(year, month)
            
            # Return the pydantic models as dictionaries directly
            return [appt.model_dump() for appt in appointments]
        
        except CoziException as e:
            logger.error(f"Cozi API error in get_calendar: {e}")
            raise
        except Exception as e:
            logger.exception("Unexpected error in get_calendar")
            raise

    @mcp.tool()
    async def create_appointment(
        subject: str,
        start_date: str,
        end_date: str,
        all_day: bool = False,
        notes: str = "",
        ctx: Context = None
    ) -> Dict[str, Any]:
        """Create a new calendar appointment.

        Args:
            subject: Appointment title/subject
            start_date: Start date/time in ISO format (e.g., "2024-03-15T10:00:00")
            end_date: End date/time in ISO format (e.g., "2024-03-15T11:00:00")
            all_day: Whether this is an all-day event (default: False)
            notes: Additional notes for the appointment (default: "")

        Returns:
            Created appointment object
        """
        try:
            # Parse ISO date strings to datetime objects
            start_dt = datetime.fromisoformat(start_date.replace('Z', '+00:00'))
            end_dt = datetime.fromisoformat(end_date.replace('Z', '+00:00'))

            # Create CoziAppointment object with the correct field names
            appointment_data = {
                'subject': subject,
                'start_day': start_dt.date(),
                'notes': notes
            }

            # Add time fields only if not all-day
            if not all_day:
                appointment_data['start_time'] = start_dt.time()
                appointment_data['end_time'] = end_dt.time()

            appointment = CoziAppointment(**appointment_data)

            config = ctx.session_config
            client = await get_cozi_client(config.username, config.password)
            created_appointment = await client.create_appointment(appointment)

            # Return the pydantic model as dictionary directly
            return created_appointment.model_dump()

        except CoziException as e:
            logger.error(f"Cozi API error in create_appointment: {e}")
            raise
        except Exception as e:
            logger.exception("Unexpected error in create_appointment")
            raise

    @mcp.tool()
    async def update_appointment(appointment_obj: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
        """Update an existing calendar appointment.
        
        Args:
            appointment_obj: Appointment object dictionary to update
            
        Returns:
            Updated appointment object
        """
        try:
            # Convert dictionary back to pydantic model
            appointment = CoziAppointment(**appointment_obj)
            
            config = ctx.session_config
            client = await get_cozi_client(config.username, config.password)
            updated_appointment = await client.update_appointment(appointment)
            
            # Return the pydantic model as dictionary directly
            return updated_appointment.model_dump()
        
        except CoziException as e:
            logger.error(f"Cozi API error in update_appointment: {e}")
            raise
        except Exception as e:
            logger.exception("Unexpected error in update_appointment")
            raise

    @mcp.tool()
    async def delete_appointment(appointment_id: str, ctx: Context) -> bool:
        """Delete a calendar appointment.
        
        Args:
            appointment_id: ID of the appointment to delete
            
        Returns:
            True if deletion was successful
        """
        try:
            config = ctx.session_config
            client = await get_cozi_client(config.username, config.password)
            result = await client.delete_appointment(appointment_id)
            
            return result
        
        except CoziException as e:
            logger.error(f"Cozi API error in delete_appointment: {e}")
            raise
        except Exception as e:
            logger.exception("Unexpected error in delete_appointment")
            raise

    # Additional list management tool
    @mcp.tool()
    async def update_list(list_obj: Dict[str, Any], ctx: Context) -> Dict[str, Any]:
        """Update an existing list (mainly for reordering items).
        
        Args:
            list_obj: List object dictionary to update
            
        Returns:
            Updated list object
        """
        try:
            # Convert dictionary back to pydantic model
            cozi_list = CoziList(**list_obj)
            
            config = ctx.session_config
            client = await get_cozi_client(config.username, config.password)
            updated_list = await client.update_list(cozi_list)
            
            # Return the pydantic model as dictionary directly
            return updated_list.model_dump()
        
        except CoziException as e:
            logger.error(f"Cozi API error in update_list: {e}")
            raise
        except Exception as e:
            logger.exception("Unexpected error in update_list")
            raise

    return mcp