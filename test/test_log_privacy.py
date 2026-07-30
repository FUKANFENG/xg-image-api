from __future__ import annotations

import unittest

from utils.log import Logger


class LogPrivacyTests(unittest.TestCase):
    def test_sensitive_structured_fields_are_redacted(self) -> None:
        sanitized = Logger()._sanitize(
            {
                "account_email": "artist@example.test",
                "access_token": "secret-token-value",
                "token_claims": {"jti": "private-id"},
                "prompt_preview": "用户的完整提示词",
                "error": "上游返回了用户输入正文",
            }
        )

        rendered = str(sanitized)
        self.assertNotIn("artist@example.test", rendered)
        self.assertNotIn("secret-token-value", rendered)
        self.assertNotIn("private-id", rendered)
        self.assertNotIn("用户的完整提示词", rendered)
        self.assertNotIn("用户输入正文", rendered)
        self.assertRegex(str(sanitized.get("account_ref")), r"^acct_[0-9a-f]{12}$")

    def test_embedded_emails_are_replaced_with_stable_refs(self) -> None:
        logger = Logger()
        first = logger._sanitize_string("account artist@example.test failed")
        second = logger._sanitize_string("account artist@example.test failed")

        self.assertEqual(first, second)
        self.assertNotIn("artist@example.test", first)


if __name__ == "__main__":
    unittest.main()
