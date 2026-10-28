import { useState } from 'react';
import { ArrowRight, ArrowUpRight, BookOpen, Code2, HeartPulse, LoaderCircle, Play, Server, ShieldCheck, Workflow } from 'lucide-react';
import type { Dashboard } from '@smart-flint/contracts';
import { isPlatformAdmin } from './access';
import { CopyButton, ErrorNotice, Field, Notice } from './components';
const fixtures = [
  { id: 'northstar', vendor: 'epic', label: 'Northstar · Epic fixture' },
  { id: 'harbor', vendor: 'epic', label: 'Harbor · Epic fixture' },
  { id: 'lakeside', vendor: 'oracle', label: 'Lakeside · Oracle Health fixture' },
  { id: 'cedar', vendor: 'meditech', label: 'Cedar · MEDITECH fixture' },
];
export function Samples({ data }: { data: Dashboard }) {
  const [fixture, setFixture] = useState('northstar');
  const [patient, setPatient] = useState('patient-a');
  const [response, setResponse] = useState<{ cards: { summary: string; detail?: string; indicator: string; source: { label: string } }[] }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const urls = isPlatformAdmin(data) ? data.runtime.samples : undefined;
  const selected = fixtures.find(value => value.id === fixture)!;
  const command = `curl '${urls?.fhirUrl ?? 'http://127.0.0.1:4102'}/assessments' -H 'Authorization: Bearer demo-health-service-client' -H 'Content-Type: application/json' --data '{"installationId":"inst_health_service_${fixture}","route":"gateway"}'`;
  return <>
    <Notice>Three independent applications share an educational health-review model. The score is illustrative and unvalidated. Patient observations, missing data and source guidance remain visible.</Notice>
    <div className="sample-library-grid">
      <section className="panel sample-library-card"><span className="sample-library-icon"><HeartPulse size={25} /></span><span className="eyebrow">INTERACTIVE SMART APP</span><h2>Health Compass</h2><p>A patient-facing health snapshot with explained indicators, record coverage, and prioritized next steps.</p><div className="tag-list"><span className="tag">EHR launch</span><span className="tag">Standalone</span><span className="tag">Gateway / direct</span></div><code>samples/patient-app</code>{urls && <a className="button button-primary" href={urls.patientUrl} target="_blank" rel="noreferrer">Open patient app <ArrowUpRight size={16} /></a>}</section>
      <section className="panel sample-library-card"><span className="sample-library-icon"><Workflow size={25} /></span><span className="eyebrow">CDS HOOKS IMPLEMENTATION</span><h2>Health review hook</h2><p>A patient-view handler turns EHR-supplied Patient and Observation records into explained decision-support cards.</p><div className="tag-list"><span className="tag">Signed EHR caller</span><span className="tag">FHIR prefetch</span></div><code>samples/cds-service</code><button className="text-button" onClick={() => document.getElementById('sample-cds')?.scrollIntoView({ behavior: 'smooth' })}>Run the complete hook pathway <ArrowRight size={14} /></button></section>
      <section className="panel sample-library-card"><span className="sample-library-icon"><Server size={25} /></span><span className="eyebrow">SMART BACKEND SERVICES</span><h2>Population review service</h2><p>A bounded headless assessment run uses preauthorized system access and closes its grant after each operation.</p><div className="tag-list"><span className="tag">private_key_jwt</span><span className="tag">System scopes</span></div><code>samples/fhir-service</code><button className="text-button" onClick={() => document.getElementById('sample-backend')?.scrollIntoView({ behavior: 'smooth' })}>View the service request <ArrowRight size={14} /></button></section>
    </div>
    {!urls && <Notice>Run the samples separately and configure their application installations for this deployment. Local sample endpoints are exposed here only in development mode.</Notice>}
    {urls && <section className="panel" id="sample-cds"><div className="panel-heading"><div><h2>Exercise a real CDS exchange</h2><p>The EHR fixture signs the invocation; SMART Flint authenticates and forwards it to the private handler.</p></div><Workflow size={21} /></div><div className="panel-body"><div className="sample-pathway"><span>EHR fixture</span><ArrowRight size={14} /><span>SMART Flint</span><ArrowRight size={14} /><span>Health review handler</span></div><form className="form-grid" onSubmit={async event => {
      event.preventDefault(); setBusy(true); setError(''); setResponse(undefined);
      try {
        const result = await fetch(`${urls.mockEhrUrl}/${selected.vendor}/${fixture}/cds-hooks/health-review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patientId: patient }), cache: 'no-store', redirect: 'error' });
        const body = await result.json();
        if (!result.ok) throw new Error(body.message ?? body.error ?? 'The CDS pathway could not complete. Check that all sample services are running.');
        setResponse(body);
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'The CDS pathway failed.'); }
      finally { setBusy(false); }
    }}><Field label="Sample EHR fixture"><select value={fixture} onChange={event => setFixture(event.target.value)}>{fixtures.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}</select></Field><Field label="Synthetic patient scenario"><select value={patient} onChange={event => setPatient(event.target.value)}><option value="patient-a">Follow-up opportunities</option><option value="patient-b">Healthy-range records</option><option value="patient-c">Incomplete / old records</option><option value="patient-d">Very high recent blood pressure</option></select></Field><div><button className="button button-primary" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}{busy ? 'Running pathway…' : 'Run health review hook'}</button></div></form>{error && <ErrorNotice message={error} />}{response && <div className="cds-result"><h3>{response.cards.length} returned cards</h3>{response.cards.map((card, index) => <article key={index} className={`cds-card cds-${card.indicator}`}><div><span className="tag">{card.indicator}</span><span>{card.source.label}</span></div><h3>{card.summary}</h3><p>{card.detail}</p></article>)}</div>}</div></section>}
    <section className="panel" id="sample-backend"><div className="panel-heading"><div><h2>Call the backend FHIR service</h2><p>The caller credential belongs to the sample service. Its upstream application key remains on the backend.</p></div><Code2 size={21} /></div><div className="panel-body"><pre className="code-block">{command}</pre><CopyButton text={command} label="Copy service request" /><p className="muted text-small">The shown credential is for local synthetic development. Production deployments require their own server-held credentials and approved installations.</p></div></section>
    <section className="panel"><div className="panel-heading"><div><h2>Compatibility evidence</h2><p>A successful local fixture run and a verified external EHR integration are separate evidence.</p></div><ShieldCheck size={21} /></div><div className="table-scroll"><table><thead><tr><th>Environment</th><th>Purpose</th><th>Evidence status</th></tr></thead><tbody><tr><td>Local Epic, Oracle Health and MEDITECH fixtures</td><td>Protocol, tenant and clinical-data scenarios</td><td><span className="tag">Synthetic fixtures</span></td></tr><tr><td>SMART Health IT launcher</td><td>Patient Portal / R4 · gateway and historical sample preview</td><td><span className="tag">Browser verified · Oct 24, 2026</span></td></tr><tr><td>Epic, Oracle Health and MEDITECH vendor environments</td><td>Actual vendor/customer compatibility</td><td><span className="tag">Credentials and verification required</span></td></tr></tbody></table></div><div className="panel-bottom"><span><BookOpen size={14} />See samples/README.md for configuration and test recipes.</span></div></section>
  </>;
}
