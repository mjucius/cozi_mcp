#!/usr/bin/env python3
"""
Cozi MCP Server using FastMCP

This module implements an MCP server that exposes Cozi Family Organizer API functionality
as tools that can be used by AI assistants like Claude Desktop. 

The server uses py-cozi-client>=1.3.0 which uses pydantic models for all data objects.
All tools return the API objects directly as JSON using the pydantic model_dump() method.

Usage:
    python cozi_mcp.py

Environment Variables:
    COZI_USERNAME - Your Cozi account username/email
    COZI_PASSWORD - Your Cozi account password
"""

import os
import sys
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from mcp.server.fastmcp import FastMCP

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

# Global client instance
cozi_client: Optional[CoziClient] = None

# Initialize the FastMCP server
mcp = FastMCP("cozi-mcp")

async def get_cozi_client() -> CoziClient:
    """Get or create the Cozi client instance."""
    global cozi_client
    
    if cozi_client is None:
        username = os.getenv("COZI_USERNAME")
        password = os.getenv("COZI_PASSWORD")
        
        if not username or not password:
            raise AuthenticationError("COZI_USERNAME and COZI_PASSWORD environment variables must be set")
        
        cozi_client = CoziClient(username, password)
        await cozi_client.authenticate()
    
    return cozi_client

# Family member tools
@mcp.tool()
async def get_family_members() -> List[Dict[str, Any]]:
    """Get all family members in the Cozi account.
    
    Returns:
        List of family member objects with their details
    """
    try:
        client = await get_cozi_client()
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
async def get_lists() -> List[Dict[str, Any]]:
    """Get all lists (shopping and todo lists).
    
    Returns:
        List of list objects with their items
    """
    try:
        client = await get_cozi_client()
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
async def get_lists_by_type(list_type: str) -> List[Dict[str, Any]]:
    """Get lists filtered by type.
    
    Args:
        list_type: Type of lists to retrieve ('shopping' or 'todo')
        
    Returns:
        List of list objects of the specified type
    """
    try:
        # Validate and convert list type
        try:
            list_type_enum = ListType(list_type)
        except ValueError:
            raise ValueError(f"Invalid list type: {list_type}. Must be 'shopping' or 'todo'")
        
        client = await get_cozi_client()
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
async def create_list(title: str, list_type: str) -> Dict[str, Any]:
    """Create a new list.
    
    Args:
        title: Title of the new list
        list_type: Type of list to create ('shopping' or 'todo')
        
    Returns:
        Created list object
    """
    try:
        # Validate and convert list type
        try:
            list_type_enum = ListType(list_type)
        except ValueError:
            raise ValueError(f"Invalid list type: {list_type}. Must be 'shopping' or 'todo'")
        
        client = await get_cozi_client()
        new_list = await client.create_list(title, list_type_enum)
        
        # Return the pydantic model as dictionary directly
        return new_list.model_dump()
    
    except CoziException as e:
        logger.error(f"Cozi API error in create_list: {e}")
        raise
    except Exception as e:
        logger.exception("Unexpected error in create_list")
        raise

@mcp.tool()
async def delete_list(list_id: str) -> bool:
    """Delete a list.
    
    Args:
        list_id: ID of the list to delete
        
    Returns:
        True if deletion was successful
    """
    try:
        client = await get_cozi_client()
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
async def add_item(list_id: str, text: str, position: int = 0) -> Dict[str, Any]:
    """Add an item to a list.
    
    Args:
        list_id: ID of the list to add the item to
        text: Text content of the item to add
        position: Position in the list (0 = top)
        
    Returns:
        Created item object
    """
    try:
        client = await get_cozi_client()
        new_item = await client.add_item(list_id, text, position)
        
        # Return the pydantic model as dictionary directly
        return new_item.model_dump()
    
    except CoziException as e:
        logger.error(f"Cozi API error in add_item: {e}")
        raise
    except Exception as e:
        logger.exception("Unexpected error in add_item")
        raise

