import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, CheckCircle2, Code2, ExternalLink, FileJson2, FlaskConical, KeyRound, Layers3, LoaderCircle, LockKeyhole, Play, RefreshCw, ShieldCheck, Sparkles, Terminal } from 'lucide-react';
import { SMARTFlintClient, type ActivatedSession } from '@smart-flint/sdk';
import type { AccessMode, ActivationSession, Dashboard, TokenResponse } from '@smart-flint/contracts';
import { modeLabel } from './api';
import { canManage, isPlatformAdmin } from './access';
import { Badge, CopyButton, ErrorNotice, Field, Loading, Notice, VendorMark } from './components';

const client = () => new SMARTFlintClient({ baseUrl: location.origin });

export function DeveloperLab({ data }: { data: Dashboard }) {
  const available = data.installations.filter(item => canManage(data, 'installations', item.id) && item.enabled && data.applications.some(application => application.id === item.applicationId && application.callbackUrls.length > 0));
  const [installationId, setInstallationId] = useState(available[0]?.id || '');
  const installation = available.find(item => item.id === installationId);
  const application = data.applications.find(item => item.id === installation?.applicationId);
  const connection = data.connections.find(item => item.id === installation?.connectionId);
  const [mode, setMode] = useState<AccessMode>(installation?.mode || 'gateway');
  const [callback, setCallback] = useState(application?.callbackUrls.find(url => url === `${location.origin}/reference-app`) || application?.callbackUrls[0] || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const code = `import { SMARTFlintClient } from '@smart-flint/sdk';\n\nconst flint = new SMARTFlintClient({\n  baseUrl: '${data.runtime.baseUrl}'\n});\n\nconst { launchUrl } = await flint.start({\n  installationId: '${installationId || 'your-installation'}',\n  redirectUri: '${callback || `${location.origin}/reference-app`}',\n  mode: '${mode}'\n});\n\nwindow.location.assign(launchUrl);`;
  return <>
    <div className="developer-top"><span className="developer-icon"><FlaskConical size={25} /></span><div><h2>A real launch. A simple application.</h2><p>The local simulator exercises discovery, PKCE, authorization, context, and FHIR reads.</p></div><span className="tag tag-teal">{data.runtime.demo ? 'Synthetic data' : 'Configured endpoints'}</span></div>
    <div className="lab-grid"><section className="panel"><div className="panel-heading"><div><h2>Launch an application</h2><p>Choose an installation and its access route.</p></div><Play size={19} className="muted" /></div><form className="lab-form" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { if (new URL(callback).origin !== location.origin) throw new Error('Start this launch from the application’s own origin using the SDK, or use this workspace’s reference-app callback. Browser transaction storage stays on the initiating origin.'); const result = await client().start({ installationId, redirectUri: callback, mode }); location.assign(result.launchUrl); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to start launch.'); setBusy(false); } }}>
      {error && <ErrorNotice message={error} />}
      <Field label="Installation"><select value={installationId} required onChange={event => { const next = available.find(item => item.id === event.target.value); const app = data.applications.find(item => item.id === next?.applicationId); setInstallationId(event.target.value); setMode(next?.mode || 'gateway'); setCallback(app?.callbackUrls.find(url => url === `${location.origin}/reference-app`) || app?.callbackUrls[0] || ''); }}><option value="">Select an enabled installation</option>{available.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
      {connection && <div className="lab-connection"><VendorMark vendor={connection.vendor} /><span><strong>{connection.name}</strong><small>{data.tenants.find(item => item.id === installation?.tenantId)?.name}</small></span><Badge value={connection.status} /></div>}
      <Field label="Access mode"><select value={mode} onChange={event => setMode(event.target.value as AccessMode)}>{(application?.allowedModes || ['gateway', 'direct', 'handoff']).map(item => <option key={item} value={item} disabled={item !== 'gateway' && !installation?.allowTokenExport}>{modeLabel(item)}{item !== 'gateway' && !installation?.allowTokenExport ? ' · token export disabled' : ''}</option>)}</select></Field>
      <Field label="Application callback" hint="This exact destination must be approved on the application."><select value={callback} required onChange={event => setCallback(event.target.value)}>{application?.callbackUrls.map(url => <option key={url} value={url}>{url}</option>)}</select></Field>
      <div className="launch-explanation"><span className="step-mini">1</span><span>Authorize in the EHR</span><ArrowRight size={13} /><span className="step-mini">2</span><span>Activate your app</span></div>
      <button className="button button-primary full-width" disabled={busy || !installation}>{busy ? <LoaderCircle className="spin" size={17} /> : <ArrowUpRight size={17} />}{busy ? 'Preparing authorization…' : 'Launch application'}</button>
      {!available.length && <p className="muted text-small">Create and enable an installation to run a launch.</p>}
    </form></section>
    <section className="code-panel"><div className="code-panel-heading"><div><span className="code-dot" /><span>Start with the SDK</span></div><span>TypeScript</span></div><pre>{code}</pre><div className="code-panel-footer"><span><Code2 size={14} />The SDK is optional. The API is open.</span><CopyButton text={code} label="Copy code" /></div></section></div>
    <section className="panel developer-contract"><div className="panel-heading"><div><h2>Bring your preferred FHIR client</h2><p>The gateway speaks standard FHIR HTTP. Authentication stays separate from your resource library.</p></div><FileJson2 size={21} className="muted" /></div><div className="contract-grid"><div><span className="eyebrow">AFTER ACTIVATION</span><pre className="light-code">{`const connection = await session.getFHIRConnection({\n  route: '${mode === 'gateway' ? 'gateway' : 'direct'}'\n});\n\n// Configure any FHIR client with:\nconnection.baseUrl;\nawait connection.credentials.getAuthorizationHeader();`}</pre></div><div className="contract-features"><div><CheckCircle2 size={17} /><span><strong>Standard endpoints</strong><small>FHIR base URL and ordinary authorization headers</small></span></div><div><CheckCircle2 size={17} /><span><strong>Current credentials</strong><small>An async provider handles changing token lifetimes</small></span></div><div><CheckCircle2 size={17} /><span><strong>Explicit original-token access</strong><small>Available when the installation permits export</small></span></div><div><CheckCircle2 size={17} /><span><strong>Web and native contracts</strong><small>TypeScript SDK and Swift / Kotlin examples</small></span></div></div></div></section>
    <BackendLab data={data} />
    {isPlatformAdmin(data) ? <CDSLab demo={data.runtime.demo} /> : <Notice>CDS execution tools require platform administrator access. Your assigned integration configuration remains available in the workspace.</Notice>}
    {data.runtime.demo && <Notice>Local EHR environments are protocol simulators. Their Epic and Oracle labels demonstrate tenant routing; they do not establish vendor certification or production compatibility.</Notice>}
  </>;
}

function BackendLab({ data }: { data: Dashboard }) {
  const installations = data.installations.filter(item => canManage(data, 'installations', item.id) && item.enabled && item.scopes.some(scope => scope.startsWith('system/')));
  const [installationId, setInstallationId] = useState(installations[0]?.id || '');
  const [apiKey, setApiKey] = useState(data.runtime.demo ? 'demo-service-key' : '');
  const [result, setResult] = useState<ActivationSession>();
  const [response, setResponse] = useState<unknown>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <section className="panel backend-lab"><div className="panel-heading"><div><h2>Backend service access</h2><p>Acquire preauthorized system access without an interactive browser launch.</p></div><ServerIcon /></div><div className="panel-body">{error && <ErrorNotice message={error} />}<form className="backend-form" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch('/api/service-activations', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ installationId }), cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || 'Unable to establish backend access.');
      setResult(body as ActivationSession); setResponse(undefined); if (!data.runtime.demo) setApiKey('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to establish backend access.'); }
    finally { setBusy(false); }
  }}><Field label="Service installation"><select required value={installationId} onChange={event => setInstallationId(event.target.value)}><option value="">Select a system-scope installation</option>{installations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label="Application API credential" hint={data.runtime.demo ? 'Pre-filled with the local simulator credential.' : 'Use an app API credential or issue a new one below.'}><input type="password" autoComplete="off" value={apiKey} onChange={event => setApiKey(event.target.value)} required /></Field><button className="button button-primary" disabled={busy || !installationId}>{busy ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />}Acquire service session</button></form><div className="backend-credential-tools"><button className="text-button" disabled={busy || !installationId || !canManage(data, 'applications', installations.find(item => item.id === installationId)?.applicationId || '')} onClick={async () => {
    const installation = installations.find(item => item.id === installationId);
    if (!installation) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/admin/applications/${installation.applicationId}/credentials`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store' });
      const body = await response.json(); if (!response.ok) throw new Error(body.message || 'Unable to issue application credential.'); setApiKey(body.apiKey);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to issue application credential.'); }
    finally { setBusy(false); }
  }}><RefreshCw size={13} />Issue a new app credential</button><span>Replaces the previous API credential for this application.</span></div>{result && <div className="backend-result"><div><Badge value={result.activation.status} /><code>{result.activation.id}</code><span className="tag">system authority</span></div><p>Granted scopes: {result.activation.grantedScopes.join(' ')}</p><div className="credential-actions"><button className="button button-outline button-small" disabled={busy} onClick={async () => {
    setBusy(true); setError('');
    try { const session = client().session(result.activation.id, result.sessionToken); const connection = await session.getFHIRConnection(); const response = await fetch(`${connection.baseUrl.replace(/\/$/, '')}/Patient`, { headers: { Authorization: await connection.credentials.getAuthorizationHeader(), Accept: 'application/fhir+json' }, cache: 'no-store' }); const body = await response.json(); if (!response.ok) throw new Error(body.message || `FHIR returned ${response.status}`); setResponse(body); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'FHIR request failed.'); }
    finally { setBusy(false); }
  }}><Play size={13} />Search Patient</button><button className="button button-outline button-small" disabled={busy} onClick={async () => { try { await client().session(result.activation.id, result.sessionToken).close(); setResult(undefined); setResponse(undefined); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to close service session.'); } }}><LockKeyhole size={13} />Close service session</button></div>{response !== undefined && <pre className="code-block">{JSON.stringify(response, null, 2)}</pre>}</div>}</div></section>;
}

function ServerIcon() { return <Terminal size={20} className="muted" />; }

function CDSLab({ demo }: { demo: boolean }) {
  type CDSService = { id: string; hook: string; title: string; description: string };
  type CDSResponse = { cards: { summary: string; detail?: string; indicator: string; source: { label: string } }[] };
  const [services, setServices] = useState<CDSService[]>([]);
  const [serviceId, setServiceId] = useState('');
  const [credential, setCredential] = useState(demo ? 'demo-cds-key' : '');
  const [context, setContext] = useState(JSON.stringify({ patientId: 'patient-a' }, null, 2));
  const [result, setResult] = useState<CDSResponse>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const discover = async () => {
    setBusy(true); setError('');
    try { const response = await fetch('/cds-services', { cache: 'no-store' }); const body = await response.json(); if (!response.ok) throw new Error(body.message || 'CDS discovery failed.'); setServices(body.services); setServiceId((current: string) => body.services.some((service: CDSService) => service.id === current) ? current : (demo ? body.services.find((service: CDSService) => service.id === 'cds_demo')?.id : undefined) || body.services[0]?.id || ''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'CDS discovery failed.'); }
    finally { setBusy(false); }
  };
  useEffect(() => { void discover(); }, []);
  return <section className="panel cds-lab"><div className="panel-heading"><div><h2>CDS Hooks execution</h2><p>Send a request-bound hook invocation and inspect the returned cards.</p></div><button className="text-button" onClick={discover} disabled={busy}><RefreshCw size={13} />Discover services</button></div><div className="panel-body">{error && <ErrorNotice message={error} />}<form onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError(''); setResult(undefined);
    try {
      const service = services.find(item => item.id === serviceId); if (!service) throw new Error('Select a discovered CDS service.');
      const parsed = JSON.parse(context); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Hook context must be a JSON object.');
      const response = await fetch(`/cds-services/${encodeURIComponent(serviceId)}`, { method: 'POST', headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ hook: service.hook, hookInstance: crypto.randomUUID(), context: parsed }), cache: 'no-store' });
      const body = await response.json(); if (!response.ok) throw new Error(body.message || `CDS invocation returned ${response.status}`); setResult(body);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The CDS invocation failed.'); }
    finally { setBusy(false); }
  }}><div className="form-grid"><Field label="CDS service"><select value={serviceId} onChange={event => setServiceId(event.target.value)} required><option value="">{services.length ? 'Select service' : 'No services discovered'}</option>{services.map(service => <option key={service.id} value={service.id}>{service.title} · {service.hook}</option>)}</select></Field><Field label="Caller credential" hint={demo ? 'Local fixture key. Production callers use signed assertions.' : 'Supply a signed caller JWT for the configured service.'}><input type="password" autoComplete="off" value={credential} onChange={event => setCredential(event.target.value)} required /></Field></div><Field label="Hook context (JSON)"><textarea rows={4} spellCheck={false} value={context} onChange={event => setContext(event.target.value)} required /></Field><button className="button button-primary" disabled={busy || !serviceId}>{busy ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}Invoke hook</button></form>{result && <div className="cds-result"><h3>{result.cards.length} decision-support {result.cards.length === 1 ? 'card' : 'cards'}</h3>{result.cards.map((card, index) => <article className={`cds-card cds-${card.indicator}`} key={index}><div><span className="tag">{card.indicator}</span><span>{card.source.label}</span></div><h3>{card.summary}</h3>{card.detail && <p>{card.detail}</p>}</article>)}<details className="json-details"><summary>View CDS Hooks response</summary><pre>{JSON.stringify(result, null, 2)}</pre></details></div>}</div></section>;
}

let callbackCompletion: Promise<ActivationSession> | undefined;
let ehrResumption: Promise<void> | undefined;

export function ReferenceApp() {
  const [result, setResult] = useState<ActivationSession>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [route, setRoute] = useState<'gateway' | 'direct'>('gateway');
  const [request, setRequest] = useState('');
  const [response, setResponse] = useState<unknown>();
  const [requestStatus, setRequestStatus] = useState('');
  const [credentials, setCredentials] = useState<unknown>();
  const [reveal, setReveal] = useState(false);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const session: ActivatedSession | undefined = useMemo(() => result ? client().session(result.activation.id, result.sessionToken) : undefined, [result]);

  useEffect(() => {
    let cancelled = false;
    const params = new URL(location.href).searchParams;
    if (params.has('smart_flint_launch') || ehrResumption) {
      ehrResumption ??= client().resumeEHRLaunch().then(start => { location.assign(start.launchUrl); });
      ehrResumption.catch(cause => { if (!cancelled) { setError(cause instanceof Error ? cause.message : 'Unable to resume EHR launch.'); setInitializing(false); } });
    } else if (params.has('code') || params.has('error') || callbackCompletion) {
      callbackCompletion ??= client().completeRedirect();
      callbackCompletion.then(value => { if (!cancelled) { setResult(value); setRoute(value.activation.mode === 'gateway' ? 'gateway' : 'direct'); setRequest(value.activation.context.patient?.reference || 'metadata'); setInitializing(false); } }).catch(cause => { if (!cancelled) { setError(cause instanceof Error ? cause.message : 'Unable to complete activation.'); setInitializing(false); } });
    } else { setInitializing(false); }
    return () => { cancelled = true; };
  }, []);

  async function readFHIR() {
    if (!session) return;
    setBusy(true); setError(''); setResponse(undefined); setRequestStatus('');
    try {
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(request) || request.includes('..')) throw new Error('Use a relative FHIR path, such as Patient/example or Observation?patient=example.');
      const connection = await session.getFHIRConnection({ route });
      const response = await fetch(`${connection.baseUrl.replace(/\/$/, '')}/${request.replace(/^\//, '')}`, { headers: { Authorization: await connection.credentials.getAuthorizationHeader(), Accept: 'application/fhir+json' }, cache: 'no-store', redirect: 'error' });
      setRequestStatus(`${response.status} ${response.statusText}`);
      const payload = await response.json().catch(() => ({ message: 'The server returned a non-JSON response.' }));
      setResponse(payload);
      if (!response.ok) setError(`FHIR request returned ${response.status}. Inspect the response below.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'FHIR request failed.'); }
    finally { setBusy(false); }
  }

  const redact = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(redact);
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, /token|secret|assertion/i.test(key) && !/^(?:token_type|tokenType|tokenEndpoint|token_endpoint)$/.test(key) && typeof field === 'string' ? '[hidden — available to this application]' : redact(field)]));
  };
  return <div className="reference-shell"><header className="reference-header"><a className="reference-brand" href="/"><Sparkles size={25} /><span>SMART<span> Flint</span></span><span className="reference-separator" /><span>Reference application</span></a><a className="button button-outline button-small" href="/#developer"><ArrowLeft size={14} />Back to console</a></header><main className="reference-main"><div className="reference-intro"><span className="page-eyebrow"><span />DEVELOPER REFERENCE APPLICATION</span><h1>Your app starts here.</h1><p>A small application receiving context and accessing FHIR through your chosen route.</p></div>{initializing ? <Loading label="Completing the secure activation handshake…" /> : <>
      {error && <ErrorNotice message={error} />}
      {!result ? <section className="panel reference-empty"><span className="feature-icon"><FlaskConical size={26} /></span><h2>{error ? 'The activation could not complete' : 'Ready for your next launch'}</h2><p>Start a launch from the developer lab or an EHR launch URL. This page completes the app-bound handshake and receives its own session.</p><a className="button button-primary" href="/#developer">Open developer lab <ArrowRight size={16} /></a></section> : <>
        <div className={`activation-success ${closed ? 'activation-closed' : ''}`}><span><CheckCircle2 size={24} /></span><div><h2>{closed ? 'Activation closed' : 'Application activated'}</h2><p>{closed ? 'The SMART Flint session is no longer usable.' : 'Authorization is complete. Context and FHIR access are ready.'}</p></div><Badge value={closed ? 'closed' : result.activation.status} /></div>
        <div className="reference-grid"><section className="panel"><div className="panel-heading"><div><h2>Activation context</h2><p>Delivered through the same contract for every connection.</p></div><Layers3 size={19} className="muted" /></div><div className="panel-body"><div className="context-row"><span>Activation</span><code>{result.activation.id}</code></div><div className="context-row"><span>Organization</span><code>{result.activation.tenantId}</code></div><div className="context-row"><span>Patient</span><code>{result.activation.context.patient?.reference || 'Not supplied'}</code></div><div className="context-row"><span>Encounter</span><code>{result.activation.context.encounter?.reference || 'Not supplied'}</code></div><div className="context-row"><span>Access mode</span><strong>{modeLabel(result.activation.mode)}</strong></div><div className="context-row"><span>Refresh owner</span><strong>{result.activation.refreshOwner}</strong></div><div className="context-row"><span>FHIR version</span><code>{result.activation.upstream.fhirVersion}</code></div><details className="json-details"><summary>Complete activation descriptor</summary><pre>{JSON.stringify(result.activation, null, 2)}</pre></details><button className="button button-outline button-small close-session" disabled={closed || busy} onClick={async () => { try { await session!.close(); setClosed(true); setCredentials(undefined); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to close session.'); } }}><LockKeyhole size={14} />Close SMART Flint session</button></div></section>
        <section className="panel"><div className="panel-heading"><div><h2>Make a FHIR request</h2><p>Plain HTTP. No proprietary resource client.</p></div><Terminal size={20} className="muted" /></div><form className="lab-form" onSubmit={event => { event.preventDefault(); void readFHIR(); }}><Field label="FHIR route"><select value={route} onChange={event => setRoute(event.target.value as 'gateway' | 'direct')} disabled={closed}><option value="gateway">Managed gateway</option><option value="direct" disabled={!result.activation.tokenExportAllowed}>Original upstream FHIR server{!result.activation.tokenExportAllowed ? ' · token export disabled' : ''}</option></select></Field><div className="request-url"><span>BASE URL</span><code>{route === 'gateway' ? result.activation.gateway.baseUrl : result.activation.upstream.baseUrl}</code></div><Field label="Relative request path"><input value={request} onChange={event => setRequest(event.target.value)} required spellCheck={false} disabled={closed} /></Field><div className="request-presets"><button type="button" onClick={() => setRequest(result.activation.context.patient?.reference || 'Patient')} disabled={closed}>Patient in context</button><button type="button" onClick={() => setRequest(`Observation${result.activation.context.patient ? `?patient=${encodeURIComponent(result.activation.context.patient.reference.split('/').pop() || '')}` : ''}`)} disabled={closed}>Observations</button><button type="button" onClick={() => setRequest('metadata')} disabled={closed}>Metadata</button></div><button className="button button-primary full-width" disabled={busy || closed}>{busy ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}{busy ? 'Requesting FHIR data…' : 'Send GET request'}</button></form></section></div>
        {response !== undefined && <section className="panel response-panel"><div className="panel-heading"><h2>FHIR response</h2><span className="tag tag-teal">{requestStatus}</span></div><pre className="code-block fhir-response">{JSON.stringify(response, null, 2)}</pre></section>}
        <section className="panel credentials-panel"><div className="panel-heading"><div><h2>Original credentials</h2><p>Explicit access to the upstream response, when this installation permits it.</p></div><KeyRound size={20} className="muted" /></div><div className="panel-body"><div className="credential-actions"><button className="button button-outline" disabled={credentialBusy || closed || !result.activation.tokenExportAllowed} onClick={async () => { setCredentialBusy(true); setError(''); try { setCredentials(await session!.credentials.original()); setReveal(false); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to read original credentials.'); } finally { setCredentialBusy(false); } }}>{credentialBusy ? <LoaderCircle className="spin" size={15} /> : <FileJson2 size={15} />}Inspect original token response</button><button className="button button-outline" disabled={credentialBusy || closed || !result.activation.tokenExportAllowed || result.activation.mode !== 'handoff' || result.activation.refreshOwner === 'application'} onClick={async () => { setCredentialBusy(true); setError(''); try { const handoff = await session!.credentials.handoff(); setCredentials(handoff); setResult(previous => previous ? { ...previous, activation: { ...previous.activation, refreshOwner: 'application' } } : previous); setReveal(false); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to transfer credentials.'); } finally { setCredentialBusy(false); } }}><ArrowUpRight size={15} />Transfer refresh ownership</button></div>{!result.activation.tokenExportAllowed && <p className="muted text-small">Original-token access is disabled for this installation. It can be configured in the management console.</p>}{credentials !== undefined && <div className="credential-result"><div className="credential-result-heading"><span className="text-small muted">Credentials stay in this page’s memory.</span><label className="check-row"><input type="checkbox" checked={reveal} onChange={event => setReveal(event.target.checked)} />Show token values</label></div><pre className="code-block">{JSON.stringify(reveal ? credentials : redact(credentials), null, 2)}</pre></div>}</div></section>
        <Notice>Direct calls use the original server’s permissions and CORS configuration. Closing this SMART Flint session does not guarantee upstream revocation of an already exported token.</Notice>
      </>}
    </>}</main><footer className="reference-footer"><ShieldCheck size={15} />Application credentials stay in memory. Reloading requires a new launch.</footer></div>;
}
