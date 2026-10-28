"""A dependency-free client for the SMART Flint HTTP API.

Credential material is retained only in memory. This module never logs requests,
responses, headers, or tokens and does not install a cookie jar.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
import hashlib
import ipaddress
import json
import math
import re
import secrets
from typing import Any, Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class SMARTFlintError(Exception):
    """A structured API or transport failure without a raw response dump."""

    def __init__(self, code: str, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class PKCE:
    code_verifier: str = field(repr=False)
    code_challenge: str
    state: str = field(repr=False)


def create_pkce() -> PKCE:
    """Generate an S256 transaction. Bind state to your own initiating user session."""
    verifier = secrets.token_urlsafe(32)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    return PKCE(verifier, challenge, secrets.token_urlsafe(24))


@dataclass(frozen=True)
class Launch:
    launch_url: str
    expires_at: str
    application_id: str


@dataclass(frozen=True)
class Credential:
    base_url: str
    access_token: str = field(repr=False)
    token_type: str
    expires_at: str | None
    granted_scopes: tuple[str, ...]
    refresh_owner: str
    refresh_token: str | None = field(default=None, repr=False)
    token_endpoint: str | None = None
    client_id: str | None = None
    client_authentication: str | None = None

    @classmethod
    def from_response(cls, response: Mapping[str, Any]) -> Credential:
        try:
            return cls(
                base_url=response["baseUrl"], access_token=response["accessToken"],
                token_type=response["tokenType"], expires_at=response.get("expiresAt"),
                granted_scopes=tuple(response["grantedScopes"]), refresh_owner=response["refreshOwner"],
                refresh_token=response.get("refreshToken"), token_endpoint=response.get("tokenEndpoint"),
                client_id=response.get("clientId"), client_authentication=response.get("clientAuthentication"),
            )
        except (KeyError, TypeError) as error:
            raise SMARTFlintError("invalid_response", "The API returned an incomplete credential response.") from error


@dataclass(frozen=True)
class OriginalCredentialResponse:
    """Explicit sensitive envelope. The repr hides the original token response."""

    token_response: Mapping[str, Any] = field(repr=False)
    refresh_owner: str
    refresh_token_withheld: bool


@dataclass(frozen=True)
class FHIRConnection:
    """Configure any FHIR library with this endpoint and asynchronous/lazy auth hook."""

    base_url: str
    fhir_version: str
    route: str
    token_provider: Callable[[], str] = field(repr=False)
    authorization_provider: Callable[[], str] = field(repr=False)

    def get_access_token(self) -> str:
        return self.token_provider()

    def get_authorization_header(self) -> str:
        return self.authorization_provider()


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req: Request, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> None:
        # An API response must not redirect a request carrying session credentials.
        return None


class SMARTFlintClient:
    def __init__(self, base_url: str, *, timeout: float = 15.0) -> None:
        try:
            parsed = urlsplit(base_url)
            hostname = parsed.hostname or ""
            loopback = hostname.lower() == "localhost"
            if not loopback:
                try:
                    loopback = ipaddress.ip_address(hostname).is_loopback
                except ValueError:
                    pass
            if not hostname or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment:
                raise ValueError("The service URL must be a plain absolute URL.")
            if parsed.scheme != "https" and not (parsed.scheme == "http" and loopback):
                raise ValueError("Use HTTPS outside loopback.")
            _ = parsed.port  # Validates malformed port syntax before any request.
        except (TypeError, ValueError) as error:
            raise SMARTFlintError("invalid_base_url", "Use a plain HTTPS service URL, or HTTP on loopback for local development.") from error
        if not isinstance(timeout, (float, int)) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be a positive, finite number of seconds")
        self.base_url = base_url.rstrip("/")
        self.timeout = float(timeout)
        self._opener = build_opener(_NoRedirects())

    def start(
        self, installation_id: str, redirect_uri: str, *, code_challenge: str,
        state: str, mode: str | None = None, launch_ticket: str | None = None,
    ) -> Launch:
        """Start with caller-owned PKCE. Validate returned state before redeeming."""
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", code_challenge) or not 24 <= len(state) <= 256:
            raise SMARTFlintError("invalid_transaction", "Supply an S256 PKCE challenge and a securely generated transaction state.")
        if mode is not None and mode not in {"gateway", "direct", "handoff"}:
            raise ValueError("mode must be gateway, direct, or handoff")
        body = {"installationId": installation_id, "redirectUri": redirect_uri, "codeChallenge": code_challenge, "state": state}
        if mode is not None:
            body["mode"] = mode
        if launch_ticket is not None:
            body["launchTicket"] = launch_ticket
        response = self._request("/api/launches", "POST", body=body)
        try:
            return Launch(response["launchUrl"], response["expiresAt"], response["applicationId"])
        except (KeyError, TypeError) as error:
            raise SMARTFlintError("invalid_response", "The API returned an incomplete launch response.") from error

    def redeem(self, code: str, code_verifier: str, application_id: str, redirect_uri: str) -> ActivatedSession:
        """Redeem after the app verifies callback state against its initiating session."""
        if not re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", code_verifier):
            raise SMARTFlintError("invalid_verifier", "A valid PKCE verifier is required.")
        response = self._request("/api/activations/redeem", "POST", body={"code": code, "codeVerifier": code_verifier, "applicationId": application_id, "redirectUri": redirect_uri})
        return self._session_from_response(response)

    def service_activation(self, installation_id: str, application_key: str) -> ActivatedSession:
        """Create a backend service session using its application's API credential."""
        response = self._request("/api/service-activations", "POST", body={"installationId": installation_id}, bearer=application_key)
        return self._session_from_response(response)

    def session(self, activation_id: str, session_token: str) -> ActivatedSession:
        return ActivatedSession(self, activation_id, session_token)

    def _session_from_response(self, response: Mapping[str, Any]) -> ActivatedSession:
        try:
            activation = response["activation"]
            return ActivatedSession(self, activation["id"], response["sessionToken"], activation)
        except (KeyError, TypeError) as error:
            raise SMARTFlintError("invalid_response", "The API returned an incomplete activation session.") from error

    def _request(self, path: str, method: str = "GET", *, body: Mapping[str, Any] | None = None, bearer: str | None = None) -> Any:
        headers = {"Accept": "application/json", "Cache-Control": "no-store"}
        payload = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
        if bearer is not None:
            headers["Authorization"] = f"Bearer {bearer}"
        request = Request(self.base_url + path, data=payload, headers=headers, method=method)
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                if response.status == 204:
                    return None
                raw = response.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise SMARTFlintError("response_too_large", "The API response exceeds the SDK size limit.")
                try:
                    return json.loads(raw)
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise SMARTFlintError("invalid_response", "The API returned invalid JSON.") from error
        except HTTPError as error:
            with error:
                if 300 <= error.code < 400:
                    raise SMARTFlintError("redirect_blocked", "The credential-bearing API request was not redirected.", error.code) from None
                raw = error.read(64 * 1024)
                try:
                    problem = json.loads(raw)
                    if not isinstance(problem, dict):
                        problem = {}
                except (UnicodeDecodeError, json.JSONDecodeError):
                    problem = {}
            code = problem.get("code")
            message = problem.get("message")
            raise SMARTFlintError(code if isinstance(code, str) else "request_failed", message if isinstance(message, str) else f"SMART Flint request failed ({error.code}).", error.code) from None
        except (URLError, TimeoutError, OSError) as error:
            raise SMARTFlintError("transport_error", "The SMART Flint service could not be reached.") from error


