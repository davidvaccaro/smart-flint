import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  Activity, ArrowRight, ArrowUpRight, BookOpen, CheckCircle2,
  ChevronDown, CircleHelp, Code2, Database, ExternalLink, Heart, HeartPulse,
  Info, Leaf, Link2, LoaderCircle, LogOut, RefreshCw, ShieldCheck, Sparkles, X,
} from 'lucide-react';
import { assessHealth, assessHistoricalHealth, type HealthAssessment, type PatientSnapshot } from '@smart-flint/health-assessment';
import {
  bridgeUrl, configuredInstallation, completePatientLaunch, forgetCompletedLaunch, loadPatientSnapshot,
  startPatientLaunch, type PatientSession,
} from './smart-flint';

type Route = 'gateway' | 'direct';
type Domain = HealthAssessment['domains'][number];
type Action = HealthAssessment['actions'][number];
type Dialog = 'about' | 'sources' | 'connection' | null;
type AssessmentView = 'current' | 'historical';
interface ViewSelection { view: AssessmentView | 'auto'; automaticallyHistorical: boolean }
const healthReviewSource = 'https://medlineplus.gov/healthcheckup.html';

const connections = [
  { id: 'inst_health_northstar', name: 'Northstar Health', description: 'Synthetic Epic-style environment' },
  { id: 'inst_health_harbor', name: 'Harbor Medical', description: 'Synthetic Epic-style environment · second tenant' },
  { id: 'inst_health_lakeside', name: 'Lakeside Clinic', description: 'Synthetic Oracle Health (Cerner)-style environment' },
  { id: 'inst_health_cedar', name: 'Cedar Health', description: 'Synthetic MEDITECH-style environment' },
];

const statusLabels: Record<Domain['status'], string> = {
  optimal: 'In the reference range', review: 'Worth a conversation', priority: 'Needs attention',
  unknown: 'No usable result', stale: 'An older result', unsupported: 'Needs more context',
};
const priorityLabels: Record<Action['priority'], string> = {
  urgent: 'Time-sensitive guidance', high: 'Start here', medium: 'Next step', routine: 'Keep it going', data: 'Complete the picture',
};

function friendlyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'We could not complete this request. Please try connecting again.';
}

function dateLabel(value?: string): string {
  if (!value) return 'No dated result';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Date unavailable';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function DomainIcon({ id, size = 20 }: { id: string; size?: number }) {
  if (id === 'blood-pressure') return <HeartPulse size={size} />;
  if (id === 'a1c') return <Activity size={size} />;
  if (id === 'bmi') return <Heart size={size} />;
  return <Leaf size={size} />;
}

function Brand() {
  return <button className="brand" type="button" aria-label="Health Compass, back to top" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>
    <span className="brand-symbol"><HeartPulse size={25} strokeWidth={1.8} /></span>
    <span>Health Compass<small>A SMART FLINT SAMPLE</small></span>
  </button>;
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = ref.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog ref={ref} className="dialog" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }} aria-label={title}>
    <div className="dialog-heading"><h2>{title}</h2><button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={21} /></button></div>
    <div className="dialog-content">{children}</div>
  </dialog>;
}

function About({ assessment }: { assessment: HealthAssessment | null }) {
  return <>
    <span className="eyebrow">A conversation starter</span>
    <p>This educational sample turns four parts of your FHIR record into a health snapshot: blood pressure, A1c, body mass index, and tobacco use.</p>
    <div className="notice"><Info size={19} /><p>The score is an illustrative, unvalidated index. It does not predict disease, diagnose a condition, or replace advice from your care team.</p></div>
    <h3>How to read your snapshot</h3>
    <p>{assessment?.score.explanation ?? 'A score is shown only when enough recent, interpretable information is available. Missing, old, and unsupported results are reported separately from the score.'}</p>
    {assessment && <div className="score-breakdown">{assessment.domains.map(domain => <div key={domain.id}><span>{domain.title}</span><strong>{domain.score === null ? 'Not scored' : `${domain.score} / 100`}</strong></div>)}</div>}
    <p>Coverage describes how much of this four-part picture is available. A high score with limited coverage can miss important information. This sample does not assess every part of your health.</p>
    {assessment?.mode === 'historical' && <p><strong>Historical assessment:</strong> this view evaluates the original records as of {dateLabel(assessment.assessedAt)}, using the patient’s age at that date. It does not describe current health or change the original measurement dates. The score is an unvalidated educational index in both views.</p>}
    <p>Your circumstances, medical history, pregnancy, and care plan can change how a result should be interpreted. Discuss results and next steps with your care team, even when a value appears in the reference range.</p>
    <h3>Your record stays in this tab</h3>
    <p>This app keeps its session and health data in memory. Reloading or closing the tab clears the app’s copy and requires a new connection. It uses no analytics or browser storage for health data or access tokens.</p>
  </>;
}

