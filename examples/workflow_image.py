"""Generate and save one image through the API-first workflow client."""

from __future__ import annotations

import os
from pathlib import Path

from sdk import XGAPIClient


def main() -> None:
    client = XGAPIClient(
        base_url=os.getenv("XG_API_BASE_URL", "http://127.0.0.1:8000"),
        api_key=os.environ["XG_API_KEY"],
    )
    response = client.generate_image(
        "一只纸雕风格的白鹤，干净背景，柔和自然光",
        model="gpt-image-2",
    )
    paths = client.save_images(response, Path("output"))
    for path in paths:
        print(path.resolve())


if __name__ == "__main__":
    main()
