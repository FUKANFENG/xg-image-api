from __future__ import annotations

import unittest
from unittest.mock import patch

from services.protocol.conversation import count_text_tokens


class TokenCountFallbackTests(unittest.TestCase):
    def test_image_model_token_count_never_loads_remote_encoding(self) -> None:
        with (
            patch("services.protocol.conversation.tiktoken.encoding_for_model") as encoding_for_model,
            patch("services.protocol.conversation.tiktoken.get_encoding") as get_encoding,
        ):
            tokens = count_text_tokens("hello 世界", "codex-gpt-image-2")

        self.assertGreater(tokens, 0)
        encoding_for_model.assert_not_called()
        get_encoding.assert_not_called()

    def test_token_count_uses_local_estimate_when_tiktoken_download_is_unavailable(self) -> None:
        with (
            patch("services.protocol.conversation.tiktoken.encoding_for_model", side_effect=KeyError("unknown model")),
            patch("services.protocol.conversation.tiktoken.get_encoding", side_effect=OSError("dns unavailable")),
        ):
            tokens = count_text_tokens("hello 世界", "offline-image-model")

        self.assertGreater(tokens, 0)


if __name__ == "__main__":
    unittest.main()