class ActivatedSession:
    def __init__(self, client: SMARTFlintClient, activation_id: str, session_token: str, activation: Mapping[str, Any] | None = None) -> None:
        if not activation_id or not session_token:
            raise SMARTFlintError("missing_session", "An activation ID and its session credential are required.")
        self._client = client
        self.activation_id = activation_id
        self.activation = activation
        self._session_token = session_token
        self._closed = False

    def __repr__(self) -> str:
        return f"ActivatedSession(activation_id={self.activation_id!r}, credential=[redacted])"

    def _ensure_open(self) -> None:
        if self._closed:
            raise SMARTFlintError("session_closed", "This local activation session has been closed.")

    def _request(self, suffix: str = "", method: str = "GET") -> Any:
        self._ensure_open()
        path = f"/api/activations/{quote(self.activation_id, safe='')}{suffix}"
        return self._client._request(path, method, bearer=self._session_token)

    def descriptor(self) -> Mapping[str, Any]:
        self.activation = self._request()
        return self.activation

    def current(self) -> Credential:
        return Credential.from_response(self._request("/credentials"))

    def original(self) -> OriginalCredentialResponse:
        response = self._request("/credentials/original")
        try:
            return OriginalCredentialResponse(response["tokenResponse"], response["refreshOwner"], response["refreshTokenWithheld"])
        except (KeyError, TypeError) as error:
            raise SMARTFlintError("invalid_response", "The API returned an incomplete original-credential envelope.") from error

    def handoff(self) -> Credential:
        return Credential.from_response(self._request("/credentials/handoff", "POST"))

    def get_fhir_connection(self, route: str | None = None) -> FHIRConnection:
        activation = self.descriptor()
        route = route or ("gateway" if activation["mode"] == "gateway" else "direct")
        version = activation["upstream"]["fhirVersion"]
        if route == "gateway":
            def token() -> str:
                self._ensure_open()
                return self._session_token
            return FHIRConnection(activation["gateway"]["baseUrl"], version, route, token, lambda: f"Bearer {token()}")
        if route == "direct":
            def authorization() -> str:
                credential = self.current()
                return f"{credential.token_type} {credential.access_token}"
            return FHIRConnection(activation["upstream"]["baseUrl"], version, route, lambda: self.current().access_token, authorization)
        raise ValueError("route must be gateway or direct")

    def close(self) -> None:
        self._request(method="DELETE")
        self._closed = True
        self._session_token = ""
