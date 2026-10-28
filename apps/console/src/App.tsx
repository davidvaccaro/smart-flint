import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, ArrowDownLeft, ArrowRight, ArrowUpRight, BookOpen, Building2, Check, CheckCircle2,
  ChevronRight, CircleHelp, Code2, FlaskConical, Globe2,
  Layers3, LayoutDashboard, LoaderCircle, LockKeyhole, LogOut, Menu, Network,
  Plus, RefreshCw, Server, Settings2, ShieldCheck, Sparkles, Terminal, Waypoints, X
} from 'lucide-react';
import type { AdminSessionStatus, Dashboard } from '@smart-flint/contracts';
import { ApiError, api, post, relativeTime } from './api';
import { Badge, CopyButton, Empty, ErrorNotice, Loading, Notice, VendorMark } from './components';
import { FormDialog, type FormContext, type FormKind } from './Forms';
import { Workspace, type OpenForm, type WorkspaceRoute, type WorkspaceView } from './Workspace';
import { DeveloperLab, ReferenceApp } from './Lab';
import { Samples } from './Samples';
import { UsersAndAccess } from './Users';
import { SignIn, type SignInCredentials } from './SignIn';
import { canCreateForm, canUseDeveloperLab, canWrite, isPlatformAdmin, roleLabel } from './access';

type View = WorkspaceView;
const navigation = [
  { id: 'applications', label: 'Applications', icon: Layers3 },
  { id: 'platforms', label: 'EHR Platforms', icon: Globe2 },
  { id: 'organizations', label: 'Organizations', icon: Building2 },
  { id: 'installations', label: 'Installations', icon: Waypoints },
  { id: 'activations', label: 'Activations', icon: Activity },
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'developer', label: 'Developer lab', icon: Terminal },
  { id: 'samples', label: 'Sample library', icon: BookOpen },
  { id: 'settings', label: 'Settings & API', icon: Settings2 }
] as const;
const viewCopy: Record<View, { title: string; description: string }> = {
  applications: { title: 'Applications', description: 'Manage your apps and the EHR environments where they run.' },
  platforms: { title: 'EHR Platforms', description: 'Manage vendor profiles, app registrations, and integration evidence.' },
  organizations: { title: 'Organizations', description: 'Manage your customer organizations and their EHR connections.' },
  installations: { title: 'Installations', description: 'Bring applications, organizations, connections, and registrations together.' },
  activations: { title: 'Activations', description: 'Follow application sessions and every launch attempt.' },
  overview: { title: 'Workspace overview', description: 'Your applications, EHR connections, and launches in one place.' },
  developer: { title: 'Developer lab', description: 'Exercise a real SMART launch and bring your own FHIR client.' },
  samples: { title: 'Sample library', description: 'Real application flows. Shared health-review logic. Clear interoperability evidence.' },
  settings: { title: 'Settings & API', description: 'Deployment details, integration contracts, and operating guidance.' }
};

function initialRoute(): WorkspaceRoute {
  const [path, query] = location.hash.slice(1).split('?');
  const [candidate, id] = path.split('/');
  if (candidate === 'connections') return { view: 'organizations' };
  const view = navigation.some(item => item.id === candidate) ? candidate as View : 'applications';
  return { view, ...(id ? { id } : {}), tab: new URLSearchParams(query).get('tab') || undefined };
}