@mcp.tool()
async def update_item_text(list_id: str, item_id: str, text: str) -> Dict[str, Any]:
    """Update the text of a list item.
    
    Args:
        list_id: ID of the list containing the item
        item_id: ID of the item to update
        text: New text content for the item
        
    Returns:
        Updated item object
    """
    try:
        client = await get_cozi_client()
        updated_item = await client.update_item_text(list_id, item_id, text)
        
        # Return the pydantic model as dictionary directly
        return updated_item.model_dump()
    
    except CoziException as e:
        logger.error(f"Cozi API error in update_item_text: {e}")
        raise
    except Exception as e:
        logger.exception("Unexpected error in update_item_text")
        raise

@mcp.tool()
async def mark_item(list_id: str, item_id: str, status: str) -> Dict[str, Any]:
    """Mark an item as complete or incomplete.
    
    Args:
        list_id: ID of the list containing the item
        item_id: ID of the item to mark
        status: Status to set ('complete' or 'incomplete')
        
    Returns:
        Updated item object
    """
    try:
        # Validate and convert status
        try:
            status_enum = ItemStatus(status)
        except ValueError:
            raise ValueError(f"Invalid status: {status}. Must be 'complete' or 'incomplete'")
        
        client = await get_cozi_client()
        updated_item = await client.mark_item(list_id, item_id, status_enum)
        
        # Return the pydantic model as dictionary directly
        return updated_item.model_dump()
    
    except CoziException as e:
        logger.error(f"Cozi API error in mark_item: {e}")
        raise
    except Exception as e:
        logger.exception("Unexpected error in mark_item")
        raise

@mcp.tool()
async def remove_items(list_id: str, item_ids: List[str]) -> bool:
    """Remove items from a list.
    
    Args:
        list_id: ID of the list containing the items
        item_ids: List of item IDs to remove
        
    Returns:
        True if removal was successful
    """
    try:
        client = await get_cozi_client()
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
async def get_calendar(year: int, month: int) -> List[Dict[str, Any]]:
    """Get calendar appointments for a specific month.
    
    Args:
        year: Year (e.g., 2024)
        month: Month (1-12)
        
    Returns:
        List of appointment objects for the specified month
    """
    try:
        if not 1 <= month <= 12:
            raise ValueError("Invalid month: must be between 1 and 12")
        
        client = await get_cozi_client()
        appointments = await client.get_calendar(year, month)
        
        # Return the pydantic models as dictionaries directly
        return [appointment.model_dump() for appointment in appointments]
    
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
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    location: Optional[str] = None,
    notes: Optional[str] = None
) -> Dict[str, Any]:
    """Create a new calendar appointment.
    
    Args:
        subject: Subject/title of the appointment
        start_date: Start date in YYYY-MM-DD format
        start_time: Optional start time in HH:MM format
        end_time: Optional end time in HH:MM format
        location: Optional location
        notes: Optional notes
        
    Returns:
        Created appointment object
    """
    try:
        # Parse date
        try:
            start_date_obj = datetime.strptime(start_date, "%Y-%m-%d").date()
        except ValueError:
            raise ValueError("Invalid start_date format. Use YYYY-MM-DD")
        
        # Parse times if provided
        start_time_obj = None
        end_time_obj = None
        
        if start_time:
            try:
                start_time_obj = datetime.strptime(start_time, "%H:%M").time()
            except ValueError:
                raise ValueError("Invalid start_time format. Use HH:MM")
        
        if end_time:
            try:
                end_time_obj = datetime.strptime(end_time, "%H:%M").time()
            except ValueError:
                raise ValueError("Invalid end_time format. Use HH:MM")
        
        # Create CoziAppointment object using pydantic model
        appointment = CoziAppointment(
            id=None,  # Will be assigned by API
            subject=subject,
            start_day=start_date_obj,
            start_time=start_time_obj,
            end_time=end_time_obj,
            location=location,
            notes=notes,
            date_span=0,
            attendees=[]
        )
        
        client = await get_cozi_client()
        new_appointment = await client.create_appointment(appointment)
        
        # Return the pydantic model as dictionary directly
        return new_appointment.model_dump()
    
    except CoziException as e:
        logger.error(f"Cozi API error in create_appointment: {e}")
        raise
    except Exception as e:
        logger.exception("Unexpected error in create_appointment")
        raise

