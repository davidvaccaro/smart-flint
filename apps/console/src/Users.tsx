import { useEffect, useState } from 'react';
import { Check, KeyRound, LoaderCircle, LockKeyhole, Plus, RefreshCw, Settings2, ShieldCheck, UserRound, UsersRound } from 'lucide-react';
import type { AdminRole, AdminUser, Dashboard } from '@smart-flint/contracts';
import { api, patch, post } from './api';
import { ErrorNotice, Field, Loading, Modal, Notice } from './components';
import { isPlatformAdmin, roleLabel } from './access';

const roles: AdminRole[] = ['platform_admin', 'integration_admin', 'viewer'];
const passphraseHint = 'Use a unique passphrase of 15–128 characters. Spaces are allowed; special characters are optional.';
function passwordError(password: string, confirmation: string): string {
  const length = Array.from(password).length;
  if (length < 15 || length > 128) return 'Use a passphrase of 15–128 characters.';
  if (password !== confirmation) return 'The new passwords do not match.';
  return '';
}
function usesLocalAccounts(data: Dashboard): boolean {
  return data.access?.authMode === 'local' || (!data.access?.authMode && data.access?.identity.kind === 'local');
}

export function UsersAndAccess({ data, refreshed }: { data: Dashboard; refreshed: () => Promise<void> }) {
  const [users, setUsers] = useState<AdminUser[]>();
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<AdminUser | 'new'>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const identity = data.access?.identity;
  const platformAdmin = isPlatformAdmin(data);
  const localMode = usesLocalAccounts(data);
  async function load() {
    if (!platformAdmin) return;
    setBusy(true); setError('');
    try { setUsers(await api<AdminUser[]>('/api/admin/users')); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load administrators.'); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [platformAdmin]);
  return <>
    <section className="panel settings-wide access-panel" id="users-access">
      <div className="panel-heading"><div><h2>Users & access</h2><p>Named identities, assigned integration resources, and administrative roles.</p></div><UsersRound size={21} className="muted" /></div>
      <div className="panel-body">
        <div className="access-identity"><span className="resource-icon"><UserRound size={21} /></span><div><strong>{identity?.displayName || 'Workspace identity'}</strong><span>{roleLabel(identity?.role)}{identity?.kind === 'demo' ? ' · local demo' : identity?.kind === 'bootstrap' ? ' · bootstrap setup' : identity?.kind === 'local' ? ` · ${identity.username || 'local account'}` : ''}</span></div><span className="tag">{platformAdmin ? 'Deployment-wide access' : 'Assigned resources'}</span></div>
        {platformAdmin ? <Notice>Platform administrators manage users and deployment-wide configuration. Integration administrators and viewers receive explicit organization and application assignments. Permissions are checked by the API on every request.</Notice> : <>
          <div className="access-assignment-summary"><div><h3>Organizations</h3><div className="tag-list">{data.tenants.length ? data.tenants.map(item => <span className="tag" key={item.id}>{item.name}</span>) : <span className="muted text-small">No organizations assigned</span>}</div></div><div><h3>Applications</h3><div className="tag-list">{data.applications.length ? data.applications.map(item => <span className="tag" key={item.id}>{item.name}</span>) : <span className="muted text-small">No applications assigned</span>}</div></div></div>
          <Notice>Your workspace contains your assigned organizations and applications. Shared configuration can be visible while changes require broader access. Contact a platform administrator to change your assignments.</Notice>
        </>}
        {identity?.kind === 'bootstrap' && <Notice>{localMode ? 'Complete setup by adding an enabled local platform administrator with a username and passphrase. Enabling the first platform administrator retires bootstrap access immediately. Sign in with the new account to continue.' : 'Complete setup by adding an enabled platform administrator using the exact issuer and subject from your identity provider. Enabling the first platform administrator retires bootstrap access immediately. Verify the issuer and subject before saving, then sign in through your organization to continue.'}</Notice>}
        {platformAdmin && <>
          <div className="access-toolbar"><div><span className="eyebrow">ADMINISTRATIVE DIRECTORY</span><p>{localMode ? 'Create local accounts and assign access within this deployment.' : 'Pre-provision identities from your organization’s identity provider.'}</p></div><div><button className="button button-small button-outline" onClick={load} disabled={busy}><RefreshCw size={14} className={busy ? 'spin' : ''} />Refresh users</button><button className="button button-small button-primary" onClick={() => setEditing('new')}><Plus size={14} />Add user</button></div></div>
          {error && <ErrorNotice message={error} />}
          {notice && <p className="access-saved" role="status"><Check size={15} />{notice}</p>}
          {!users ? busy ? <Loading label="Loading user access…" /> : null : users.length ? <div className="table-scroll"><table className="access-users"><thead><tr><th>User</th><th>Role / assignments</th><th>Status</th><th /></tr></thead><tbody>{users.map(user => <tr key={user.id}>
            <td><strong className="table-strong">{user.displayName}</strong>{user.email && <small className="table-sub">{user.email}</small>}<small className="table-sub mono">{user.authMethod === 'local' ? user.username : user.subject}</small></td>
            <td><strong className="table-strong">{roleLabel(user.role)}</strong><small className="table-sub">{user.role === 'platform_admin' ? 'All organizations and applications' : `${user.organizationIds.length} ${user.organizationIds.length === 1 ? 'organization' : 'organizations'} · ${user.applicationIds.length} ${user.applicationIds.length === 1 ? 'application' : 'applications'}`}</small></td>
            <td><span className={`badge badge-${user.disabled ? 'closed' : 'ready'}`}><span className="status-dot" />{user.disabled ? 'Disabled' : 'Enabled'}</span></td>
            <td><button className="button button-small button-outline" aria-label={`Edit access for ${user.displayName}`} onClick={() => setEditing(user)}><Settings2 size={14} />Edit access</button></td>
          </tr>)}</tbody></table></div> : <div className="access-empty"><LockKeyhole size={23} /><h3>Add the first named administrator</h3><p>{localMode ? 'Create a local platform administrator to complete deployment setup. Choose a unique username and a strong passphrase.' : 'Users sign in through your configured identity provider. No local passwords or invitation emails are created.'}</p></div>}
          <details className="json-details access-audit"><summary>Recent user access changes</summary><div className="event-list">{data.events.filter(event => /^admin\.(user_|password_)/.test(event.action)).length ? data.events.filter(event => /^admin\.(user_|password_)/.test(event.action)).slice(0, 10).map(event => <div className="event-row" key={event.id}><span className="resource-icon"><ShieldCheck size={16} /></span><div><strong>{event.action.replaceAll('_', ' ').replaceAll('.', ' ')}</strong><p>{event.detail}</p><span className="event-actor">{event.actor ? `By ${event.actor.displayName}` : 'Actor not recorded for this historical event'}</span></div><time title={event.at}>{new Date(event.at).toLocaleString()}</time></div>) : <p className="muted text-small">New user and permission changes will appear here with the acting administrator.</p>}</div></details>
          <div className="access-provider-note"><KeyRound size={17} /><p>{localMode ? <>Local accounts sign in with a username and passphrase. Email addresses are descriptive. For a forgotten password, a deployment operator can use the offline <code>admin:reset-password</code> command; reset passwords are never sent by email.</> : 'OIDC provider settings are supplied by the deployment environment. An email address is descriptive; authorization matches the exact issuer and subject. Identity provider group claims do not grant access automatically.'}</p></div>
        </>}
      </div>
      {editing && <UserEditor key={editing === 'new' ? 'new' : editing.id} user={editing === 'new' ? undefined : editing} data={data} close={() => setEditing(undefined)} saved={async () => { setEditing(undefined); setNotice('User access saved. Changes take effect on the next request.'); await load(); await refreshed(); }} />}
    </section>
    {localMode && identity?.kind === 'local' && <ChangePassword username={identity.username} />}
  </>;
}

function UserEditor({ user, data, close, saved }: { user?: AdminUser; data: Dashboard; close: () => void; saved: () => Promise<void> }) {
  const localUser = user ? user.authMethod === 'local' : usesLocalAccounts(data);
  const [displayName, setDisplayName] = useState(user?.displayName || '');
  const [email, setEmail] = useState(user?.email || '');
  const [issuer, setIssuer] = useState(user?.issuer || '');
  const [subject, setSubject] = useState(user?.subject || '');
  const [username, setUsername] = useState(user?.username || '');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [role, setRole] = useState<AdminRole>(user?.role || (data.access?.identity.kind === 'bootstrap' ? 'platform_admin' : 'viewer'));
  const [organizationIds, setOrganizationIds] = useState(user?.organizationIds || []);
  const [applicationIds, setApplicationIds] = useState(user?.applicationIds || []);
  const [disabled, setDisabled] = useState(user?.disabled || false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <Modal title={user ? 'Edit user access' : 'Add named user'} description={localUser ? 'Manage a local account and its access within this deployment.' : 'Provision an identity that already exists in your organization’s identity provider.'} close={close} wide>
    <form onSubmit={async event => {
      event.preventDefault(); setError('');
      if (localUser && !user) { const message = passwordError(password, confirmation); if (message) { setError(message); return; } }
      setBusy(true);
      try {
        const body = { displayName: displayName.trim(), ...(email.trim() ? { email: email.trim() } : {}), role, organizationIds: role === 'platform_admin' ? [] : organizationIds, applicationIds: role === 'platform_admin' ? [] : applicationIds, disabled };
        if (user) await patch(`/api/admin/users/${encodeURIComponent(user.id)}`, body);
        else await post('/api/admin/users', { ...body, ...(localUser ? { authMethod: 'local', username: username.trim(), password } : { issuer: issuer.trim(), subject: subject.trim() }) });
        setPassword(''); setConfirmation(''); await saved();
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to save user access.'); }
      finally { setBusy(false); }
    }}>
      <div className="form-content">
        {error && <ErrorNotice message={error} />}
        <div className="form-grid"><Field label="Display name"><input autoComplete="name" value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={120} required /></Field><Field label="Email (optional)" hint={localUser ? 'For display only; password recovery is managed by a deployment operator.' : 'For display only; sign-in matches issuer and subject.'}><input type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} maxLength={320} /></Field></div>
        {localUser ? <>
          <Field label="Username" hint={user ? 'The sign-in username cannot be changed here.' : '1–64 letters, numbers, periods, underscores, or hyphens. Usernames are stored in lowercase.'}><input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={event => setUsername(event.target.value)} disabled={!!user} required maxLength={64} pattern={'[A-Za-z0-9._\\-]+'} /></Field>
          {!user && <><Field label="Initial password" hint={passphraseHint}><input name="new-password" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} required maxLength={256} /></Field><Field label="Confirm initial password"><input name="confirm-new-password" type="password" autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} required maxLength={256} /></Field></>}
        </> : <>
          <Field label="Identity provider issuer" hint="Copy the exact configured OIDC issuer, including any path."><input type="url" value={issuer} onChange={event => setIssuer(event.target.value)} disabled={!!user} required maxLength={2048} placeholder="https://identity.example.com" /></Field>
          <Field label="Identity provider subject" hint="The stable sub claim supplied by the provider. This is often different from an email address."><input value={subject} onChange={event => setSubject(event.target.value)} disabled={!!user} required maxLength={512} autoComplete="off" /></Field>
        </>}
        <Field label="Administrative role"><select value={role} onChange={event => setRole(event.target.value as AdminRole)}>{roles.map(value => <option value={value} key={value}>{roleLabel(value)}</option>)}</select></Field>
        <p className="muted text-small">{role === 'platform_admin' ? 'Full deployment administration, including users and shared configuration.' : role === 'integration_admin' ? 'Manage permitted integration resources within both organization and application assignments.' : 'Inspect assigned integration resources and activity. Configuration and developer execution are read-only.'}</p>
        {role !== 'platform_admin' && <div className="access-assignment-grid">
          <fieldset className="form-fieldset"><legend>Assigned organizations</legend>{data.tenants.length ? data.tenants.map(item => <label className="check-row" key={item.id}><input type="checkbox" checked={organizationIds.includes(item.id)} onChange={event => setOrganizationIds(event.target.checked ? [...organizationIds, item.id] : organizationIds.filter(id => id !== item.id))} />{item.name}</label>) : <p className="muted text-small">No organizations configured.</p>}</fieldset>
          <fieldset className="form-fieldset"><legend>Assigned applications</legend>{data.applications.length ? data.applications.map(item => <label className="check-row" key={item.id}><input type="checkbox" checked={applicationIds.includes(item.id)} onChange={event => setApplicationIds(event.target.checked ? [...applicationIds, item.id] : applicationIds.filter(id => id !== item.id))} />{item.name}</label>) : <p className="muted text-small">No applications configured.</p>}</fieldset>
        </div>}
        <label className="check-row"><input type="checkbox" checked={disabled} onChange={event => setDisabled(event.target.checked)} />Disable this user’s administrative access</label>
        <Notice>Disabling a user or changing assignments takes effect on existing sessions. The final enabled platform administrator cannot be removed or demoted.</Notice>
      </div>
      <div className="modal-foot"><button className="button button-quiet" type="button" onClick={close}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />}Save user access</button></div>
    </form>
  </Modal>;
}