export function App() {
  const [authentication, setAuthentication] = useState<AdminSessionStatus>();
  const [authError, setAuthError] = useState(() => { const url = new URL(location.href); const code = url.searchParams.get('admin_error'); if (!code) return ''; url.searchParams.delete('admin_error'); history.replaceState(null, '', url); return code === 'access_not_granted' ? 'Your identity is verified, but access has not been granted. Contact a platform administrator.' : 'Organization sign-in could not complete. Start a fresh sign-in to try again.'; });
  const [authNotice] = useState(() => { const url = new URL(location.href); if (url.searchParams.get('password_changed') !== '1') return ''; url.searchParams.delete('password_changed'); history.replaceState(null, '', url); return 'Password changed. Sign in again with your new password.'; });
  const [signingIn, setSigningIn] = useState(false);
  const [data, setData] = useState<Dashboard>();
  const [error, setError] = useState('');
  const [route, setRoute] = useState<WorkspaceRoute>(initialRoute);
  const view = route.view;
  const [search, setSearch] = useState('');
  const [form, setForm] = useState<{ kind: FormKind; context?: FormContext }>();
  const openForm: OpenForm = (kind, context) => { if (!data || !canCreateForm(data, kind, context)) { setError('Your role or resource assignment does not allow this action.'); return; } setForm({ kind, context }); };
  const [mobileMenu, setMobileMenu] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState('');
  const isReference = location.pathname.startsWith('/reference-app');
  const accessSignature = useRef('');
  const authenticationGeneration = useRef(0);

  useEffect(() => { if (!isReference) api<AdminSessionStatus>('/api/admin/session').then(setAuthentication).catch(cause => setAuthError(cause.message)); }, [isReference]);
  const refresh = useCallback(async () => {
    const generation = authenticationGeneration.current;
    setRefreshing(true);
    try { const next = await api<Dashboard>('/api/admin/dashboard'); if (generation !== authenticationGeneration.current) return; const signature = JSON.stringify(next.access?.identity); if (accessSignature.current && accessSignature.current !== signature) setForm(undefined); accessSignature.current = signature; setData(next); setError(''); }
    catch (cause) { if (generation !== authenticationGeneration.current) return; if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) { authenticationGeneration.current++; setData(undefined); setForm(undefined); api<AdminSessionStatus>('/api/admin/session').then(setAuthentication).catch(() => setAuthentication(undefined)); } setError(cause instanceof Error ? cause.message : 'Unable to load workspace.'); }
    finally { setRefreshing(false); }
  }, []);
  useEffect(() => {
    if (!authentication?.authenticated) return;
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 20_000);
    return () => clearInterval(timer);
  }, [authentication, refresh]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    const listener = () => { setRoute(initialRoute()); setSearch(''); };
    addEventListener('hashchange', listener);
    return () => removeEventListener('hashchange', listener);
  }, []);
  const navigate = (next: View, id?: string, tab?: string) => { location.hash = `${next}${id ? `/${encodeURIComponent(id)}` : ''}${tab ? `?tab=${encodeURIComponent(tab)}` : ''}`; setRoute({ view: next, id, tab }); setSearch(''); setMobileMenu(false); };
  const mutate = async (action: () => Promise<unknown>, message: string) => {
    try { if (!data || !canWrite(data)) throw new Error('Your role does not allow configuration changes.'); await action(); await refresh(); setToast(message); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The action could not be completed.'); }
  };

  const signIn = async (credentials: SignInCredentials) => {
    authenticationGeneration.current++; setData(undefined); setForm(undefined); setSigningIn(true); setAuthError('');
    try { await post('/api/admin/session', credentials); setAuthentication(await api<AdminSessionStatus>('/api/admin/session')); }
    catch (cause) { setAuthError(cause instanceof Error ? cause.message : 'Unable to sign in.'); }
    finally { setSigningIn(false); }
  };

  if (isReference) return <ReferenceApp />;
  if (!authentication?.authenticated) return <SignIn status={authentication} error={authError} notice={authNotice} busy={signingIn} signIn={signIn} retry={() => { setAuthError(''); api<AdminSessionStatus>('/api/admin/session').then(setAuthentication).catch(cause => setAuthError(cause.message)); }} />;

  return <div className="app-shell">
    {mobileMenu && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobileMenu(false)} />}
    <aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}>
      <a href="#applications" className="brand" onClick={() => navigate('applications')}><span className="brand-symbol"><Sparkles size={24} strokeWidth={1.8} /></span><span>SMART<span className="brand-light"> Flint</span><span className="brand-caption">INTEGRATION CONSOLE</span></span></a>
      <div className="workspace-switch"><span className="workspace-avatar">SF</span><span><strong>{data?.access?.identity.displayName || authentication.identity?.displayName || 'My workspace'}</strong><small>{data?.access ? roleLabel(data.access.identity.role) : data?.runtime.demo ? 'Local development' : 'Self-hosted deployment'}</small></span><span className="workspace-indicator" title="Current workspace" /></div>
      <span className="nav-section-label">WORKSPACE</span>
      <nav aria-label="Main navigation">{navigation.slice(0, 5).map(item => <button key={item.id} className={`nav-link ${view === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)}><item.icon size={19} /><span>{item.label}</span>{item.id === 'activations' && !!data?.activations.filter(item => item.status === 'ready').length && <span className="nav-count">{data.activations.filter(item => item.status === 'ready').length}</span>}</button>)}</nav>
      <span className="nav-section-label nav-section-second">BUILD & MANAGE</span><nav aria-label="Development and settings">{navigation.slice(5).filter(item => item.id !== 'developer' || !!data && canUseDeveloperLab(data)).map(item => <button key={item.id} className={`nav-link ${view === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)}><item.icon size={19} /><span>{item.label}</span></button>)}</nav>
      <div className="sidebar-bottom"><div className="selfhosted-label"><span /><span>Running in your environment</span></div><div className="sidebar-version"><span>SMART Flint <b>v{data?.runtime.version || '0.1.0'}</b></span><button title="Sign out" aria-label="Sign out" onClick={async () => { authenticationGeneration.current++; setData(undefined); setForm(undefined); accessSignature.current = ''; try { await api('/api/admin/session', { method: 'DELETE' }); } catch (cause) { setAuthError(cause instanceof Error ? cause.message : 'The previous session could not be confirmed closed.'); } finally { try { setAuthentication(await api<AdminSessionStatus>('/api/admin/session')); } catch { setAuthentication(undefined); setAuthError('Unable to reconnect to the sign-in service.'); } } }}><LogOut size={17} /></button></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><button className="mobile-menu icon-button" aria-label="Open navigation" onClick={() => setMobileMenu(true)}><Menu size={21} /></button><span>Workspace</span><ChevronRight size={13} /><strong>{navigation.find(item => item.id === view)?.label}</strong></div><div className="topbar-right"><span className="deployment-chip"><Server size={13} />{data?.runtime.demo ? 'Local sandbox' : 'Self-hosted'}</span><button className="icon-button help-button" title="Integration guide" aria-label="Open integration guide" onClick={() => navigate('settings')}><CircleHelp size={19} /></button><span className="admin-avatar" title={`${data?.access?.identity.displayName || authentication.identity?.displayName || 'Workspace identity'} · ${roleLabel(data?.access?.identity.role || authentication.identity?.role)}`}>{(data?.access?.identity.displayName || authentication.identity?.displayName || 'User').split(/\s+/).map(value => value[0]).slice(0, 2).join('').toUpperCase()}</span></div></header>
      <main>
        <div className="page-heading"><div><div className="page-eyebrow"><span />{view === 'overview' ? 'CONNECTED BY DESIGN' : 'SMART FLINT WORKSPACE'}</div><h1>{viewCopy[view].title}</h1><p>{viewCopy[view].description}</p></div><div className="heading-actions"><button className="button button-quiet button-refresh" title="Refresh workspace" onClick={refresh} disabled={refreshing}><RefreshCw size={16} className={refreshing ? 'spin' : ''} /><span>Refresh</span></button>{view === 'overview' && data && canCreateForm(data, 'connection') ? <button className="button button-primary" onClick={() => openForm('connection')}><Plus size={17} />Add connection</button> : view === 'platforms' && data && canCreateForm(data, 'platform') ? <button className="button button-primary" onClick={() => openForm('platform')}><Plus size={17} />Add EHR platform</button> : view === 'organizations' && data && canCreateForm(data, 'tenant') ? <button className="button button-primary" onClick={() => openForm('tenant')}><Plus size={17} />Add organization</button> : view === 'applications' && data && canCreateForm(data, 'application') ? <button className="button button-primary" onClick={() => openForm('application')}><Plus size={17} />Add application</button> : view === 'installations' && data && canCreateForm(data, 'installation') ? <button className="button button-primary" onClick={() => openForm('installation')}><Plus size={17} />Create installation</button> : view === 'activations' && data && canUseDeveloperLab(data) ? <button className="button button-primary" onClick={() => navigate('developer')}><FlaskConical size={17} />Test a launch</button> : null}</div></div>
        {error && <div className="page-error"><ErrorNotice message={error} /><button aria-label="Dismiss error" className="icon-button" onClick={() => setError('')}><X size={15} /></button></div>}
        {!data ? error ? <Empty title="Workspace unavailable" action={<button className="button button-primary" onClick={refresh}>Try again</button>}>Check that the SMART Flint service is running and try refreshing.</Empty> : <Loading /> : <>
          {!data.access?.platformAdmin && <div className="access-scope-banner"><ShieldCheck size={16} /><span><strong>{roleLabel(data.access?.identity.role)}</strong> · Assigned organizations and applications. Shared resources may be read-only.</span></div>}{data.runtime.demo && canUseDeveloperLab(data) && view === 'overview' && <div className="sandbox-banner"><FlaskConical size={17} /><span><strong>A safe place to connect.</strong> This workspace uses synthetic data and a local EHR simulator.</span><button onClick={() => navigate('developer')}>Open developer lab <ArrowRight size={14} /></button></div>}
          {view === 'overview' && <Overview data={data} navigate={navigate} openForm={openForm} />}
          {['applications', 'platforms', 'organizations', 'installations', 'activations'].includes(view) && <Workspace data={data} route={route} go={navigate} search={search} setSearch={setSearch} openForm={openForm} mutate={mutate} />}
          {view === 'developer' && !canUseDeveloperLab(data) && <Notice>Your role allows viewing integration configuration. Developer execution requires permission to manage the installation.</Notice>}{view === 'developer' && canUseDeveloperLab(data) && <DeveloperLab key={route.id || 'default'} data={route.id ? { ...data, installations: [...data.installations].sort((a, b) => Number(b.id === route.id) - Number(a.id === route.id)) } : data} />}
          {view === 'samples' && <Samples data={data} />}
          {view === 'settings' && <><UsersAndAccess data={data} refreshed={refresh} /><Settings data={data} /></>}
        </>}
      </main><footer className="page-footer"><span>SMART Flint <span className="footer-dot">·</span> Source available. In your control.</span><span>SMART App Launch 2.2 <span className="footer-dot">·</span> FHIR R4</span></footer>
    </div>
    {form && data && canCreateForm(data, form.kind, form.context) && <FormDialog kind={form.kind} context={form.context} data={data} close={() => setForm(undefined)} saved={refresh} />}
    {toast && <div className="toast" role="status"><CheckCircle2 size={18} />{toast}<button aria-label="Dismiss notification" onClick={() => setToast('')}><X size={15} /></button></div>}
  </div>;
}

