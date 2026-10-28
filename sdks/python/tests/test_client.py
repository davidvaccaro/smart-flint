import hashlib
import io
import json
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

from smart_flint import SMARTFlintClient, SMARTFlintError, create_pkce


class Response(io.BytesIO):
    def __init__(self, body, status=200):
        super().__init__(json.dumps(body).encode("utf-8"))
        self.status = status


def descriptor(activation_id="act-a"):
    return {"id": activation_id, "mode": "gateway", "upstream": {"baseUrl": "https://ehr.example/fhir", "fhirVersion": "4.0.1"}, "gateway": {"baseUrl": f"https://bridge.example/fhir/{activation_id}"}}


def credential(token="upstream-token"):
    return {"baseUrl": "https://ehr.example/fhir", "accessToken": token, "tokenType": "Bearer", "grantedScopes": ["patient/Patient.rs"], "refreshOwner": "bridge"}


class ClientTests(unittest.TestCase):
    def make_client(self):
        opener = Mock()
        with patch("smart_flint.client.build_opener", return_value=opener):
            client = SMARTFlintClient("https://bridge.example")
        return client, opener

    def test_pkce_is_bound_and_repr_hides_verifier(self):
        import base64
        pkce = create_pkce()
        self.assertEqual(pkce.code_challenge, base64.urlsafe_b64encode(hashlib.sha256(pkce.code_verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii"))
        self.assertNotIn(pkce.code_verifier, repr(pkce))
        self.assertNotEqual(pkce.state, create_pkce().state)

    def test_manual_pkce_start_and_redeem_bind_application(self):
        client, opener = self.make_client()
        opener.open.side_effect = [Response({"launchUrl": "https://bridge.example/launch/start", "expiresAt": "2030-01-01T00:00:00Z", "applicationId": "app-a"}), Response({"activation": descriptor(), "sessionToken": "session-private"})]
        pkce = create_pkce()
        launch = client.start("inst-a", "https://app.example/callback", code_challenge=pkce.code_challenge, state=pkce.state, mode="direct")
        self.assertEqual(launch.application_id, "app-a")
        session = client.redeem("one-use-code", pkce.code_verifier, launch.application_id, "https://app.example/callback")
        request = opener.open.call_args_list[1].args[0]
        self.assertEqual(json.loads(request.data)["applicationId"], "app-a")
        self.assertEqual(json.loads(request.data)["codeVerifier"], pkce.code_verifier)
        self.assertNotIn("session-private", repr(session))

    def test_gateway_and_direct_use_distinct_credentials_with_lazy_refresh(self):
        client, opener = self.make_client()
        opener.open.side_effect = [Response(descriptor()), Response(descriptor()), Response(credential("upstream-first")), Response(credential("upstream-renewed"))]
        session = client.session("act-a", "session-private")
        gateway = session.get_fhir_connection("gateway")
        self.assertEqual(gateway.base_url, "https://bridge.example/fhir/act-a")
        self.assertEqual(gateway.get_access_token(), "session-private")
        direct = session.get_fhir_connection("direct")
        self.assertEqual(direct.base_url, "https://ehr.example/fhir")
        self.assertEqual(direct.get_access_token(), "upstream-first")
        self.assertEqual(direct.get_authorization_header(), "Bearer upstream-renewed")
        for call in opener.open.call_args_list:
            self.assertEqual(call.args[0].get_header("Authorization"), "Bearer session-private")
        self.assertNotIn("session-private", repr(gateway))

    def test_two_sessions_never_share_activation_or_session_credentials(self):
        client, opener = self.make_client()
        opener.open.side_effect = [Response(descriptor("act-a")), Response(descriptor("act-b"))]
        first = client.session("act-a", "session-a")
        second = client.session("act-b", "session-b")
        first.descriptor()
        second.descriptor()
        requests = [call.args[0] for call in opener.open.call_args_list]
        self.assertTrue(requests[0].full_url.endswith("/act-a"))
        self.assertEqual(requests[0].get_header("Authorization"), "Bearer session-a")
        self.assertTrue(requests[1].full_url.endswith("/act-b"))
        self.assertEqual(requests[1].get_header("Authorization"), "Bearer session-b")

    def test_service_application_key_does_not_become_session_credential(self):
        client, opener = self.make_client()
        opener.open.side_effect = [Response({"activation": descriptor(), "sessionToken": "service-session"}), Response(descriptor())]
        session = client.service_activation("inst-service", "application-private-key")
        session.descriptor()
        self.assertEqual(opener.open.call_args_list[0].args[0].get_header("Authorization"), "Bearer application-private-key")
        self.assertEqual(opener.open.call_args_list[1].args[0].get_header("Authorization"), "Bearer service-session")

    def test_original_envelope_and_handoff_are_explicit_and_repr_safe(self):
        client, opener = self.make_client()
        handed = credential()
        handed.update({"refreshOwner": "application", "refreshToken": "private-refresh"})
        opener.open.side_effect = [Response({"tokenResponse": {"access_token": "original-private"}, "refreshOwner": "bridge", "refreshTokenWithheld": True}), Response(handed)]
        session = client.session("act-a", "session-private")
        original = session.original()
        self.assertEqual(original.token_response["access_token"], "original-private")
        self.assertTrue(original.refresh_token_withheld)
        self.assertNotIn("original-private", repr(original))
        current = session.handoff()
        self.assertEqual(current.refresh_token, "private-refresh")
        self.assertNotIn("private-refresh", repr(current))
        self.assertNotIn("upstream-token", repr(current))

    def test_close_invalidates_existing_local_token_providers(self):
        client, opener = self.make_client()
        opener.open.side_effect = [Response(descriptor()), Response(None, 204)]
        session = client.session("act-a", "session-private")
        connection = session.get_fhir_connection()
        session.close()
        with self.assertRaises(SMARTFlintError) as raised:
            connection.get_access_token()
        self.assertEqual(raised.exception.code, "session_closed")

    def test_redirects_and_insecure_hosts_are_rejected(self):
        for url in ["http://ehr.example", "https://user:secret@bridge.example", "https://bridge.example?token=secret", "ftp://localhost"]:
            with self.assertRaises(SMARTFlintError):
                SMARTFlintClient(url)
        client, opener = self.make_client()
        error = HTTPError("https://bridge.example/api", 302, "Found", {"Location": "https://attacker.example"}, io.BytesIO(b""))
        opener.open.side_effect = error
        with self.assertRaises(SMARTFlintError) as raised:
            client.session("act-a", "private").descriptor()
        self.assertEqual(raised.exception.code, "redirect_blocked")
        self.assertEqual(opener.open.call_count, 1)

    def test_structured_api_errors_do_not_dump_response(self):
        client, opener = self.make_client()
        opener.open.side_effect = HTTPError("https://bridge.example/api", 403, "Forbidden", {}, io.BytesIO(json.dumps({"code": "token_export_disabled", "message": "Export is disabled.", "debugToken": "secret-never-dump"}).encode()))
        with self.assertRaises(SMARTFlintError) as raised:
            client.session("act-a", "private").current()
        self.assertEqual(raised.exception.code, "token_export_disabled")
        self.assertNotIn("secret-never-dump", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
