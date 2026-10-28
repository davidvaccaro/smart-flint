import { useState } from 'react';
import { ArrowRight, Code2, LoaderCircle, LockKeyhole, Network, ShieldCheck, Sparkles } from 'lucide-react';
import type { AdminSessionStatus } from '@smart-flint/contracts';
import { ErrorNotice, Field, Loading } from './components';

export type SignInCredentials = { username: string; password: string } | { token: string };

export function SignIn({ status, error, notice, busy, signIn, retry }: {
  status?: AdminSessionStatus;
  error: string;
  notice: string;
  busy: boolean;
  signIn: (credentials: SignInCredentials) => Promise<void>;
  retry: () => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  // The selected authentication mode takes precedence over synthetic demo data.
  const demoAccess = status?.authMode === 'demo' || (!status?.authMode && status?.demo === true);
  const localAccess = status?.localEnabled === true;
  return <div className="login-screen">
    <div className="login-decoration">
      <div className="flint-grid" />
      <div className="login-brand"><Sparkles size={28} /><span>SMART<span className="brand-light"> Flint</span></span></div>
      <div className="login-copy"><span className="eyebrow">YOUR INTEGRATION LAYER</span><h1>One spark.<br />Every connection.</h1><p>SMART launches, context, and FHIR access—managed in your own environment.</p><div className="login-features"><span><ShieldCheck size={17} /> Self-hosted by design</span><span><Network size={17} /> Built for multiple EHRs</span><span><Code2 size={17} /> Your app. Your FHIR client.</span></div></div>
      <span className="login-bottom">SOURCE AVAILABLE · SMART ON FHIR</span>
    </div>
    <div className="login-panel"><div className="login-card">
      <div className="login-lock"><LockKeyhole size={24} /></div><span className="eyebrow">SMART FLINT CONSOLE</span>
      <h2>{demoAccess ? 'Your local workspace' : 'Welcome to your workspace'}</h2>
      <p>{demoAccess ? 'Explore SMART Flint using synthetic organizations and a local EHR simulator.' : localAccess ? 'Sign in with your SMART Flint username and password.' : status?.oidcEnabled ? 'Sign in through your organization to access your assigned applications and environments.' : 'Your deployment administrator can configure sign-in or complete initial setup.'}</p>
      {notice && <p className="login-success" role="status"><ShieldCheck size={17} />{notice}</p>}
      {error && <ErrorNotice message={error} />}
      {status?.oidcEnabled && status.oidcLoginUrl && <a className="button button-primary login-sso" href={status.oidcLoginUrl}><ShieldCheck size={17} />{status.oidcLabel || 'Sign in with your organization'}<ArrowRight size={17} /></a>}
      {localAccess && <form aria-label="Username and password sign-in" className="login-local-form" onSubmit={async event => {
        event.preventDefault();
        try { await signIn({ username: username.trim(), password }); }
        finally { setPassword(''); }
      }}>
        <Field label="Username"><input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={event => setUsername(event.target.value)} required maxLength={64} disabled={busy} /></Field>
        <Field label="Password"><input name="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required disabled={busy} /></Field>
        <button type="submit" className="button button-primary login-submit" disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : <ArrowRight size={17} />}{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="login-recovery">Forgot your password? A deployment operator can reset it using the offline <code>admin:reset-password</code> command.</p>
      </form>}
      {(demoAccess || status?.bootstrapEnabled) && <form aria-label={demoAccess ? 'Local demo access' : 'Initial deployment setup'} onSubmit={async event => {
        event.preventDefault();
        try { await signIn({ token }); }
        finally { setToken(''); }
      }}>
        {!demoAccess && <><div className="login-separator">Initial deployment setup</div><Field label="Bootstrap administrator token" hint="Available only until the first named platform administrator is provisioned."><input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} required placeholder="Enter the setup token" disabled={busy} /></Field></>}
        <button type="submit" className={`button ${status?.oidcEnabled || localAccess ? 'button-outline' : 'button-primary'} login-submit`} disabled={busy}>{busy ? <LoaderCircle size={17} className="spin" /> : <ArrowRight size={17} />}{busy ? 'Opening workspace…' : demoAccess ? 'Open local workspace' : 'Open initial setup'}</button>
      </form>}
      {!status && !error && <Loading label="Connecting to your deployment…" />}
      <p className="login-footnote"><ShieldCheck size={14} />{demoAccess ? 'Synthetic data only. Local development mode.' : localAccess ? 'Local credentials. Scoped access. Secure sessions.' : 'Organization identity. Scoped access. Secure sessions.'}</p>
      {error && !status && <button className="text-button" onClick={retry}>Retry connection</button>}
    </div></div>
  </div>;
}