function Overview({ data, navigate, openForm }: { data: Dashboard; navigate: (view: View) => void; openForm: OpenForm }) {
  const verified = data.connections.filter(item => item.status === 'verified').length;
  const ready = data.activations.filter(item => item.status === 'ready').length;
  const activeInstallations = data.installations.filter(item => item.enabled).length;
  const metrics = [
    { label: 'EHR connections', value: data.connections.length, text: `${verified} verified · ${data.tenants.length} organizations`, icon: Network, view: 'organizations' as View, tone: 'teal' },
    { label: 'Applications', value: data.applications.length, text: 'One contract across every connection', icon: Layers3, view: 'applications' as View, tone: 'blue' },
    { label: 'Enabled installations', value: activeInstallations, text: `${data.installations.length} configured in this workspace`, icon: Waypoints, view: 'installations' as View, tone: 'purple' },
    { label: 'Ready activations', value: ready, text: `${data.activations.length} recent launches shown`, icon: Activity, view: 'activations' as View, tone: 'orange' }
  ];
  return <>
    <div className="metric-grid">{metrics.map(metric => <button className="metric-card" key={metric.label} onClick={() => navigate(metric.view)}><div className="metric-top"><span>{metric.label}</span><span className={`metric-icon metric-${metric.tone}`}><metric.icon size={18} /></span></div><strong>{metric.value.toString().padStart(2, '0')}</strong><div className="metric-bottom"><span>{metric.text}</span><ArrowUpRight size={14} /></div></button>)}</div>
    <div className="overview-grid"><section className="panel connections-panel"><div className="panel-heading"><div><h2>Connected environments <span className="count-pill">{data.connections.length}</span></h2><p>Your EHR landscape, at a glance.</p></div><button className="text-button" onClick={() => navigate('organizations')}>View all <ArrowRight size={14} /></button></div>{data.connections.length ? <div className="table-scroll"><table><thead><tr><th>Connection</th><th>Organization</th><th>Status</th><th /></tr></thead><tbody>{data.connections.slice(0, 5).map(connection => <tr key={connection.id}><td><div className="entity-cell"><VendorMark vendor={connection.vendor} /><div><strong>{connection.name}</strong><small>{connection.environment} <span>·</span> FHIR {connection.fhirVersion}</small></div></div></td><td><span className="table-secondary">{data.tenants.find(item => item.id === connection.tenantId)?.name || connection.tenantId}</span></td><td><Badge value={connection.status} /></td><td><button className="icon-button" title={`View ${connection.name}`} onClick={() => navigate('organizations')}><ArrowUpRight size={16} /></button></td></tr>)}</tbody></table></div> : <Empty title="Your first connection starts here" action={<button className="button button-primary" disabled={!canCreateForm(data, 'connection')} onClick={() => openForm('connection')}><Plus size={16} />Add connection</button>}>Connect a FHIR endpoint to discover its SMART capabilities.</Empty>}<div className="panel-bottom"><span><ShieldCheck size={14} />Credentials are encrypted at rest</span><span>Explicit tenant boundaries</span></div></section>
    <section className="launch-card"><div className="launch-card-art"><div className="launch-node launch-node-one"><Layers3 size={22} /></div><div className="launch-line" /><div className="launch-node launch-node-two"><Waypoints size={25} /></div><div className="launch-line" /><div className="launch-node launch-node-three"><Server size={22} /></div></div><span className="eyebrow">LESS PLUMBING. MORE BUILDING.</span><h2>Your next SMART launch, without the guesswork.</h2><p>Try the reference application to follow authorization, receive context, and read FHIR data.</p><button className="button button-light" disabled={!canUseDeveloperLab(data)} onClick={() => navigate('developer')}>Launch developer lab <ArrowRight size={16} /></button><span className="launch-card-note"><Code2 size={14} />Use the SDK or bring your own client</span></section></div>
    <div className="overview-bottom"><section className="panel activity-panel"><div className="panel-heading"><div><h2>Recent activity</h2><p>Configuration and runtime events from this deployment.</p></div><button className="text-button" onClick={() => navigate('activations')}>View activations <ArrowRight size={14} /></button></div><div className="event-list">{data.events.length ? data.events.slice(0, 5).map(event => <div className="event-row" key={event.id}><span className={`event-icon event-${event.outcome}`}>{event.outcome === 'success' ? <Check size={15} /> : event.outcome === 'failure' ? <X size={15} /> : <ArrowDownLeft size={15} />}</span><div><strong>{event.action.replaceAll('.', ' ').replaceAll('_', ' ')}</strong><p>{event.detail}</p>{event.actor && <span className="event-actor">By {event.actor.displayName}</span>}</div><time title={new Date(event.at).toLocaleString()}>{relativeTime(event.at)}</time></div>) : <div className="subtle-empty">Events will appear here as you configure connections and run launches.</div>}</div></section>
    <section className="panel setup-panel"><div className="panel-heading"><div><h2>A clear path to integration</h2><p>Four steps from app to activation.</p></div><BookOpen size={19} className="muted" /></div><div className="setup-list">{[
      { title: 'Define your application', text: 'Callbacks, context, and required scopes', done: data.applications.length > 0, action: () => openForm('application') },
      { title: 'Connect an EHR environment', text: 'Discover and verify an approved endpoint', done: verified > 0, action: () => navigate('organizations') },
      { title: 'Configure an installation', text: 'Choose registration and access policy', done: activeInstallations > 0, action: () => openForm('installation') },
      { title: 'Run a SMART launch', text: 'Confirm context and read FHIR data', done: data.activations.some(item => item.grantedScopes.length > 0 && ['ready', 'closed'].includes(item.status)), action: () => navigate('developer') }
    ].map((item, index) => <button className="setup-row" key={item.title} disabled={index === 0 ? !isPlatformAdmin(data) : index === 2 ? !canCreateForm(data, 'installation') : index === 3 ? !canUseDeveloperLab(data) : false} onClick={item.action}><span className={`setup-number ${item.done ? 'done' : ''}`}>{item.done ? <Check size={13} /> : index + 1}</span><span><strong>{item.title}</strong><small>{item.text}</small></span><ChevronRight size={15} /></button>)}</div></section></div>
  </>;
}

