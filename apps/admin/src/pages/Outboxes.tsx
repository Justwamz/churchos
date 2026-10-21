import { useState } from 'react';
import { Badge, Button, Note, Table, shortDate, useAsync } from '@churchos/ui';
import { Card, EmptyState, PageHeader, SidePanel, StatusChip, Tabs, Toolbar } from '../ui';
import { Load, api, type PageProps } from '../common';

// ---------------- Email outbox ----------------

export function Outbox(_: PageProps) {
  const s = useAsync(() => api.get<any[]>('/admin/outbox'));
  const [open, setOpen] = useState<any>();
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'email' | 'text'>('email');
  const needle = q.trim().toLowerCase();
  const view = open && open.html && tab === 'email' ? 'email' : 'text';
  return (
    <>
      <PageHeader title="Email outbox" subtitle={<StatusChip tone="wait">Development only: simulated email</StatusChip>} actions={<Button kind="ghost" onClick={s.reload}>Refresh</Button>} />
      <Note>Low-balance alerts, ticket confirmations and other emails are written here instead of being sent, while ChurchOS runs against a simulated email provider.</Note>
      <div style={{ height: 16 }} />
      <Toolbar><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by subject or recipient" aria-label="Search emails" /></Toolbar>
      <Card pad={false}>
        <Load s={s} rows={5}>
          {(all) => {
            const rows = needle ? all.filter((r) => `${r.subject} ${r.to_email}`.toLowerCase().includes(needle)) : all;
            if (all.length === 0) return <EmptyState icon="message" title="No emails yet" text="Emails the platform would send appear here." />;
            if (rows.length === 0) return <EmptyState icon="search" title="No emails match" text="Try another word." />;
            return (
              <Table head={['Time', 'To', 'Subject', 'Status', '']}>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{shortDate(r.created_at)}</td>
                    <td>{r.to_email}</td>
                    <td>{r.subject}</td>
                    <td><Badge tone={r.status === 'sent' ? 'good' : 'bad'}>{r.status === 'sent' ? 'Sent' : 'Failed'}</Badge>{r.error && <div className="tiny">{r.error}</div>}</td>
                    <td><Button kind="ghost" small onClick={() => setOpen(r)}>Read</Button></td>
                  </tr>
                ))}
              </Table>
            );
          }}
        </Load>
      </Card>
      {open && (
        <SidePanel title={open.subject} subtitle={`To ${open.to_email} · ${shortDate(open.created_at)}`} width={640} onClose={() => setOpen(undefined)}>
          {open.html && (
            <>
              <Tabs tabs={[{ id: 'email', label: 'Email' }, { id: 'text', label: 'Plain text' }]} tab={view} onTab={(id) => setTab(id as 'email' | 'text')} />
              <p className="tiny pa-gap">{view === 'email' ? 'This is how the person sees it.' : 'This is the version for apps that show text only.'}</p>
            </>
          )}
          {view === 'email'
            ? <div className="outbox-frame"><iframe title={`Email to ${open.to_email}`} sandbox="" srcDoc={open.html} /></div>
            : <pre className="outbox-text">{open.body}</pre>}
        </SidePanel>
      )}
    </>
  );
}

// ---------------- SMS outbox ----------------

export function SmsOutbox(_: PageProps) {
  const s = useAsync(() => api.get<any[]>('/admin/sms-outbox'));
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  return (
    <>
      <PageHeader title="SMS outbox" subtitle={<StatusChip tone="wait">Development only: simulated SMS</StatusChip>} actions={<Button kind="ghost" onClick={s.reload}>Refresh</Button>} />
      <Note>Single messages such as receipts, children's pick-up codes and late pick-up alerts are written here as well as being sent to the simulated SMS provider. Phone numbers are partly hidden.</Note>
      <div style={{ height: 16 }} />
      <Toolbar><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the message or number" aria-label="Search SMS" /></Toolbar>
      <Card pad={false}>
        <Load s={s} rows={5}>
          {(all) => {
            const rows = needle ? all.filter((r) => `${r.body} ${r.to_phone}`.toLowerCase().includes(needle)) : all;
            if (all.length === 0) return <EmptyState icon="message" title="No SMS yet" text="Messages the platform would send appear here." />;
            if (rows.length === 0) return <EmptyState icon="search" title="No SMS match" text="Try another word or number." />;
            return (
              <Table head={['Time', 'To', 'Message', 'Status']}>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{shortDate(r.created_at)}</td>
                    <td>{r.to_phone}</td>
                    <td>{r.body}</td>
                    <td><Badge tone={r.status === 'sent' ? 'good' : 'bad'}>{r.status === 'sent' ? 'Sent' : 'Not sent'}</Badge></td>
                  </tr>
                ))}
              </Table>
            );
          }}
        </Load>
      </Card>
    </>
  );
}