function Landing({ onLaunch, busy, installation, setInstallation, route, setRoute, onAbout }: {
  onLaunch: () => void; busy: boolean; installation: string; setInstallation: (value: string) => void;
  route: Route; setRoute: (value: Route) => void; onAbout: () => void;
}) {
  const isCustom = !connections.some(connection => connection.id === installation);
  return <main className="landing main-width">
    <section className="welcome-copy">
      <span className="pill"><Sparkles size={14} /> Small steps. A clearer picture.</span>
      <h1>Your health.<br /><span>Your next step.</span></h1>
      <p className="lead">Make sense of the health information in your record—and find a few practical things to talk about with your care team.</p>
      <ul className="welcome-benefits">
        <li><CheckCircle2 size={19} /><span>An explainable snapshot, with every result in view</span></li>
        <li><CheckCircle2 size={19} /><span>Prioritized next steps based on your available data</span></li>
        <li><CheckCircle2 size={19} /><span>A private session that stays in this browser tab</span></li>
      </ul>
      <button className="text-button" type="button" onClick={onAbout}>Understand the sample <ArrowUpRight size={17} /></button>
      <div className="welcome-illustration" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="illustration-heart"><HeartPulse size={56} strokeWidth={1.2} /></div><span className="floating-label label-one"><Activity size={17} /> Your records</span><span className="floating-label label-two"><Leaf size={17} /> Your next steps</span><span className="illustration-dot" /></div>
    </section>
    <section className="connect-card" aria-labelledby="connect-title">
      <span className="connect-icon"><Link2 size={25} /></span>
      <h2 id="connect-title">Let’s connect your record</h2>
      <p>Choose a sample connection to launch the demo. You’ll review access before returning here.</p>
      <form onSubmit={event => { event.preventDefault(); onLaunch(); }}>
        <label className="field-label" htmlFor="connection">Healthcare connection</label>
        <div className="select-wrap"><select id="connection" value={isCustom ? 'custom' : installation} onChange={event => setInstallation(event.target.value === 'custom' ? configuredInstallation : event.target.value)} disabled={busy}>
          {connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
          <option value="custom">Custom installation</option>
        </select><ChevronDown size={17} /></div>
        <p className="field-hint">{connections.find(connection => connection.id === installation)?.description ?? 'Use an installation configured in your own SMART Flint.'}</p>
        {isCustom && <label className="custom-field">Installation ID<input value={installation} onChange={event => setInstallation(event.target.value)} placeholder="inst_…" required disabled={busy} autoComplete="off" /></label>}
        <fieldset className="route-field"><legend>FHIR connection</legend><div className="segmented">
          <button type="button" className={route === 'gateway' ? 'selected' : ''} aria-pressed={route === 'gateway'} onClick={() => setRoute('gateway')} disabled={busy}><ShieldCheck size={16} /> SMART Flint gateway</button>
          <button type="button" className={route === 'direct' ? 'selected' : ''} aria-pressed={route === 'direct'} onClick={() => setRoute('direct')} disabled={busy}><ArrowUpRight size={16} /> Direct to EHR</button>
        </div><p className="field-hint">{route === 'gateway' ? 'The bridge protects the upstream token and manages the FHIR connection.' : 'Read from the original FHIR server. The bridge still manages the token lifecycle; the server must allow browser access.'}</p></fieldset>
        <button type="submit" className="button primary full" disabled={busy || !installation.trim()}>{busy ? <LoaderCircle size={18} className="spin" /> : <Link2 size={18} />}{busy ? 'Opening your connection…' : 'Connect my health record'}{!busy && <ArrowRight size={18} />}</button>
      </form>
      <div className="privacy-line"><ShieldCheck size={17} /><p>Your choice. Your record.<br /><span>Read-only access. No changes to your EHR.</span></p></div>
      <div className="sample-note"><Code2 size={16} /><span>Developer sample · Local connections use synthetic records. External EHRs require your own registration.</span></div>
    </section>
  </main>;
}

function ScoreCard({ assessment, onAbout }: { assessment: HealthAssessment; onAbout: () => void }) {
  const value = assessment.score.value;
  const historical = assessment.mode === 'historical';
  const hasUrgentReading = !historical && assessment.actions.some(action => action.priority === 'urgent');
  const radius = 74;
  const circumference = 2 * Math.PI * radius;
  return <section className="snapshot-card" aria-labelledby="snapshot-title">
    <div className="card-heading"><h2 id="snapshot-title">Your health snapshot</h2><span className="small-label">{historical ? 'HISTORICAL ASSESSMENT' : 'ILLUSTRATIVE SCORE'}</span></div>
    <div className="snapshot-content">
      <div className={`score-dial ${hasUrgentReading ? 'needs-attention' : ''} ${historical ? 'historical-dial' : ''}`} role="img" aria-label={value === null ? `Not enough interpretable ${historical ? 'historical' : 'recent'} information for a health score` : `${historical ? 'Historical assessment. ' : ''}${hasUrgentReading ? 'Review the urgent reading first. ' : ''}Illustrative health score ${value} out of 100`}>
        <svg viewBox="0 0 180 180" aria-hidden="true"><circle cx="90" cy="90" r={radius} className="dial-track" /><circle cx="90" cy="90" r={radius} className="dial-value" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - (value ?? 0) / 100)} /></svg>
        <div><strong>{value ?? '—'}</strong><span>{value === null ? 'not scored' : 'out of 100'}</span></div>
      </div>
      <div className="score-description"><span className="eyebrow">{historical ? `RECORDS AS OF ${dateLabel(assessment.assessedAt)}` : hasUrgentReading ? 'Time-sensitive result recorded' : 'A place to begin'}</span><h3>{historical ? value === null ? 'Limited historical data' : 'Historical health snapshot' : hasUrgentReading ? 'Review urgent reading first' : assessment.score.label}</h3><p>{assessment.score.explanation}</p><button type="button" className="text-button" onClick={onAbout}>How this score works <CircleHelp size={16} /></button></div>
    </div>
    <div className="coverage"><div><span><Database size={15} /> {historical ? 'Historical coverage' : 'Data coverage'}</span><strong>{assessment.score.availableDomains} of {assessment.score.totalDomains} areas · {assessment.score.coveragePercent}%</strong></div><progress value={assessment.score.coveragePercent} max={100} aria-label="Data coverage" /><p>{historical ? 'Coverage is evaluated at the historical date, not today.' : 'Missing or older information does not count as a healthy result.'}</p></div>
  </section>;
}