function Settings({ data }: { data: Dashboard }) {
  return <div className="settings-grid"><section className="panel"><div className="panel-heading"><div><h2>Your deployment</h2><p>Runtime information for this SMART Flint installation.</p></div><Server size={20} className="muted" /></div><div className="panel-body"><Detail label="Version" value={`v${data.runtime.version}`} /><Detail label="Storage" value={data.runtime.storage} /><Detail label="Runtime URL" value={data.runtime.baseUrl} copy /><Detail label="Console URL" value={data.runtime.consoleUrl} copy /><Detail label="Environment" value={data.runtime.demo ? 'Local development · synthetic EHR simulator' : 'Self-hosted'} /><Notice>Signing keys, encryption keys, database connections, and identity provider settings are supplied through your deployment environment. Secret values are never returned here.</Notice></div></section><section className="panel"><div className="panel-heading"><div><h2>Integration contract</h2><p>Build with an SDK or call the versioned HTTP API.</p></div><Code2 size={20} className="muted" /></div><div className="panel-body"><a className="resource-link" href={`${data.runtime.baseUrl}/api/openapi.json`} target="_blank" rel="noreferrer"><span className="resource-icon"><BookOpen size={20} /></span><span><strong>OpenAPI specification</strong><small>Endpoint shapes and authentication</small></span><ArrowUpRight size={17} /></a><a className="resource-link" href="https://hl7.org/fhir/smart-app-launch/STU2.2/" target="_blank" rel="noreferrer"><span className="resource-icon"><Globe2 size={20} /></span><span><strong>SMART App Launch 2.2</strong><small>HL7 published implementation guide</small></span><ArrowUpRight size={17} /></a><a className="resource-link" href="https://cds-hooks.hl7.org/" target="_blank" rel="noreferrer"><span className="resource-icon"><Activity size={20} /></span><span><strong>CDS Hooks</strong><small>Decision-support invocation specification</small></span><ArrowUpRight size={17} /></a></div></section><section className="panel settings-wide"><div className="panel-heading"><div><h2>Choose the right access mode</h2><p>Launch orchestration, credential management, and FHIR transport are independent choices.</p></div></div><div className="mode-comparison"><article><span className="feature-icon"><ShieldCheck size={21} /></span><h3>Managed gateway</h3><p>Route FHIR traffic through SMART Flint. Keep upstream tokens server-side and apply the configured normalization profile.</p><span className="tag tag-teal">App → SMART Flint → EHR</span></article><article><span className="feature-icon"><ArrowUpRight size={21} /></span><h3>Managed direct</h3><p>Call the original EHR server with your preferred client. SMART Flint supplies current access tokens and owns refresh.</p><span className="tag">App → EHR</span></article><article><span className="feature-icon"><KeyIcon /></span><h3>Credential handoff</h3><p>Retrieve supported original credentials and assume their lifecycle. Upstream client authentication requirements still apply.</p><span className="tag">Application-owned lifecycle</span></article></div></section><section className="panel settings-wide"><div className="panel-heading"><div><h2>Operational boundaries</h2><p>Capabilities follow the configured connection and upstream grant.</p></div></div><div className="operating-notes"><div><strong>Registration and enablement</strong><p>Maintain vendor portal registration and organization-local activation. Use each installation’s worksheet for exact launch and callback values.</p></div><div><strong>Direct access</strong><p>Browser calls depend on upstream CORS. Gateway normalization and request auditing apply only to traffic passing through the gateway.</p></div><div><strong>Context isolation</strong><p>Each activation carries its own patient and connection context. Initial SMART context does not imply ongoing chart synchronization.</p></div></div></section></div>;
}

function KeyIcon() { return <LockKeyhole size={21} />; }
function Detail({ label, value, copy = false }: { label: string; value: string; copy?: boolean }) { return <div className="detail-row"><span>{label}</span><div><code>{value}</code>{copy && <CopyButton text={value} label="" />}</div></div>; }
