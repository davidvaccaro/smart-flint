# SMART Flint Python SDK

An optional, dependency-free Python 3.9+ client for the SMART Flint activation and credential APIs. Bring your preferred FHIR library; the SDK supplies its endpoint and a callable credential provider. It never persists credentials, installs a cookie jar, or logs token material. Sensitive response objects redact credentials from their `repr`.

Install the wheel from your matching SMART Flint release:

```sh
python3 -m pip install ./smart_flint-0.1.0-py3-none-any.whl
```

A source distribution is also provided. For a development checkout, install from the repository root:

```sh
python3 -m pip install ./sdks/python
```

The runtime has no third-party dependencies and includes a `py.typed` marker for typed consumers. Packaging uses setuptools. Product license and third-party notices are included in both artifacts. Registry publication is a separate release step. For development without installation:

```sh
PYTHONPATH=sdks/python/src python3 -m unittest discover -s sdks/python/tests -v
```

Maintainers can build a wheel and sdist with `python3 scripts/build-python-sdk.py --verify` after installing `scripts/sdk-build-requirements.txt` in an isolated virtualenv. Verification installs the wheel and a rebuilt sdist into independent environments and runs the SDK checks without importing source from the checkout.

## Backend service access

```python
import os
from smart_flint import SMARTFlintClient

bridge = SMARTFlintClient("https://flint.example.org")
session = bridge.service_activation(
    installation_id="your-service-installation",
    application_key=os.environ["SMART_FLINT_APPLICATION_KEY"],
)
connection = session.get_fhir_connection("gateway")

# Configure your preferred FHIR library with:
# connection.base_url
# connection.token_provider (call whenever a current credential is needed)
# or connection.authorization_provider for the complete Authorization value
```

The application API key is used only to create its backend session. Subsequent operations use the activation-specific session credential. Provision the API key using the management console. Keep it on a trusted backend.

## Interactive launch with caller-owned PKCE

```python
from smart_flint import create_pkce

pkce = create_pkce()
launch = bridge.start(
    "your-interactive-installation",
    "https://app.example.org/smart/callback",
    code_challenge=pkce.code_challenge,
    state=pkce.state,
    mode="direct",
)

# Bind pkce and launch.application_id to this initiating user's server session.
# Navigate that user's browser to launch.launch_url.
# At the callback, validate the returned state against that saved transaction.
# Consume it once, then redeem the returned activation code:
session = bridge.redeem(
    code=callback_code,
    code_verifier=pkce.code_verifier,
    application_id=launch.application_id,
    redirect_uri="https://app.example.org/smart/callback",
)
```

`callback_code` denotes your framework's validated callback input. This low-level Python API deliberately leaves browser-session/state binding with your web framework. Never use a single global PKCE transaction for all users. Store transactions temporarily in protected server-side session storage and discard them after use or expiration.

## Gateway, direct access, and handoff

`session.descriptor()` returns normalized launch context and connection metadata. `session.get_fhir_connection("gateway")` uses the SMART Flint FHIR endpoint and local session credential. `session.get_fhir_connection("direct")` uses the original EHR FHIR endpoint; each token-provider call retrieves current upstream credentials from SMART Flint. Configure a lazy authentication hook in your FHIR library so it does not retain one expiring token permanently.

`session.current()` returns the current upstream access credential when permitted. `session.original()` returns an explicit envelope with `token_response`, `refresh_owner`, and `refresh_token_withheld`; the original access token remains unchanged while refresh credentials are withheld during bridge-managed renewal. `session.handoff()` explicitly transfers supported lifecycle responsibilities and returns the current credential, including its refresh token when issued. Inspect `client_authentication`: confidential registrations still require the application's compatible backend authentication, and private keys are not exported. Proof-bound tokens need their corresponding proof mechanism.

`session.close()` closes local SMART Flint access and invalidates its local credential providers. Already exported upstream tokens retain upstream expiration and revocation behavior. Gateway normalization and request auditing apply only to traffic passing through the gateway.

Use HTTPS in deployments. Plain HTTP is accepted only for loopback development endpoints. The default request timeout is 15 seconds and redirects are rejected so credentials cannot follow an unexpected destination. Original token responses and explicitly retrieved credentials remain sensitive even though their standard object representations are redacted; never serialize them into logs, analytics, URLs, or exception reports.
