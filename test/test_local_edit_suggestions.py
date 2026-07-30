from __future__ import annotations

import json
import unittest

from services.image_prompt_reverse_service import parse_local_edit_response


class LocalEditSuggestionTests(unittest.TestCase):
    def test_parser_normalizes_supported_regions_and_clamps_bounds(self) -> None:
        result = parse_local_edit_response(
            json.dumps(
                {
                    "regions": [
                        {
                            "type": "product",
                            "label": "商品",
                            "x": 0.8,
                            "y": 0.1,
                            "width": 0.5,
                            "height": 0.4,
                            "confidence": 0.92,
                            "issue": "反光过强",
                            "suggestion": "降低高光",
                        },
                        {"type": "unknown", "x": 0, "y": 0, "width": 1, "height": 1},
                    ],
                    "global_suggestion": "保持构图",
                },
                ensure_ascii=False,
            )
        )

        self.assertEqual(len(result["regions"]), 1)
        self.assertAlmostEqual(result["regions"][0]["width"], 0.2)
        self.assertEqual(result["global_suggestion"], "保持构图")


if __name__ == "__main__":
    unittest.main()