function hasObservationReadIssue(snapshot: PatientSnapshot): boolean {
  return snapshot.issues.some(issue => issue.code !== 'observation_patient_mismatch');
}

function AvailabilityCard({ snapshot, assessment }: {
  snapshot: PatientSnapshot; assessment: HealthAssessment;
}) {
  const stale = assessment.domains.filter(domain => domain.status === 'stale').length;
  const unknown = assessment.domains.filter(domain => domain.status === 'unknown').length;
  const unsupported = assessment.domains.filter(domain => domain.status === 'unsupported').length;
  const summary = [stale ? `${stale} older` : '', unknown ? `${unknown} unavailable` : '', unsupported ? `${unsupported} unsupported` : ''].filter(Boolean).join(' · ');
  const incompleteRead = hasObservationReadIssue(snapshot);
  return <aside className="availability-card" aria-labelledby="availability-title">
    <span className="eyebrow">{incompleteRead ? 'CONNECTED, WITH AN INCOMPLETE RECORD READ' : 'CONNECTED, WITH LIMITED CURRENT DATA'}</span>
    <h2 id="availability-title">{incompleteRead ? 'Record access needs attention' : 'Why there’s no current score'}</h2>
    <p className="received-count">Received {snapshot.observations.length.toLocaleString()} observation {snapshot.observations.length === 1 ? 'record' : 'records'}.{incompleteRead ? ' Some measurements could not be read, so we cannot tell whether enough information is available for a current score.' : ' The score needs at least two recent, interpretable adult health areas.'}</p>
    {summary && <p className="availability-summary">{summary} areas</p>}
    <ul className="availability-list">{assessment.domains.map(domain => <li key={domain.id}><span>{domain.title}</span><small>{statusLabels[domain.status]} · {dateLabel(domain.measuredAt)}</small></li>)}</ul>
    {snapshot.issues.length > 0 && <p className="partial-data-note"><Info size={14} /> Partial record: {snapshot.issues.length} read {snapshot.issues.length === 1 ? 'issue' : 'issues'}. See the notices below.</p>}
  </aside>;
}