function ChangePassword({ username }: { username?: string }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <section className="panel settings-wide access-password" aria-labelledby="change-password-title">
    <div className="panel-heading"><div><h2 id="change-password-title">Change password</h2><p>Update the passphrase for your local account.</p></div><KeyRound size={21} className="muted" /></div>
    <form className="panel-body" onSubmit={async event => {
      event.preventDefault(); setError('');
      const message = passwordError(newPassword, confirmation); if (message) { setError(message); return; }
      setBusy(true);
      try { await post('/api/admin/password', { currentPassword, newPassword }); window.location.replace('/?password_changed=1'); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to change your password.'); setBusy(false); }
      finally { setCurrentPassword(''); setNewPassword(''); setConfirmation(''); }
    }}>
      {username && <input type="hidden" name="username" autoComplete="username" value={username} readOnly />}
      {error && <ErrorNotice message={error} />}
      <fieldset className="access-password-fields" disabled={busy}><legend className="sr-only">Your local account password</legend>
        <Field label="Current password"><input name="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} required /></Field>
        <Field label="New password" hint={passphraseHint}><input name="new-password" type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} required maxLength={256} /></Field>
        <Field label="Confirm new password"><input name="confirm-new-password" type="password" autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} required maxLength={256} /></Field>
      </fieldset>
      <Notice>Changing your password ends all sessions for this account. You will sign in again with your new password.</Notice>
      <button className="button button-primary" disabled={busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />}{busy ? 'Changing password…' : 'Change password'}</button>
    </form>
  </section>;
}
