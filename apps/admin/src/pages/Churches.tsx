import { useState } from 'react';
import { Badge, Button, Field, Note, StatusBadge, Table, shortDate, useAsync } from '@churchos/ui';
import { Card, Dialog, EmptyState, PageHeader, SidePanel } from '../ui';
import { Load, api, errText, num, type PageProps, type Toast } from '../common';

// ---------------- Church verification (KYC) ----------------

const DOC_TONE: Record<string, any> = { submitted: 'warn', approved: 'good', rejected: 'bad' };
const DOC_LABEL: Record<string, string> = { submitted: 'Awaiting review', approved: 'Approved', rejected: 'Rejected' };
const fileSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const RULE = "A branch is paid out only when the registration certificate, KRA PIN, at least one signatory ID and that branch's payout proof are all approved. The newest document of each type counts.";

export function Kyc({ toast }: PageProps) {
  const list = useAsync(() => api.get<any[]>('/admin/kyc'));
  const [org, setOrg] = useState<any>();
  return (
    <>
      <PageHeader title="Church verification" subtitle="Review the documents churches upload before they can be paid out." actions={<Button kind="ghost" onClick={list.reload}>Refresh</Button>} />
      <Note>{RULE}</Note>
      <div style={{ height: 16 }} />
      <Card pad={false}>
        <Load s={list} rows={4}>
          {(rows) => rows.length === 0 ? <EmptyState icon="building" title="No organisations yet" text="Churches appear here once they sign up." /> : (
            <Table head={['Church', 'Awaiting review', 'Organisation documents', 'Branches', '']}>
              {rows.map((o) => (
                <tr key={o.id}>
                  <td><b>{o.name}</b></td>
                  <td>{num(o.pendingDocuments) > 0 ? <Badge tone="warn">{o.pendingDocuments} to review</Badge> : <span className="tiny">None</span>}</td>
                  <td>{o.organisationReady ? <Badge tone="good">Ready</Badge> : <Badge tone="muted">Incomplete</Badge>}</td>
                  <td>{o.branches.map((b: any) => <div key={b.id} className="pa-line">{b.name} {b.verified ? <Badge tone="good">Verified</Badge> : <Badge tone="muted">Not verified</Badge>}</div>)}</td>
                  <td><Button small onClick={() => setOrg(o)}>Review</Button></td>
                </tr>
              ))}
            </Table>
          )}
        </Load>
      </Card>
      {org && <KycOrg org={org} toast={toast} onClose={() => { setOrg(undefined); list.reload(); }} />}
    </>
  );
}