function AssessmentTabs({ view, historicalAvailable, onSelect, loading = false, disabled = false }: {
  view: AssessmentView; historicalAvailable: boolean; onSelect: (view: AssessmentView) => void;
  loading?: boolean; disabled?: boolean;
}) {
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || disabled) return;
    event.preventDefault();
    const next: AssessmentView = historicalAvailable && (event.key === 'End' || (event.key !== 'Home' && view === 'current')) ? 'historical' : 'current';
    onSelect(next);
    document.getElementById(`assessment-tab-${next}`)?.focus();
  }
  return <div className="assessment-view-controls">
    <div className="assessment-tabs" role="tablist" aria-label="Assessment view" onKeyDown={navigate}>
      <button type="button" role="tab" id="assessment-tab-current" aria-controls="assessment-panel" aria-selected={view === 'current'} tabIndex={view === 'current' ? 0 : -1} disabled={disabled} onClick={() => onSelect('current')}>Current</button>
      <button type="button" role="tab" id="assessment-tab-historical" aria-controls="assessment-panel" aria-selected={view === 'historical'} aria-describedby={!historicalAvailable ? 'historical-unavailable' : undefined} tabIndex={view === 'historical' ? 0 : -1} disabled={!historicalAvailable || disabled} onClick={() => onSelect('historical')}>Historical</button>
    </div>
    {!historicalAvailable && <p id="historical-unavailable" className="historical-unavailable">{loading ? 'Historical view will be available if the received record has a safely interpretable dated measurement.' : 'Historical view is unavailable: no safely interpretable, supported dated measurement was found in the received record.'}</p>}
  </div>;
}

function CurrentCoverageNotice({ automaticallyHistorical, snapshot, onRetry, retryDisabled }: {
  automaticallyHistorical: boolean; snapshot: PatientSnapshot; onRetry: () => void; retryDisabled: boolean;
}) {
  if (hasObservationReadIssue(snapshot)) {
    const denied = snapshot.issues.some(issue => issue.code === 'observations_access_denied');
    return <section className="current-coverage-notice" role="status" aria-label="Record read incomplete"><Info size={20} /><div><h2>{snapshot.observations.length === 0 ? 'We couldn’t read your measurements' : 'Some measurements couldn’t be read'}</h2><p>Your record is connected, but {denied ? 'access to some measurements was denied' : 'reading your measurements could not be completed'}. Any assessment uses only the records received. Refresh your record to try again. If the problem continues, contact the app’s support team to check record access.{automaticallyHistorical ? ' The Historical view uses only the past records received.' : ''}</p><button type="button" className="text-button" onClick={onRetry} disabled={retryDisabled}>Try reading measurements again <RefreshCw size={14} /></button></div></section>;
  }
  return <section className={`current-coverage-notice ${automaticallyHistorical ? 'automatic-history-notice' : ''}`} role="status" aria-label="Current information needed"><Info size={20} /><div><h2>{automaticallyHistorical ? 'Showing Historical because a current score isn’t available' : 'A current score needs up-to-date information'}</h2><p>There isn’t enough recent information in this connected record for a current score. Ask your care team whether a health review, physical exam, updated measurements, or tests would be helpful for you. Missing records do not automatically mean you need more tests.</p><a href={healthReviewSource} target="_blank" rel="noreferrer">About health checkups <ExternalLink size={13} /></a></div></section>;
}

function ActionCard({ action, index, historical = false }: { action: Action; index: number; historical?: boolean }) {
  return <article className={`action-card priority-${action.priority}`}>
    <span className="action-number">{index + 1}</span>
    <div className="action-body"><span className="action-priority">{historical ? 'Historical example' : priorityLabels[action.priority]}</span><h3>{action.title}</h3><p>{action.description}</p><details className="action-reason"><summary>Why this is suggested <ChevronDown size={15} /></summary><p>{action.reason}</p>{action.observationRef && <span className="record-reference">Record: {action.observationRef}</span>}</details></div>
    <a href={action.sourceUrl} className="source-button" target="_blank" rel="noreferrer" aria-label={`Read guidance for ${action.title}`}><ArrowUpRight size={20} /></a>
  </article>;
}

function DomainCard({ domain }: { domain: Domain }) {
  const [expanded, setExpanded] = useState(false);
  return <article className={`domain-card status-${domain.status}`}>
    <div className="domain-top"><span className="domain-icon"><DomainIcon id={domain.id} /></span><span className="status-dot" aria-hidden="true" /></div>
    <h3>{domain.title}</h3><strong className="domain-value">{domain.value}</strong><span className="domain-status">{statusLabels[domain.status]}</span><p className="domain-date">{dateLabel(domain.measuredAt)}</p>
    <button className="domain-detail-button" type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>{expanded ? 'Hide details' : 'What this means'}<ChevronDown size={15} className={expanded ? 'rotated' : ''} /></button>
    {expanded && <div className="domain-details"><p>{domain.explanation}</p>{domain.score !== null && domain.id !== 'tobacco' && <p>Displayed measurements are rounded; categories use the original recorded precision.</p>}{domain.reference && <span className="record-reference">Record: {domain.reference}</span>}<a href={domain.sourceUrl} target="_blank" rel="noreferrer">Read the guidance <ExternalLink size={13} /></a></div>}
  </article>;
}

