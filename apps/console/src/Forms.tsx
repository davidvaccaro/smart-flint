import { useState, type FormEvent, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ArrowLeft, ArrowRight, Check, KeyRound, LoaderCircle, Network, Plus, ShieldCheck } from 'lucide-react';
import type { AccessMode, AppRegistration, Application, Connection, Dashboard, EHRPlatform, Installation, Registration, Tenant } from '@smart-flint/contracts';
import { modeLabel, post, splitLines, splitScopes } from './api';
import { ErrorNotice, Field, Modal } from './components';
import { canCreateForm } from './access';

export type FormKind = 'tenant' | 'application' | 'connection' | 'registration' | 'installation' | 'platform' | 'app-registration' | 'registration-client';
export interface FormContext { applicationId?: string; tenantId?: string; platformId?: string; appRegistrationId?: string; connectionId?: string }
type ResourceKind = Exclude<FormKind, 'installation'>;
type ResourceRecord = Tenant | Application | Connection | Registration | EHRPlatform | AppRegistration;
const titles: Record<FormKind, string> = {
  tenant: 'Add an organization', application: 'Register an application', connection: 'Connect an EHR',
  registration: 'Add an OAuth client profile', installation: 'Create an installation', platform: 'Add an EHR platform',
  'app-registration': 'Add an app registration', 'registration-client': 'Add an OAuth client profile'
};
const vendorOptions = [{ id: 'generic', name: 'Generic SMART / FHIR' }, { id: 'epic', name: 'Epic' }, { id: 'oracle', name: 'Oracle Health' }, { id: 'meditech', name: 'MEDITECH' }];
const authenticationOptions = [{ id: 'none', name: 'Public client (PKCE)' }, { id: 'client_secret_basic', name: 'Client secret · HTTP Basic' }, { id: 'client_secret_post', name: 'Client secret · POST' }, { id: 'private_key_jwt', name: 'Private key JWT' }];
const environmentOptions = [{ id: 'sandbox', name: 'Sandbox / test' }, { id: 'production', name: 'Production' }, { id: 'unspecified', name: 'Unspecified / shared' }];
const platformFor = (data: Dashboard, connection?: Connection) => connection?.platformId || data.platforms.find(item => item.vendor === connection?.vendor)?.id || '';
const requestedScopes = (app?: Application) => [...new Set([...(app?.requiredContext.includes('patient') ? ['launch/patient'] : []), ...(app?.requiredScopes || [])])].join(' ');
const profileMatchesEnvironment = (client: Registration, connection: Connection) => !client.environment || client.environment === 'unspecified' || client.environment === connection.environment;

export function FormDialog({ kind, data, context = {}, close, saved }: { kind: FormKind; data: Dashboard; context?: FormContext; close: () => void; saved: () => Promise<void> }) {
  if (!canCreateForm(data, kind, context)) return <Modal title="Configuration is read-only" close={close}><div className="form-content"><ErrorNotice message="Your role or resource assignment does not allow this action." /></div></Modal>;
  if (kind === 'installation') return <InstallationWizard data={data} context={context} close={close} saved={saved} />;
  return <Modal title={titles[kind]} description="Configuration stays in your SMART Flint deployment." close={close}>
    <ResourceForm kind={kind} data={data} context={context} close={close} created={async () => { await saved(); close(); }} />
  </Modal>;
}