function KycOrg({ org, toast, onClose }: { org: any; toast: Toast; onClose: () => void }) {
  const d = useAsync(() => api.get<any>(`/admin/kyc/${org.id}`), [org.id]);
  const [rejecting, setRejecting] = useState<string>();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string>();
  const [approving, setApproving] = useState<any>();
  const [verified, setVerified] = useState<Record<string, boolean>>();

  const view = async (id: string) => {
    try {
      const token = api.getToken();
      const res = await fetch(`${api.API_URL}/admin/kyc/documents/${id}/file`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('bad');
      const url = URL.createObjectURL(await res.blob());
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
    } catch { toast('Could not open that document. Please try again.', 'bad'); }
  };
  const decide = async (id: string, approve: boolean) => {
    if (!approve && !reason.trim()) { toast('Type a reason so the church knows what to fix.', 'bad'); return; }
    setBusy(id);
    try {
      const out = await api.post(`/admin/kyc/documents/${id}/decide`, approve ? { approve: true } : { approve: false, reason: reason.trim() });
      setVerified(out.verified); setRejecting(undefined); setReason('');
      toast(approve ? 'Document approved' : 'Document rejected');
      d.reload();
    } catch (e: any) {
      toast(e.code === 'reason_required' ? 'Type a reason so the church knows what to fix.' : e.code === 'already_decided' ? 'This document was already reviewed.' : errText(e), 'bad');
      if (e.code === 'already_decided') d.reload();
    }
    setBusy(undefined); setApproving(undefined);
  };

  const docs = (item: any) => (
    <div className="pa-doc">
      <div className="pa-doc-head"><b>{item.label}</b>{item.latest ? <Badge tone={DOC_TONE[item.latest.status]}>{`Latest: ${DOC_LABEL[item.latest.status] ?? item.latest.status}`}</Badge> : <Badge tone="muted">Not uploaded</Badge>}</div>
      {item.documents.length === 0 && <div className="tiny">Nothing uploaded yet.</div>}
      {item.documents.map((x: any) => (
        <div key={x.id} className="pa-file">
          <div className="pa-file-main">
            <div className="pa-file-name"><Badge tone={DOC_TONE[x.status]}>{DOC_LABEL[x.status] ?? x.status}</Badge> <span>{x.filename}</span></div>
            <div className="tiny">{fileSize(num(x.size))} · uploaded {shortDate(x.created_at)}</div>
            {x.note && <div className="tiny">Note from church: {x.note}</div>}
            {x.status === 'rejected' && x.reason && <div className="tiny">Reason given: {x.reason}</div>}
          </div>
          <div className="pa-file-actions">
            <Button kind="ghost" small onClick={() => view(x.id)}>View</Button>
            {x.status === 'submitted' && <>
              <Button small disabled={busy === x.id} onClick={() => setApproving(x)}>Approve</Button>
              <Button kind="danger" small disabled={busy === x.id} onClick={() => { setRejecting(rejecting === x.id ? undefined : x.id); setReason(''); }}>Reject</Button>
            </>}
          </div>
          {rejecting === x.id && (
            <div className="pa-file-reject">
              <Field label="Reason for rejecting (shown to the church)"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. The name on the certificate does not match" /></Field>
              <div className="row">
                <Button kind="danger" small disabled={busy === x.id} onClick={() => decide(x.id, false)}>Confirm rejection</Button>
                <Button kind="ghost" small onClick={() => setRejecting(undefined)}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <SidePanel title={d.data?.org?.name ?? org.name} subtitle="Review each document, newest first." width={680} onClose={onClose}>
      <Note tone="warn">Before approving, check: the registration name matches the church, the KRA PIN matches, the signatory ID is valid, and the payout account name matches the church.</Note>
      <Load s={d} rows={3}>
        {(o: any) => (<>
          <div className="pa-panel-sec">
            <div className="pa-card-title"><h3>Organisation documents</h3>{o.organisationReady ? <Badge tone="good">Ready</Badge> : <Badge tone="muted">Incomplete</Badge>}</div>
            {o.required.map((r: any) => <div key={r.type}>{docs(r)}</div>)}
          </div>
          <div className="pa-panel-sec">
            <h3>Branches and payout proof</h3>
            {o.branches.map((b: any) => {
              const ok = verified && b.id in verified ? verified[b.id] : b.verified;
              return (
                <div key={b.id} className="pa-branch">
                  <div className="pa-doc-head"><h4>{b.name} <span className="tiny">{b.code}</span></h4>{ok ? <Badge tone="good">Verified: can be paid out</Badge> : <Badge tone="warn">Not verified</Badge>}</div>
                  {docs(b.payoutProof)}
                </div>
              );
            })}
          </div>
          <Note>{RULE}</Note>
        </>)}
      </Load>
      {approving && (
        <Dialog title="Approve this document?" onClose={() => setApproving(undefined)}
          footer={<><Button kind="ghost" onClick={() => setApproving(undefined)}>Cancel</Button><Button disabled={busy === approving.id} onClick={() => decide(approving.id, true)}>{busy === approving.id ? 'Approving…' : 'Yes, approve'}</Button></>}>
          <p className="muted"><b>{approving.filename}</b> will be marked approved. The decision cannot be changed afterwards.</p>
        </Dialog>
      )}
    </SidePanel>
  );
}

// ---------------- Payout account changes ----------------

const destText = (x: any) => {
  const dd = typeof x === 'string' ? (() => { try { return JSON.parse(x); } catch { return null; } })() : x;
  if (!dd) return <span className="tiny">None on file</span>;
  return dd.type === 'mobile'
    ? <>Mobile money<div className="tiny">{dd.phone}{dd.accountName ? ` · ${dd.accountName}` : ''}</div></>
    : <>{dd.bank ?? 'Bank'}<div className="tiny">{dd.accountNumber}{dd.accountName ? ` · ${dd.accountName}` : ''}</div></>;
};

export function PayoutRequests({ toast }: PageProps) {
  const r = useAsync(() => api.get<any[]>('/admin/payout-requests'));
  const [tab, setTab] = useState('waiting');
  const [confirm, setConfirm] = useState<{ id: string; approve: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const decide = async (id: string, approve: boolean) => {
    setBusy(true);
    try { await api.post(`/admin/payout-requests/${id}/decide`, { approve }); toast(approve ? 'Approved. It takes effect after the cooling-off.' : 'Request rejected'); setConfirm(null); r.reload(); }
    catch (e: any) { toast(e.code === 'already_decided' ? 'This request was already decided.' : errText(e), 'bad'); setConfirm(null); r.reload(); }
    setBusy(false);
  };
  const waiting = (r.data ?? []).filter((x) => x.status === 'requested').length;
  return (
    <>
      <PageHeader title="Payout account changes" subtitle="Churches asking to change where their money is paid." actions={<Button kind="ghost" onClick={r.reload}>Refresh</Button>}
        tabs={[{ id: 'waiting', label: 'Waiting for you', badge: waiting }, { id: 'all', label: 'All requests' }]} tab={tab} onTab={setTab} />
      <Note tone="warn"><b>Confirm with the church through a contact you already hold, not the details in this request.</b></Note>
      <div style={{ height: 16 }} />
      <Card pad={false}>
        <Load s={r} rows={4}>
          {(all) => {
            const rows = tab === 'waiting' ? all.filter((x) => x.status === 'requested') : all;
            return rows.length === 0 ? <EmptyState icon={tab === 'waiting' ? 'check' : 'wallet'} title={tab === 'waiting' ? 'Nothing is waiting' : 'No payout account changes yet'} text={tab === 'waiting' ? 'New requests will show here.' : 'Requests from churches will be listed here.'} /> : (
              <Table head={['Church / branch', 'Requested by', 'Requested', 'New account', 'Current account', 'Status']}>
                {rows.map((x) => (
                  <tr key={x.id}>
                    <td><b>{x.branch_name}</b><div className="tiny">{x.branch_code}</div></td>
                    <td>{x.requested_by_name ?? <span className="tiny">Unknown</span>}</td>
                    <td>{shortDate(x.created_at)}</td>
                    <td>{destText(x.destination)}</td>
                    <td>{destText(x.current_destination)}</td>
                    <td>
                      <StatusBadge status={x.status} />
                      {x.status === 'approved' && <div className="tiny">Takes effect {shortDate(x.effective_at)} after the 72 hour cooling-off</div>}
                      {x.status === 'requested' && (
                        <div className="pa-actions start tight">
                          <Button small onClick={() => setConfirm({ id: x.id, approve: true })}>Approve</Button>
                          <Button kind="danger" small onClick={() => setConfirm({ id: x.id, approve: false })}>Reject</Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </Table>
            );
          }}
        </Load>
      </Card>
      {confirm && (
        <Dialog title={confirm.approve ? 'Approve this change?' : 'Reject this change?'} onClose={() => setConfirm(null)}
          footer={<><Button kind="ghost" onClick={() => setConfirm(null)}>Cancel</Button><Button kind={confirm.approve ? 'primary' : 'danger'} disabled={busy} onClick={() => decide(confirm.id, confirm.approve)}>{busy ? 'Working…' : confirm.approve ? 'Yes, approve' : 'Yes, reject'}</Button></>}>
          <Note tone={confirm.approve ? 'warn' : 'info'}>{confirm.approve ? 'Approve this change? Confirm with the church through a contact you already hold, not the details in this request.' : 'Reject this change?'}</Note>
        </Dialog>
      )}
    </>
  );
}