function Dashboard({ assessment, currentAssessment, snapshot, historicalPreview, automaticallyHistorical, refreshing, closing, onRefresh, onAbout, onSources, onViewChange }: {
  assessment: HealthAssessment; currentAssessment: HealthAssessment; snapshot: PatientSnapshot;
  historicalPreview: HealthAssessment | null; automaticallyHistorical: boolean;
  refreshing: boolean; closing: boolean; onRefresh: () => void; onAbout: () => void; onSources: () => void;
  onViewChange: (view: AssessmentView) => void;
}) {
  const firstName = assessment.patient.displayName.split(' ')[0] || 'there';
  const historical = assessment.mode === 'historical';
  const urgentActions = currentAssessment.actions.filter(action => action.priority === 'urgent');
  return <main className="dashboard main-width" data-assessment-mode={assessment.mode}>
    <section className="greeting"><div><span className="eyebrow">{historical ? 'YOUR RECORD AT AN EARLIER DATE' : 'YOUR HEALTH, A LITTLE CLEARER'}</span><h1>Hello, {firstName}<span className="greeting-dot">.</span></h1><p>{historical ? `Viewing past records as of ${dateLabel(assessment.assessedAt)}.` : 'Here’s what your available health information is telling us.'}</p><span className="patient-identity">Record for {assessment.patient.displayName}{assessment.patient.age === undefined ? '' : ` · Age ${assessment.patient.age}${historical ? ` as of ${dateLabel(assessment.assessedAt)}` : ''}`}</span></div><button type="button" className="button secondary" onClick={onRefresh} disabled={refreshing || closing}><RefreshCw size={16} className={refreshing ? 'spin' : ''} />{refreshing ? 'Updating…' : 'Refresh record'}</button></section>
    {urgentActions.map(action => <section key={action.id} className="urgent-banner" role="alert" aria-label="Time-sensitive health guidance"><HeartPulse size={25} /><div><span className="eyebrow">CURRENT TIME-SENSITIVE GUIDANCE</span><h2>{action.title}</h2><p>{action.description}</p><a href={action.sourceUrl} target="_blank" rel="noreferrer">Read the guidance <ExternalLink size={14} /></a></div></section>)}
    <AssessmentTabs view={historical ? 'historical' : 'current'} historicalAvailable={historicalPreview !== null} onSelect={onViewChange} disabled={closing} />
    <section className="assessment-panel" id="assessment-panel" role="tabpanel" aria-labelledby={`assessment-tab-${historical ? 'historical' : 'current'}`} tabIndex={0}>
    {(currentAssessment.score.value === null || hasObservationReadIssue(snapshot)) && <CurrentCoverageNotice automaticallyHistorical={automaticallyHistorical && historical} snapshot={snapshot} onRetry={onRefresh} retryDisabled={refreshing || closing} />}
    {historical && <section className="historical-banner" role="status" aria-label="Historical assessment"><Database size={25} /><div><span className="eyebrow">EDUCATIONAL INTERPRETATION OF PAST RECORDS</span><h2>Historical assessment</h2><p><strong>Assessment as of {dateLabel(assessment.assessedAt)} · {assessment.patient.age === undefined ? 'Age at that date unavailable' : `Age ${assessment.patient.age} at that date`}.</strong> This uses the original dated records. It is not an assessment of current health. Measurement dates have not changed.</p>{assessment.score.value === null && <p className="historical-limited-note">Only {assessment.score.availableDomains} of {assessment.score.totalDomains} areas can be interpreted at that date, so an overall sample score is still unavailable.</p>}</div></section>}
    <div className="overview-grid"><ScoreCard assessment={assessment} onAbout={onAbout} />{!historical && assessment.score.value === null ? <AvailabilityCard snapshot={snapshot} assessment={currentAssessment} /> : <aside className={`care-note ${historical ? 'historical-care-note' : ''}`}><span className="care-note-icon"><Leaf size={25} strokeWidth={1.5} /></span><span className="eyebrow">{historical ? 'YOUR RECORD, A DIFFERENT POINT IN TIME' : 'ONE STEP AT A TIME'}</span><h2>{historical ? <>An earlier record.<br />A clearer timeline.</> : <>A little clarity.<br />A useful next step.</>}</h2><p>{historical ? 'This view interprets your available records at the selected historical date. It does not establish what your health is like today.' : 'You don’t have to change everything at once. Start with the suggestions that matter most, and make a plan with your care team.'}</p><div className="care-note-bottom"><ShieldCheck size={17} /><span>{historical ? 'Historical interpretation only.' : 'Your goals should fit your life.'}</span></div></aside>}</div>
    {assessment.notices.length > 0 && <div className="assessment-notices"><Info size={18} /><div>{assessment.notices.map((notice, index) => <p key={`${index}-${notice}`}>{notice}</p>)}</div></div>}
    <section className="actions-section" aria-labelledby="actions-title"><div className="section-heading"><div><span className="eyebrow">{historical ? 'EDUCATIONAL INTERPRETATION AT THE HISTORICAL DATE' : 'A PERSONAL STARTING POINT'}</span><h2 id="actions-title">{historical ? 'Historical considerations' : 'Your next steps'}</h2><p>{historical ? 'These considerations concern past records and are not current care instructions.' : 'Suggestions are ordered by the information available in your record.'}</p></div><span className="count-pill">{assessment.actions.length} {historical ? 'considerations' : 'suggestions'}</span></div>
      <div className="actions-list">{assessment.actions.length > 0 ? assessment.actions.map((action, index) => <ActionCard key={action.id} action={action} index={index} historical={historical} />) : <div className="empty-actions"><CheckCircle2 size={24} /><div><h3>No specific suggestion from these four areas</h3><p>This limited snapshot cannot tell you that everything is healthy. Continue your usual care and discuss any concerns with your care team.</p></div></div>}</div>
    </section>
    <section className="domains-section" aria-labelledby="domains-title"><div className="section-heading"><div><span className="eyebrow">THE INFORMATION BEHIND YOUR SNAPSHOT</span><h2 id="domains-title">Let’s look at the details</h2><p>{historical ? `Original measurement dates; interpretation as of ${dateLabel(assessment.assessedAt)}.` : 'See what’s current, what’s older, and what’s still missing.'}</p></div><button type="button" className="text-button" onClick={onSources}><BookOpen size={16} /> Sources &amp; guidance</button></div><div className="domains-grid">{assessment.domains.map(domain => <DomainCard key={domain.id} domain={domain} />)}</div></section>
    <div className="educational-footer"><Info size={18} /><p><strong>An educational snapshot, not a medical assessment.</strong> This illustrative, unvalidated score does not diagnose conditions or establish that you are healthy. For symptoms, concerns, or decisions about your care, contact a healthcare professional.</p><button type="button" className="text-button" onClick={onAbout}>Learn more <ArrowUpRight size={15} /></button></div>
    <p className="record-updated">Record read {dateLabel(snapshot.loadedAt)} · Assessment as of {dateLabel(assessment.assessedAt)}{historical ? ' (historical)' : ' (current)'} · Dates shown in UTC · {snapshot.observations.length.toLocaleString()} observation records · Your information is kept in this tab only.</p>
    </section>
  </main>;
}