function ResourceForm({ kind, data, context = {}, close, created, constrainContext = false, initialEnvironment }: {
  kind: ResourceKind; data: Dashboard; context?: FormContext; close: () => void;
  created: (kind: ResourceKind, item: ResourceRecord) => Promise<void>; constrainContext?: boolean; initialEnvironment?: Connection['environment'];
}) {
  const contextualConnection = data.connections.find(item => item.id === context.connectionId);
  const contextualRegistration = data.appRegistrations.find(item => item.id === context.appRegistrationId);
  const initialPlatformId = context.platformId || contextualRegistration?.platformId || platformFor(data, contextualConnection) || data.platforms[0]?.id || '';
  const [values, setValues] = useState<Record<string, string>>({
    name: '', description: '', slug: '', tenantId: context.tenantId || contextualConnection?.tenantId || data.tenants[0]?.id || '',
    platformId: initialPlatformId, appRegistrationId: context.appRegistrationId || '',
    vendor: data.platforms.find(item => item.id === initialPlatformId)?.vendor || 'generic',
    environment: initialEnvironment || 'sandbox', fhirVersion: '4.0.1', fhirBaseUrl: '', allowedOrigins: '', oidcIssuer: '', documentationUrl: '', portalUrl: '', audience: 'unspecified',
    callbackUrls: `${location.origin}/reference-app`, requiredContext: 'patient', requiredScopes: 'patient/Patient.rs',
    clientId: '', authMethod: 'none', secret: '', privateKey: '', keyId: ''
  });
  const [applicationIds, setApplicationIds] = useState<string[]>(context.applicationId ? [context.applicationId] : data.applications[0] ? [data.applications[0].id] : []);
  const [modes, setModes] = useState<AccessMode[]>(['gateway', 'direct', 'handoff']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = (key: string, value: string) => setValues(previous => ({ ...previous, [key]: value }));
  const input = (key: string, extra: InputHTMLAttributes<HTMLInputElement> = {}) => <input value={values[key] || ''} onChange={event => change(key, event.target.value)} required {...extra} />;
  const textarea = (key: string, extra: TextareaHTMLAttributes<HTMLTextAreaElement> = {}) => <textarea value={values[key] || ''} onChange={event => change(key, event.target.value)} rows={3} {...extra} />;
  const select = (key: string, options: { id: string; name: string }[], placeholder?: string, disabled = false) => <select value={values[key] || ''} onChange={event => change(key, event.target.value)} required disabled={disabled}>{placeholder && <option value="">{placeholder}</option>}{options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select>;
  const platform = data.platforms.find(item => item.id === values.platformId);
  const parent = data.appRegistrations.find(item => item.id === values.appRegistrationId);

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      let body: Record<string, unknown>;
      let endpoint: string;
      switch (kind) {
        case 'tenant':
          endpoint = '/api/admin/tenants';
          body = { name: values.name.trim(), slug: values.slug || values.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') };
          break;
        case 'application':
          endpoint = '/api/admin/applications';
          if (!modes.length) throw new Error('Choose at least one allowed access mode.');
          body = { name: values.name.trim(), description: values.description, callbackUrls: splitLines(values.callbackUrls), requiredContext: splitLines(values.requiredContext), requiredScopes: splitScopes(values.requiredScopes), allowedModes: modes };
          break;
        case 'platform':
          endpoint = '/api/admin/platforms';
          body = { name: values.name.trim(), vendor: values.vendor, description: values.description, ...(values.documentationUrl.trim() ? { documentationUrl: values.documentationUrl.trim() } : {}) };
          break;
        case 'app-registration':
          endpoint = '/api/admin/app-registrations';
          if (!platform) throw new Error('Select an EHR platform for this registration.');
          body = { name: values.name.trim(), platformId: platform.id, applicationIds, audience: values.audience, ...(values.portalUrl.trim() ? { portalUrl: values.portalUrl.trim() } : {}) };
          break;
        case 'connection': {
          endpoint = '/api/admin/connections';
          if (!platform) throw new Error('Select an EHR platform for this connection.');
          const fhirBaseUrl = values.fhirBaseUrl.trim();
          const origins = values.allowedOrigins.trim() ? splitLines(values.allowedOrigins) : [new URL(fhirBaseUrl).origin];
          const oidcIssuer = values.oidcIssuer.trim();
          if (oidcIssuer) origins.push(new URL(oidcIssuer).origin);
          body = { name: values.name.trim(), tenantId: values.tenantId, platformId: platform.id, vendor: platform.vendor, environment: values.environment, fhirVersion: values.fhirVersion, fhirBaseUrl, allowedOrigins: [...new Set(origins)], ...(oidcIssuer ? { oidcIssuer } : {}) };
          break;
        }
        case 'registration':
        case 'registration-client':
          if (kind === 'registration-client' && !parent) throw new Error('Select the app registration that owns this client profile.');
          endpoint = parent ? `/api/admin/app-registrations/${encodeURIComponent(parent.id)}/clients` : '/api/admin/registrations';
          body = { name: values.name.trim(), ...(!parent ? { vendor: values.vendor } : {}), clientId: values.clientId.trim(), environment: values.environment, authMethod: values.authMethod,
            ...(values.authMethod.startsWith('client_secret') ? { secret: values.secret } : {}),
            ...(values.authMethod === 'private_key_jwt' && values.privateKey.trim() ? { privateKey: values.privateKey.trim() } : {}),
            ...(values.authMethod === 'private_key_jwt' && values.keyId.trim() ? { keyId: values.keyId.trim() } : {}) };
          break;
      }
      const item = await post<ResourceRecord>(endpoint, body);
      setValues(previous => ({ ...previous, secret: '', privateKey: '' }));
      await created(kind, item);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to save configuration.'); }
    finally { setBusy(false); }
  }

  return <form onSubmit={submit} className="config-form">
    <div className="form-content">
      {constrainContext && <div className="inline-note"><Plus size={17} /><span>{titles[kind]}. Your installation selections are kept while you add this resource.</span></div>}
      {error && <ErrorNotice message={error} />}
      <Field label={kind === 'tenant' ? 'Organization name' : 'Name'}>{input('name', { autoFocus: true, placeholder: {
        tenant: 'e.g. Harbor Health', application: 'e.g. Clinical Review', connection: 'e.g. Epic · Harbor Health sandbox',
        registration: 'e.g. Non-production client', platform: 'e.g. Regional FHIR Platform', 'app-registration': 'e.g. Health Compass · Epic', 'registration-client': 'e.g. Epic non-production client'
      }[kind] })}</Field>

      {kind === 'tenant' && <Field label="Organization slug" hint="A readable identifier used within your deployment.">{input('slug', { placeholder: 'harbor-health', required: false })}</Field>}

      {kind === 'application' && <>
        <Field label="Description">{textarea('description', { placeholder: 'What does this application help its users do?' })}</Field>
        <Field label="Approved callback URLs" hint="Exact application callback URLs, one per line. Leave empty for a backend service.">{textarea('callbackUrls')}</Field>
        <div className="form-grid"><Field label="Required context" hint="Comma-separated: patient, encounter. Leave empty when no launch context is required.">{input('requiredContext', { required: false })}</Field><Field label="Required FHIR scopes" hint="Space-separated. The granted permissions must cover these requirements.">{input('requiredScopes', { required: false })}</Field></div>
        <fieldset className="form-fieldset"><legend>Allowed access modes</legend>{(['gateway', 'direct', 'handoff'] as AccessMode[]).map(mode => <label className="check-row" key={mode}><input type="checkbox" checked={modes.includes(mode)} onChange={event => setModes(event.target.checked ? [...modes, mode] : modes.filter(item => item !== mode))} /><span>{modeLabel(mode)}</span></label>)}</fieldset>
      </>}

      {kind === 'platform' && <>
        <Field label="Integration adapter" hint="Select the protocol behavior to use for this platform.">{select('vendor', vendorOptions)}</Field>
        <Field label="Description">{textarea('description')}</Field>
        <Field label="Developer documentation URL (optional)">{input('documentationUrl', { type: 'url', required: false, placeholder: 'https://developer.example.org' })}</Field>
      </>}

      {kind === 'app-registration' && <>
        <Field label="EHR platform">{select('platformId', data.platforms, 'Select a platform', constrainContext && !!context.platformId)}</Field>
        <fieldset className="form-fieldset"><legend>Applications using this registration</legend>{data.applications.length ? data.applications.map(app => <label className="check-row" key={app.id}><input type="checkbox" checked={applicationIds.includes(app.id)} disabled={constrainContext && !!context.applicationId} onChange={event => setApplicationIds(previous => event.target.checked ? [...previous, app.id] : previous.filter(id => id !== app.id))} /><span>{app.name}</span></label>) : <span className="text-small">Add an application to associate it with this registration.</span>}</fieldset>
        <Field label="Application audience" hint="Record the audience selected in the vendor portal.">{select('audience', [{ id: 'unspecified', name: 'Unspecified' }, { id: 'patient', name: 'Patients / caregivers' }, { id: 'clinician', name: 'Clinicians / administrative users' }, { id: 'backend', name: 'Backend systems' }])}</Field>
        <Field label="Vendor portal URL (optional)">{input('portalUrl', { type: 'url', required: false, placeholder: 'https://vendor.example.org/my-app' })}</Field>
        <div className="inline-note"><KeyRound size={17} /><span>This mirrors your app registration in the EHR vendor portal. Add its sandbox and production OAuth client profiles after saving.</span></div>
      </>}

      {kind === 'connection' && <>
        <div className="form-grid"><Field label="Organization">{select('tenantId', data.tenants, 'Select an organization', constrainContext && !!context.tenantId)}</Field><Field label="EHR platform">{select('platformId', data.platforms, 'Select a platform', constrainContext && !!context.platformId)}</Field></div>
        <Field label="FHIR base URL" hint="The exact trusted FHIR issuer for this connection. The incoming SMART launch iss must match this configured base.">{input('fhirBaseUrl', { type: 'url', placeholder: 'https://ehr.example.org/fhir/r4' })}</Field>
        <div className="form-grid"><Field label="Environment">{select('environment', environmentOptions.filter(item => item.id !== 'unspecified'), undefined, constrainContext && !!initialEnvironment)}</Field><Field label="FHIR version">{input('fhirVersion', { placeholder: '4.0.1' })}</Field></div>
        <Field label="Approved endpoint origins" hint="One origin per line. Include separately hosted authorization endpoints. Defaults to the FHIR server origin.">{textarea('allowedOrigins', { placeholder: 'https://ehr.example.org\nhttps://auth.example.org' })}</Field>
        <details className="json-details advanced-endpoints"><summary>Advanced identity endpoints</summary><div className="advanced-fields"><Field label="Approved OIDC issuer (optional)" hint="Needed when requesting identity and SMART discovery omits the issuer. Enter the exact trusted issuer URL; its origin is added to the approved endpoint origins.">{input('oidcIssuer', { type: 'url', required: false, placeholder: 'https://auth.example.org' })}</Field></div></details>
      </>}

      {(kind === 'registration' || kind === 'registration-client') && <>
        {kind === 'registration-client' ? <Field label="App registration">{select('appRegistrationId', data.appRegistrations, 'Select an app registration', constrainContext && !!context.appRegistrationId)}</Field> : <Field label="Integration adapter">{select('vendor', vendorOptions)}</Field>}
        <div className="form-grid"><Field label="Environment">{select('environment', environmentOptions)}</Field><Field label="Client authentication">{select('authMethod', authenticationOptions)}</Field></div>
        <Field label="Vendor client ID" hint="Copy the client ID for this environment from your vendor portal.">{input('clientId', { autoComplete: 'off' })}</Field>
        {values.authMethod.startsWith('client_secret') && <Field label="Client secret" hint="Encrypted on the server and excluded from configuration responses.">{input('secret', { type: 'password', autoComplete: 'new-password' })}</Field>}
        {values.authMethod === 'private_key_jwt' && <><Field label="Private signing key (optional JWK JSON)" hint="Leave empty to generate an ES384 key on the server. Register the corresponding public JWKS URL with your EHR vendor.">{textarea('privateKey', { spellCheck: false, placeholder: 'Generate a signing key, or paste an existing private JWK…' })}</Field><Field label="Key ID (optional)">{input('keyId', { required: false })}</Field></>}
        <div className="inline-note"><KeyRound size={17} /><span>{parent ? `${parent.name} groups the client identities issued by its vendor portal registration.` : 'Register the app in the vendor portal, then record its client identity here.'}</span></div>
      </>}
    </div>
    <div className="modal-foot"><button type="button" className="button button-quiet" onClick={close} disabled={busy}>{constrainContext && <ArrowLeft size={16} />}{constrainContext ? 'Back to installation' : 'Cancel'}</button><button className="button button-primary" type="submit" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{busy ? 'Saving…' : 'Save configuration'}</button></div>
  </form>;
}

function InstallationWizard({ data, context, close, saved }: { data: Dashboard; context: FormContext; close: () => void; saved: () => Promise<void> }) {
  const [resources, setResources] = useState(data);
  const contextualConnection = data.connections.find(item => item.id === context.connectionId);
  const contextualParent = data.appRegistrations.find(item => item.id === context.appRegistrationId);
  const initialApp = data.applications.find(item => item.id === context.applicationId) || (contextualParent?.applicationIds.length === 1 ? data.applications.find(item => item.id === contextualParent.applicationIds[0]) : undefined) || data.applications[0];
  const initialParent = contextualParent?.applicationIds.includes(initialApp?.id || '') ? contextualParent : undefined;
  const [values, setValues] = useState({
    name: '', applicationId: initialApp?.id || '', platformId: initialParent?.platformId || context.platformId || platformFor(data, contextualConnection),
    appRegistrationId: initialParent?.id || '', registrationId: initialParent?.clientRegistrationIds.length === 1 ? initialParent.clientRegistrationIds[0] : '',
    tenantId: context.tenantId || contextualConnection?.tenantId || (data.tenants.length === 1 ? data.tenants[0].id : ''),
    connectionId: contextualConnection?.id || '', mode: initialApp?.allowedModes[0] || 'gateway',
    scopes: requestedScopes(initialApp), normalizationProfile: 'passthrough'
  });
  const [tokenExport, setTokenExport] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [addedResources, setAddedResources] = useState(false);
  const [inlineKind, setInlineKind] = useState<'tenant' | 'connection' | 'app-registration' | 'registration-client' | null>(null);
  const change = (key: keyof typeof values, value: string) => setValues(previous => ({ ...previous, [key]: value }));
  const app = resources.applications.find(item => item.id === values.applicationId);
  const platform = resources.platforms.find(item => item.id === values.platformId);
  const parents = resources.appRegistrations.filter(item => item.platformId === values.platformId && item.applicationIds.includes(values.applicationId));
  const parent = parents.find(item => item.id === values.appRegistrationId);
  const clients = resources.registrations.filter(item => parent?.clientRegistrationIds.includes(item.id) && (!item.platformId || item.platformId === values.platformId));
  const client = clients.find(item => item.id === values.registrationId);
  const tenant = resources.tenants.find(item => item.id === values.tenantId);
  const connections = resources.connections.filter(item => item.tenantId === values.tenantId && platformFor(resources, item) === values.platformId && (!client || profileMatchesEnvironment(client, item)));
  const connection = connections.find(item => item.id === values.connectionId);
  const inlineContext: FormContext = {
    applicationId: values.applicationId, platformId: values.platformId, tenantId: values.tenantId, appRegistrationId: values.appRegistrationId
  };

  function openInline(kind: NonNullable<typeof inlineKind>) { if (!canCreateForm(resources, kind, inlineContext)) { setError('Your role or resource assignment does not allow this action.'); return; } setError(''); setInlineKind(kind); }
  async function inlineCreated(kind: ResourceKind, item: ResourceRecord) {
    switch (kind) {
      case 'tenant':
        setResources(previous => ({ ...previous, tenants: [...previous.tenants, item as Tenant] }));
        setValues(previous => ({ ...previous, tenantId: item.id, connectionId: '' }));
        break;
      case 'connection':
        setResources(previous => ({ ...previous, connections: [...previous.connections, item as Connection] }));
        setValues(previous => ({ ...previous, connectionId: item.id }));
        break;
      case 'app-registration':
        setResources(previous => ({ ...previous, appRegistrations: [...previous.appRegistrations, item as AppRegistration], ...(previous.access ? { access: { ...previous.access, manageable: { ...previous.access.manageable, appRegistrations: [...previous.access.manageable.appRegistrations, item.id] } } } : {}) }));
        setValues(previous => ({ ...previous, appRegistrationId: item.id, registrationId: '', connectionId: '' }));
        break;
      case 'registration-client':
        setResources(previous => ({ ...previous, registrations: [...previous.registrations, item as Registration], appRegistrations: previous.appRegistrations.map(record => record.id === values.appRegistrationId ? { ...record, clientRegistrationIds: [...record.clientRegistrationIds, item.id] } : record) }));
        setValues(previous => ({ ...previous, registrationId: item.id, connectionId: '' }));
        break;
    }
    setAddedResources(true);
    setInlineKind(null);
  }

  async function dismiss() {
    if (busy) return;
    if (addedResources) {
      setBusy(true);
      try { await saved(); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to refresh the workspace.'); setBusy(false); return; }
    }
    close();
  }

  function compatibleConnectionId(connectionId: string, profileId: string) {
    const selectedConnection = resources.connections.find(item => item.id === connectionId);
    const selectedClient = resources.registrations.find(item => item.id === profileId);
    return selectedConnection && platformFor(resources, selectedConnection) === values.platformId && (!selectedClient || profileMatchesEnvironment(selectedClient, selectedConnection)) ? connectionId : '';
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
      if (!app) throw new Error('Select an application before continuing.');
      if (step >= 1 && (!platform || !parent || !client)) throw new Error('Select an EHR platform, an app registration associated with this application, and one of its OAuth client profiles.');
      if (step >= 2 && (!tenant || !connection)) throw new Error('Select an organization and a connection on this platform that matches the client profile environment.');
      if (step < 3) { setStep(step + 1); return; }
      if (!values.name.trim()) throw new Error('Give this installation a name.');
      if (!app.allowedModes.includes(values.mode as AccessMode)) throw new Error('Choose an access mode allowed by this application.');
      setBusy(true);
      await post<Installation>('/api/admin/installations', {
        name: values.name.trim(), applicationId: app.id, tenantId: tenant!.id, connectionId: connection!.id,
        appRegistrationId: parent!.id, registrationId: client!.id, mode: values.mode,
        scopes: splitScopes(values.scopes), allowTokenExport: tokenExport || values.mode !== 'gateway', enabled,
        normalizationProfile: values.normalizationProfile
      });
      await saved(); close();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to create this installation.'); }
    finally { setBusy(false); }
  }

  return <Modal title="Create an installation" description="Connect an application to an EHR platform and organization. Reuse your saved registrations or add the missing pieces as you go." close={() => void dismiss()} wide>
    <ol className="wizard-steps">{['Application', 'Registration', 'Organization', 'Policy & review'].map((name, index) => <li key={name} className={index === step ? 'current' : index < step ? 'complete' : ''}><span>{index < step ? <Check size={13} /> : index + 1}</span>{name}</li>)}</ol>
    {inlineKind ? <ResourceForm key={inlineKind} kind={inlineKind} data={resources} context={inlineContext} constrainContext initialEnvironment={inlineKind === 'connection' && client?.environment && client.environment !== 'unspecified' ? client.environment : undefined} created={inlineCreated} close={() => setInlineKind(null)} /> : <form onSubmit={submit} className="config-form">
      <div className="form-content">
        {error && <ErrorNotice message={error} />}
        {step === 0 && <>
          <Field label="Application"><select value={values.applicationId} required onChange={event => {
            const next = resources.applications.find(item => item.id === event.target.value);
            setValues(previous => ({ ...previous, applicationId: event.target.value, appRegistrationId: '', registrationId: '', connectionId: '', scopes: requestedScopes(next), mode: next?.allowedModes.includes(previous.mode as AccessMode) ? previous.mode : next?.allowedModes[0] || 'gateway' }));
            setTokenExport(false);
          }}><option value="">Select an application</option>{resources.applications.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <Field label="Installation name"><input value={values.name} onChange={event => change('name', event.target.value)} placeholder={app ? `${app.name} · Organization · Sandbox` : 'e.g. Health Compass · Harbor Health'} required autoFocus /></Field>
          {app && <div className="inline-note"><Network size={18} /><span>{app.description || app.name}<br />Required context: {app.requiredContext.join(', ') || 'none'}. Required FHIR permissions: {app.requiredScopes.join(' ') || 'none'}.</span></div>}
          {!resources.applications.length && <div className="inline-note">Register an application in the Applications workspace before creating its installation.</div>}
        </>}
        {step === 1 && <>
          <Field label="EHR platform"><select value={values.platformId} required onChange={event => setValues(previous => ({ ...previous, platformId: event.target.value, appRegistrationId: '', registrationId: '', connectionId: '' }))}><option value="">Select an EHR platform</option>{resources.platforms.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <Field label="App registration" hint="Only registrations associated with this application and EHR platform are shown."><select value={values.appRegistrationId} required onChange={event => {
            const next = parents.find(item => item.id === event.target.value);
            const registrationId = next?.clientRegistrationIds.length === 1 ? next.clientRegistrationIds[0] : '';
            setValues(previous => ({ ...previous, appRegistrationId: event.target.value, registrationId, connectionId: compatibleConnectionId(previous.connectionId, registrationId) }));
          }}><option value="">{parents.length ? 'Select an app registration' : 'No registration for this application and platform'}</option>{parents.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <button type="button" className="text-button" disabled={!platform || !app || !canCreateForm(resources, 'app-registration', inlineContext)} onClick={() => openInline('app-registration')}><Plus size={14} />Add an app registration</button>
          <Field label="OAuth client profile" hint="Choose the client ID issued for the environment you intend to connect."><select value={values.registrationId} required onChange={event => setValues(previous => ({ ...previous, registrationId: event.target.value, connectionId: compatibleConnectionId(previous.connectionId, event.target.value) }))}><option value="">{clients.length ? 'Select a client profile' : 'Add a client profile to this registration'}</option>{clients.map(item => <option key={item.id} value={item.id}>{item.name} · {item.environment || 'unspecified'}</option>)}</select></Field>
          <button type="button" className="text-button" disabled={!parent || !canCreateForm(resources, 'registration-client', inlineContext)} onClick={() => openInline('registration-client')}><Plus size={14} />Add an OAuth client profile</button>
          {client && <div className="inline-note"><KeyRound size={17} /><span>{platform?.name} · {parent?.audience === 'unspecified' ? 'Audience unspecified' : `${parent?.audience} audience`} · {client.environment || 'unspecified'} environment<br />Client ID: <code>{client.clientId}</code> · {authenticationOptions.find(item => item.id === client.authMethod)?.name}</span></div>}
        </>}
        {step === 2 && <>
          <Field label="Organization"><select value={values.tenantId} required onChange={event => setValues(previous => ({ ...previous, tenantId: event.target.value, connectionId: '' }))}><option value="">Select an organization</option>{resources.tenants.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
          <button type="button" className="text-button" disabled={!canCreateForm(resources, 'tenant')} onClick={() => openInline('tenant')}><Plus size={14} />Add an organization</button>
          <Field label="FHIR connection" hint={`Connections belong to this organization and ${platform?.name || 'the selected platform'}. ${client?.environment && client.environment !== 'unspecified' ? `Only ${client.environment} connections match this client profile.` : 'An unspecified client environment can be used with either connection environment.'}`}><select value={values.connectionId} required onChange={event => change('connectionId', event.target.value)}><option value="">{connections.length ? 'Select a connection' : 'No matching connections for this organization'}</option>{connections.map(item => <option key={item.id} value={item.id}>{item.name} · {item.environment}</option>)}</select></Field>
          <button type="button" className="text-button" disabled={!tenant || !platform || !canCreateForm(resources, 'connection', inlineContext)} onClick={() => openInline('connection')}><Plus size={14} />Add an organization connection</button>
          {connection && <div className="inline-note"><Network size={18} /><span>{connection.fhirBaseUrl}<br />FHIR {connection.fhirVersion} · {connection.environment} · {connection.status}</span></div>}
        </>}
        {step === 3 && <>
          <fieldset className="form-fieldset"><legend>Installation binding</legend><div className="text-small"><strong>{values.name}</strong></div><div className="text-small">{app?.name} → {platform?.name} → {tenant?.name}</div><div className="text-small">{parent?.name} · {client?.name} · {connection?.environment}</div><code className="text-small">{connection?.fhirBaseUrl}</code></fieldset>
          <Field label="Requested scopes" hint="Starts with this application’s requirements and patient launch context when required. Match the scope version and API permissions configured in your vendor portal."><textarea value={values.scopes} onChange={event => change('scopes', event.target.value)} rows={3} /></Field>
          <fieldset className="mode-options"><legend>Default FHIR access</legend>{([
            ['gateway', 'Managed gateway', 'Server-held upstream tokens, gateway policy, and optional normalization.'],
            ['direct', 'Managed direct access', 'Call the EHR directly while SMART Flint manages token renewal.'],
            ['handoff', 'Credential handoff', 'The application takes ownership of supported credentials.']
          ] as const).filter(([mode]) => app?.allowedModes.includes(mode)).map(([mode, title, description]) => <label className={`mode-option ${values.mode === mode ? 'selected' : ''}`} key={mode}><input type="radio" name="mode" checked={values.mode === mode} onChange={() => change('mode', mode)} /><span><strong>{title}</strong><small>{description}</small></span></label>)}</fieldset>
          <Field label="Normalization profile"><select value={values.normalizationProfile} onChange={event => change('normalizationProfile', event.target.value)}><option value="passthrough">Pass through · preserve upstream representation</option><option value="display-cleanup-v1">Display cleanup v1 · trim display text</option></select></Field>
          <label className="check-row"><input type="checkbox" checked={tokenExport || values.mode !== 'gateway'} disabled={values.mode !== 'gateway'} onChange={event => setTokenExport(event.target.checked)} /><span>Allow authenticated access to original upstream tokens{values.mode !== 'gateway' ? ' · required for this mode' : ''}</span></label>
          <label className="check-row"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span>Enable this installation</span></label>
          <div className="inline-note"><ShieldCheck size={18} /><span>After creating the installation, open its setup worksheet to copy the exact SMART Flint launch and OAuth callback URLs into your vendor portal, verify discovery, and test the launch.</span></div>
        </>}
      </div>
      <div className="modal-foot"><button type="button" className="button button-quiet" disabled={busy} onClick={step > 0 ? () => { setStep(step - 1); setError(''); } : () => void dismiss()}>{step > 0 && <ArrowLeft size={16} />}{step > 0 ? 'Back' : 'Cancel'}</button><button className="button button-primary" type="submit" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : step < 3 ? <ArrowRight size={16} /> : <Check size={16} />}{busy ? 'Saving…' : step < 3 ? 'Continue' : 'Create installation'}</button></div>
    </form>}
  </Modal>;
}
