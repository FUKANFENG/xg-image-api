"""Small dependency-free client for XG image workflow integrations."""

from .xg_api_client import XGAPIClient, XGAPIError

__all__ = ["XGAPIClient", "XGAPIError"]