export function App() {
  const returningWithoutSession = window.location.pathname === '/callback' && !['code', 'state', 'smart_flint_launch', 'error'].some(key => new URLSearchParams(window.location.search).has(key));
  const initialEHRBootstrap = useRef(new URLSearchParams(window.location.search).has('smart_flint_launch'));
  const [connection, setConnection] = useState<PatientSession | null>(null);
  const [snapshot, setSnapshot] = useState<PatientSnapshot | null>(null);
  const [selection, setSelection] = useState<ViewSelection>({ view: 'auto', automaticallyHistorical: false });
  const [installation, setInstallation] = useState(configuredInstallation || connections[0].id);
  const [route, setRoute] = useState<Route>('gateway');
  const [busy, setBusy] = useState(() => ['code', 'state', 'error', 'smart_flint_launch'].some(key => new URLSearchParams(window.location.search).has(key)));
  const [refreshing, setRefreshing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const controller = useRef<AbortController | null>(null);
  const interpreted = useMemo(() => {
    if (!snapshot) return { current: null, preview: null, error: '' };
    try {
      return { current: assessHealth(snapshot), preview: assessHistoricalHealth(snapshot), error: '' };
    } catch {
      return { current: null, preview: null, error: 'The record was received, but this sample could not interpret it safely. Review the source FHIR data or reconnect to try again.' };
    }
  }, [snapshot]);
  const currentAssessment = interpreted.current;
  const historicalPreview = interpreted.preview;
  const currentHasUrgentAction = currentAssessment?.actions.some(action => action.priority === 'urgent') ?? false;
  const automaticView: AssessmentView = currentAssessment?.score.value === null && historicalPreview?.score.value != null && !currentHasUrgentAction ? 'historical' : 'current';
  const requestedView = selection.automaticallyHistorical && currentHasUrgentAction ? 'current' : selection.view === 'auto' ? automaticView : selection.view;
  const assessment = requestedView === 'historical' && historicalPreview ? historicalPreview : currentAssessment;
  const automaticallyHistorical = selection.view === 'auto' ? automaticView === 'historical' : selection.automaticallyHistorical;
  const visibleError = error || interpreted.error;

  useEffect(() => {
    if (!currentAssessment) return;
    // Resolve once per activation. Refreshes and route changes retain this choice.
    setSelection(previous => {
      if (previous.automaticallyHistorical && currentAssessment.actions.some(action => action.priority === 'urgent')) return { view: 'current', automaticallyHistorical: false };
      return previous.view === 'auto' ? { view: automaticView, automaticallyHistorical: automaticView === 'historical' } : previous;
    });
  }, [currentAssessment, automaticView]);

  useEffect(() => {
    let active = true;
    completePatientLaunch().then(result => {
      if (!active) return;
      if (result) {
        setSnapshot(null);
        setSelection({ view: 'auto', automaticallyHistorical: false });
        setConnection(result);
        setRoute(result.activation.mode === 'gateway' ? 'gateway' : 'direct');
        setRefreshing(true);
      }
      // The document is still on this callback until location.assign commits.
      if (!result && initialEHRBootstrap.current) return;
      setBusy(false);
    }).catch(reason => { if (active) { setError(friendlyError(reason)); setBusy(false); } });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!connection || closing) return;
    const abort = new AbortController();
    controller.current?.abort();
    controller.current = abort;
    setRefreshing(true);
    loadPatientSnapshot(connection, route, abort.signal).then(result => {
      if (abort.signal.aborted) return;
      setSnapshot(result);
      setError('');
    }).catch(reason => { if (!abort.signal.aborted) setError(friendlyError(reason)); }).finally(() => { if (!abort.signal.aborted) setRefreshing(false); });
    return () => abort.abort();
  }, [connection, route, closing]);

  async function launch() {
    setError(''); setBusy(true);
    try { await startPatientLaunch(installation.trim(), route); }
    catch (reason) { setError(friendlyError(reason)); setBusy(false); }
  }

  async function refresh() {
    if (!connection || refreshing || closing) return;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setRefreshing(true); setError('');
    try { const result = await loadPatientSnapshot(connection, route, abort.signal); if (!abort.signal.aborted) setSnapshot(result); }
    catch (reason) { if (!abort.signal.aborted) setError(friendlyError(reason)); }
    finally { if (!abort.signal.aborted) setRefreshing(false); }
  }

  async function close() {
    if (!connection || closing) return;
    setClosing(true); setError(''); controller.current?.abort();
    try {
      await connection.session.close();
    } catch {
      setError('Your record was cleared from this app, but we could not confirm that the bridge session closed. Contact your SMART Flint administrator if you need help closing it.');
    } finally {
      controller.current?.abort();
      forgetCompletedLaunch();
      setConnection(null); setSnapshot(null); setSelection({ view: 'auto', automaticallyHistorical: false }); setRefreshing(false); setDialog(null); setClosing(false);
      window.history.replaceState(null, '', '/');
    }
  }

  function selectView(view: AssessmentView) {
    if (closing || (view === 'historical' && !historicalPreview)) return;
    setSelection({ view, automaticallyHistorical: false });
  }

  return <>
    <header className="header"><div className="header-inner main-width"><Brand />{(!busy || connection) && <nav aria-label="Application"><button type="button" className={`nav-link ${connection ? 'active' : ''}`} onClick={() => { setDialog(null); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>{connection ? 'Your overview' : 'Welcome'}</button><button type="button" className="nav-link" onClick={() => setDialog('about')}>How it works</button></nav>}<div className="header-actions">{connection ? <><span className="connected-label"><span />Record connected</span><button type="button" className="icon-button" onClick={close} disabled={closing} aria-label="Disconnect health record">{closing ? <LoaderCircle size={19} className="spin" /> : <LogOut size={19} />}</button></> : <span className="private-label"><ShieldCheck size={15} /> Private by design</span>}</div></div></header>
    {returningWithoutSession && !connection && !busy && <div className="session-notice main-width" role="status"><ShieldCheck size={18} /><p>Your record is kept in memory for this tab only. After a reload, connect again to start a fresh session.</p></div>}
    {visibleError && <div className="error-banner main-width" role="alert"><Info size={19} /><div><strong>We couldn’t finish that step.</strong><p>{visibleError}</p>{connection && <button type="button" className="text-button" onClick={refresh} disabled={refreshing || closing}>Try reading the record again <RefreshCw size={14} /></button>}</div>{error && <button type="button" className="icon-button" onClick={() => setError('')} aria-label="Dismiss message"><X size={17} /></button>}</div>}
    {connection && assessment && snapshot && currentAssessment ? <Dashboard assessment={assessment} currentAssessment={currentAssessment} snapshot={snapshot} historicalPreview={historicalPreview} automaticallyHistorical={automaticallyHistorical} refreshing={refreshing} closing={closing} onRefresh={refresh} onAbout={() => setDialog('about')} onSources={() => setDialog('sources')} onViewChange={selectView} /> : connection ? <main className="main-width connected-loading"><AssessmentTabs view="current" historicalAvailable={false} onSelect={selectView} loading={refreshing} disabled={closing} /><section className="loading-state" id="assessment-panel" role="tabpanel" aria-labelledby="assessment-tab-current" aria-live="polite"><span className="loading-icon"><HeartPulse size={32} /></span><h1>{refreshing ? 'Getting to know your record' : 'Your record is connected'}</h1><p>{refreshing ? 'Reading your patient and observation resources securely…' : 'We haven’t been able to read enough information yet. Review the message above or try refreshing.'}</p>{refreshing ? <LoaderCircle size={24} className="spin" /> : <button type="button" className="button primary" onClick={refresh} disabled={closing}>Try again <RefreshCw size={16} /></button>}</section></main> : busy ? <main className="main-width loading-state launch-loading" data-testid="launch-loading" aria-live="polite" aria-busy="true"><span className="loading-icon"><HeartPulse size={32} /></span><h1>Connecting your health record</h1><p>Completing your secure connection. You’ll continue to your record shortly.</p><LoaderCircle size={24} className="spin" /></main> : <Landing onLaunch={launch} busy={busy} installation={installation} setInstallation={setInstallation} route={route} setRoute={setRoute} onAbout={() => setDialog('about')} />}
    <footer className="footer main-width"><p><HeartPulse size={15} /> Health Compass <span>·</span> Built with SMART Flint</p><button type="button" className="text-button developer-button" onClick={() => setDialog('connection')}><Code2 size={15} /> Developer connection</button></footer>
    {dialog === 'about' && <Modal title="About your health snapshot" onClose={() => setDialog(null)}><About assessment={assessment} /></Modal>}
    {dialog === 'sources' && <Modal title="Sources & guidance" onClose={() => setDialog(null)}><p>The assessment rules link to these public guidance sources. The score itself is custom, illustrative, and unvalidated.</p><div className="sources-list">{assessment?.evidence.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer"><BookOpen size={20} /><span>{source.title}<small>{new URL(source.url).hostname}</small></span><ExternalLink size={16} /></a>)}</div><p className="muted">Guidance is a starting point for discussion. Your care team can interpret it alongside your individual circumstances.</p></Modal>}
    {dialog === 'connection' && <Modal title="Developer connection" onClose={() => setDialog(null)}><span className="eyebrow">A separate SMART application</span><p>The SDK handles activation and supplies a connection. Patient and observation reads use standard FHIR HTTP requests, so you can substitute your preferred FHIR client.</p><dl className="connection-metadata"><div><dt>SMART Flint</dt><dd>{bridgeUrl}</dd></div><div><dt>App callback</dt><dd>{window.location.origin}/callback</dd></div>{connection && <><div><dt>Activation</dt><dd>{connection.activation.id}</dd></div><div><dt>Tenant / installation</dt><dd>{connection.activation.tenantId}<br />{connection.activation.installationId}</dd></div><div><dt>FHIR version</dt><dd>{connection.activation.upstream.fhirVersion}</dd></div><div><dt>FHIR endpoint</dt><dd>{route === 'gateway' ? connection.activation.gateway.baseUrl : connection.activation.upstream.baseUrl}</dd></div><div><dt>Granted scopes</dt><dd>{connection.activation.grantedScopes.join(' ')}</dd></div><div><dt>Refresh owner</dt><dd>SMART Flint</dd></div></>}</dl><fieldset className="route-field"><legend>Read FHIR through</legend><div className="segmented"><button type="button" className={route === 'gateway' ? 'selected' : ''} aria-pressed={route === 'gateway'} onClick={() => setRoute('gateway')} disabled={refreshing || closing}><ShieldCheck size={16} /> Gateway</button><button type="button" className={route === 'direct' ? 'selected' : ''} aria-pressed={route === 'direct'} onClick={() => setRoute('direct')} disabled={refreshing || closing}><ArrowUpRight size={16} /> Original FHIR server</button></div></fieldset><p className="muted">Direct mode requires token export permission and browser CORS support from the original server. Credentials remain in memory. This patient sample uses bridge-managed refresh in both modes; the SDK also supports explicit credential ownership handoff for other app designs.</p>{connection?.activation.context.extensions.synthetic_environment === true && <div className="notice"><Database size={18} /><p>This activation is using synthetic local records.</p></div>}<p className="muted">No access tokens, refresh tokens, or patient resources are displayed in this inspector. Reloading requires a fresh launch.</p></Modal>}
  </>;
}
