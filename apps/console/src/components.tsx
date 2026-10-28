import { cloneElement, isValidElement, useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react';
import { AlertCircle, Check, CheckCircle2, Copy, LoaderCircle, Search, X } from 'lucide-react';

export function Badge({ value, children }: { value: string; children?: ReactNode }) {
  return <span className={`badge badge-${value.replaceAll('_', '-')}`}><span className="status-dot" />{children || value.replaceAll('_', ' ')}</span>;
}

export function VendorMark({ vendor }: { vendor: string }) {
  const labels: Record<string, string> = { epic: 'E', oracle: 'O', meditech: 'M', generic: 'F' };
  return <span aria-hidden="true" className={`vendor-mark vendor-${vendor}`}>{labels[vendor] || 'F'}</span>;
}

export function Empty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="empty"><div className="empty-icon"><Search size={23} /></div><h3>{title}</h3><p>{children}</p>{action}</div>;
}

export function ErrorNotice({ message }: { message: string }) {
  return <div className="error-notice" role="alert"><AlertCircle size={17} /><span>{message}</span></div>;
}

export function Loading({ label = 'Loading workspace…' }: { label?: string }) {
  return <div className="loading"><LoaderCircle size={22} className="spin" /><span>{label}</span></div>;
}

export function SearchField({ value, onChange, placeholder = 'Search…' }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <label className="search-field"><Search size={16} /><input aria-label={placeholder} value={value} placeholder={placeholder} onChange={event => onChange(event.target.value)} />{value && <button type="button" title="Clear search" onClick={() => onChange('')}><X size={14} /></button>}</label>;
}

export function Modal({ title, description, children, close, wide = false }: { title: string; description?: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} aria-label={title} className={`modal ${wide ? 'modal-wide' : ''}`} onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === dialog.current) close(); }}>
    <div className="modal-head"><div><span className="eyebrow">WORKSPACE CONFIGURATION</span><h2>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" aria-label="Close dialog" onClick={close}><X size={21} /></button></div>
    {children}
  </dialog>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const hintId = useId();
  const control = isValidElement(children) ? cloneElement(children as ReactElement<{ 'aria-label'?: string; 'aria-describedby'?: string }>, { 'aria-label': label, ...(hint ? { 'aria-describedby': hintId } : {}) }) : children;
  return <label className="field"><span>{label}</span>{control}{hint && <small id={hintId}>{hint}</small>}</label>;
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  return <button className="button button-small button-quiet" ref={ref} onClick={async () => {
    try {
      await navigator.clipboard.writeText(text);
      if (ref.current) { ref.current.dataset.copied = 'true'; setTimeout(() => { if (ref.current) delete ref.current.dataset.copied; }, 1800); }
    } catch { if (ref.current) ref.current.title = 'Select and copy the text manually'; }
  }}><Copy size={14} className="copy-icon" /><Check size={14} className="copied-icon" /><span className="copy-label">{label}</span><span className="copied-label">Copied</span></button>;
}

export function Notice({ children, success = false }: { children: ReactNode; success?: boolean }) {
  return <div className={`notice ${success ? 'notice-success' : ''}`}>{success ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}<div>{children}</div></div>;
}