@mcp.tool()
async def update_appointment(
    appointment_id: str,
    subject: str,
    start_date: str,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    location: Optional[str] = None,
    notes: Optional[str] = None
) -> Dict[str, Any]:
    """Update an existing calendar appointment.
    
    Args:
        appointment_id: ID of the appointment to update
        subject: Subject/title of the appointment
        start_date: Start date in YYYY-MM-DD format
        start_time: Optional start time in HH:MM format
        end_time: Optional end time in HH:MM format
        location: Optional location
        notes: Optional notes
        
    Returns:
        Updated appointment object
    """
    try:
        # Parse date
        try:
            start_date_obj = datetime.strptime(start_date, "%Y-%m-%d").date()
        except ValueError:
            raise ValueError("Invalid start_date format. Use YYYY-MM-DD")
        
        # Parse times if provided
        start_time_obj = None
        end_time_obj = None
        
        if start_time:
            try:
                start_time_obj = datetime.strptime(start_time, "%H:%M").time()
            except ValueError:
                raise ValueError("Invalid start_time format. Use HH:MM")
        
        if end_time:
            try:
                end_time_obj = datetime.strptime(end_time, "%H:%M").time()
            except ValueError:
                raise ValueError("Invalid end_time format. Use HH:MM")
        
        # Create CoziAppointment object using pydantic model
        appointment = CoziAppointment(
            id=appointment_id,
            subject=subject,
            start_day=start_date_obj,
            start_time=start_time_obj,
            end_time=end_time_obj,
            location=location,
            notes=notes,
            date_span=0,
            attendees=[]
        )
        
        client = await get_cozi_client()
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
async def delete_appointment(appointment_id: str, year: int, month: int) -> bool:
    """Delete a calendar appointment.
    
    Args:
        appointment_id: ID of the appointment to delete
        year: Year of the appointment
        month: Month of the appointment
        
    Returns:
        True if deletion was successful
    """
    try:
        client = await get_cozi_client()
        result = await client.delete_appointment(appointment_id, year, month)
        return result
    
    except CoziException as e:
        logger.error(f"Cozi API error in delete_appointment: {e}")
        raise
    except Exception as e:
        logger.exception("Unexpected error in delete_appointment")
        raise

# Additional list management tool
@mcp.tool()
async def update_list(list_obj: Dict[str, Any]) -> Dict[str, Any]:
    """Update an existing list (mainly for reordering items).
    
    Args:
        list_obj: List object dictionary to update
        
    Returns:
        Updated list object
    """
    try:
        # Convert dictionary back to pydantic model
        cozi_list = CoziList(**list_obj)
        
        client = await get_cozi_client()
        updated_list = await client.update_list(cozi_list)
        
        # Return the pydantic model as dictionary directly
        return updated_list.model_dump()
    
    except CoziException as e:
        logger.error(f"Cozi API error in update_list: {e}")
        raise
    except Exception as e:
        logger.exception("Unexpected error in update_list")
        raise

if __name__ == "__main__":
    # Verify environment variables are set
    if not os.getenv("COZI_USERNAME"):
        print("Error: COZI_USERNAME environment variable not set", file=sys.stderr)
        sys.exit(1)
    
    if not os.getenv("COZI_PASSWORD"):
        print("Error: COZI_PASSWORD environment variable not set", file=sys.stderr)
        sys.exit(1)
    
    # Run the FastMCP server
    mcp.run()