import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { API_URL, Button, Empty, ErrorNote, Field, Note, kes, useAsync, useToast } from '@churchos/ui';
import { api, friendly } from './session';
import { Card, Section, Stat, StatTiles, StatusChip } from './ui';
import { Loaded } from './money-bits';

function Block({ title, children }: { title: string; children: ReactNode }) { return <Section title={title}><Card>{children}</Card></Section>; }
import './expense-tabs.css';

async function patch(path: string, body: unknown) {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-churchos-app': 'staff', authorization: `Bearer ${api.getToken() ?? ''}` }, body: JSON.stringify(body) });
  } catch { throw new Error('Cannot reach the server. Check your connection and try again.'); }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) { const e: any = new Error(data?.error ?? `Request failed (${res.status})`); e.code = data?.code; throw e; }
  return data;
}

const toKes = (cents: number | null | undefined) => (cents == null ? '' : String(Math.round(Number(cents)) / 100));
const parseKes = (v: string): number | null | undefined => {
  const t = v.replace(/,/g, '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const tone = (p: number | null | undefined) => (p == null ? 'green' : p >= 100 ? 'red' : p >= 80 ? 'amber' : 'green');

function Progress({ percent }: { percent: number | null | undefined }) {
  if (percent == null) return <span className="tiny">No budget</span>;
  const t = tone(percent);
  return (
    <div className="xt-prog">
      <div className={'xt-bar ' + t} role="progressbar" aria-valuenow={Math.min(100, percent)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.min(100, percent)}%` }} /></div>
      <span className={'xt-pct ' + t}>{percent}%</span>
    </div>
  );
}

function useSetup() {
  return useAsync<any>(() => api.get('/expenses/setup'), []);
}

/* ---------------- Budgets ---------------- */

export function ExpenseBudgets() {
  const toast = useToast();
  const setup = useSetup();
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [branchId, setBranchId] = useState('');
  const branches: any[] = setup.data?.branches ?? [];
  useEffect(() => {
    if (!branchId && branches.length) setBranchId((branches.find((b) => b.canManage) ?? branches[0]).id);
  }, [branches, branchId]);
  const d = useAsync<any>(() => (branchId ? api.get(`/expenses/budgets?year=${year}&branchId=${branchId}`) : Promise.resolve(undefined)), [year, branchId]);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [pvals, setPvals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!d.data) return;
    setVals(Object.fromEntries((d.data.categories ?? []).map((c: any) => [c.categoryId, Number(c.budget) > 0 ? toKes(c.budget) : ''])));
    setPvals(Object.fromEntries((d.data.projects ?? []).map((p: any) => [p.id, toKes(p.budget)])));
  }, [d.data]);
  const canManage = !!d.data?.canManage;
  const cats: any[] = d.data?.categories ?? [];
  const projects: any[] = d.data?.projects ?? [];
  const dirty = cats.some((c) => parseKes(vals[c.categoryId] ?? '') !== (Number(c.budget) > 0 ? Number(c.budget) / 100 : null));

  const save = async () => {
    setErr('');
    const categories: any[] = [];
    for (const c of cats) {
      const n = parseKes(vals[c.categoryId] ?? '');
      if (n === undefined) return setErr(`Please check the budget for ${c.name}. Use numbers only.`);
      categories.push({ categoryId: c.categoryId, amount: n });
    }
    setBusy('cats');
    try {
      await api.put('/expenses/budgets', { branchId, year, categories });
      toast.show('Budgets saved'); d.reload();
    } catch (e: any) { setErr(friendly(e?.message)); }
    setBusy('');
  };
  const saveProject = async (p: any, remove = false) => {
    setErr('');
    const n = remove ? null : parseKes(pvals[p.id] ?? '');
    if (n === undefined) return setErr(`Please check the budget for ${p.name}. Use numbers only.`);
    setBusy(p.id);
    try {
      await api.put('/expenses/project-budget', { projectId: p.id, amount: remove || !n ? null : n });
      toast.show(remove || !n ? `Budget removed from ${p.name}` : `Budget saved for ${p.name}`); d.reload();
    } catch (e: any) { setErr(friendly(e?.message)); }
    setBusy('');
  };

  if (setup.error && !setup.data) return <Loaded loading={false} error={setup.error} hasData={false}>{null}</Loaded>;
  return (
    <div className="stack">
      <Block title="Yearly budgets">
        <div className="stack">
          <div className="xt-filters form-row">
            {branches.length > 1 && (
              <Field label="Branch"><select value={branchId} onChange={(e) => setBranchId(e.target.value)}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
            )}
            <Field label="Year"><select value={year} onChange={(e) => setYear(Number(e.target.value))}>{[thisYear - 2, thisYear - 1, thisYear, thisYear + 1].map((y) => <option key={y} value={y}>{y}</option>)}</select></Field>
          </div>
          <Note>When spending reaches 80% and 100% of a budget, the people who manage expenses are told once.</Note>
          {d.data && !canManage && <Note>You can look at the budgets but not change them.</Note>}
          <Loaded loading={d.loading || setup.loading} error={d.error} hasData={!!d.data}>
            {cats.length === 0 ? <Empty>No categories yet. Add some under Rules.</Empty> : (
              <table className="xt-table">
                <thead><tr><th>Category</th><th className="num">Budget (KES)</th><th className="num">Spent</th><th>Used</th></tr></thead>
                <tbody>
                  {cats.map((c) => (
                    <tr key={c.categoryId}>
                      <td className="xt-first">{c.name}</td>
                      <td className="num" data-l="Budget (KES)">
                        {canManage
                          ? <input inputMode="decimal" aria-label={`Budget for ${c.name}`} placeholder="No budget" value={vals[c.categoryId] ?? ''} onChange={(e) => setVals({ ...vals, [c.categoryId]: e.target.value })} />
                          : Number(c.budget) > 0 ? kes(c.budget) : <span className="tiny">No budget</span>}
                      </td>
                      <td className="num" data-l="Spent">{kes(c.spent)}</td>
                      <td className="xt-wide" data-l="Used"><Progress percent={c.percent} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {err && <div style={{ marginTop: 10 }}><ErrorNote>{err}</ErrorNote></div>}
            {canManage && cats.length > 0 && (
              <div className="row" style={{ marginTop: 12, gap: 10, alignItems: 'center' }}>
                <Button disabled={busy === 'cats' || !dirty} onClick={save}>{busy === 'cats' ? 'Saving...' : 'Save budgets'}</Button>
                {dirty && <span className="tiny">You have changes that are not saved.</span>}
              </div>
            )}
          </Loaded>
        </div>
      </Block>
      <Block title="Projects">
        {!d.data ? null : projects.length === 0 ? <Empty>No projects in this branch.</Empty> : (
          <table className="xt-table">
            <thead><tr><th>Project</th><th className="num">Budget (KES)</th><th className="num">Spent</th><th>Used</th>{canManage && <th />}</tr></thead>
            <tbody>
              {projects.map((p) => {
                const cur = p.budget != null ? Number(p.budget) / 100 : null;
                const changed = (parseKes(pvals[p.id] ?? '') ?? null) !== cur;
                return (
                  <tr key={p.id}>
                    <td className="xt-first">{p.name} <span className="tiny">{p.code}</span> {p.restricted && <StatusChip tone="wait">Restricted</StatusChip>}</td>
                    <td className="num" data-l="Budget (KES)">
                      {canManage
                        ? <input inputMode="decimal" aria-label={`Budget for ${p.name}`} placeholder="No budget" value={pvals[p.id] ?? ''} onChange={(e) => setPvals({ ...pvals, [p.id]: e.target.value })} />
                        : p.budget != null ? kes(p.budget) : <span className="tiny">No budget</span>}
                    </td>
                    <td className="num" data-l="Spent">{kes(p.spent)}</td>
                    <td className="xt-wide" data-l="Used"><Progress percent={p.percent} /></td>
                    {canManage && (
                      <td><div className="xt-actions">
                        <Button small disabled={busy === p.id || !changed} onClick={() => saveProject(p)}>Save</Button>
                        {p.budget != null && <Button small kind="ghost" disabled={busy === p.id} onClick={() => saveProject(p, true)}>Remove</Button>}
                      </div></td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Block>
      {toast.node}
    </div>
  );
}

/* ---------------- Reports ---------------- */

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthName = (m: string) => new Date(m + '-01T12:00:00').toLocaleDateString('en-KE', { month: 'short', year: '2-digit' });
const shortKes = (cents: number) => {
  const k = Number(cents) / 100;
  return k >= 1e6 ? `${(k / 1e6).toFixed(1)}M` : k >= 1e4 ? `${Math.round(k / 1e3)}K` : k >= 1e3 ? `${(k / 1e3).toFixed(1)}K` : String(Math.round(k));
};

function HBars({ rows, total }: { rows: { name: string; amount: number }[]; total: number }) {
  if (!rows.length) return <Empty>Nothing here yet.</Empty>;
  return (
    <div>
      {rows.map((r) => {
        const p = total > 0 ? Math.round((Number(r.amount) / total) * 100) : 0;
        return (
          <div className="xt-hrow" key={r.name}>
            <span className="nm">{r.name}</span>
            <span className="am"><b>{kes(r.amount)}</b> · {p}%</span>
            <div className="xt-bar" aria-hidden="true"><i style={{ width: `${Math.max(2, p)}%`, background: 'var(--brand)' }} /></div>
          </div>
        );
      })}
    </div>
  );
}

export function ExpenseReports() {
  const setup = useSetup();
  const now = new Date();
  const [from, setFrom] = useState(`${now.getFullYear()}-01-01`);
  const [to, setTo] = useState(ymd(now));
  const [branchId, setBranchId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const branches: any[] = setup.data?.branches ?? [];
  const qs = (csv = false) => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (branchId) p.set('branchId', branchId);
    if (csv) p.set('csv', '1');
    return '?' + p.toString();
  };
  const key = qs();
  const d = useAsync<any>(() => api.get('/expenses/summary' + key), [key]);
  const x = d.data;
  const preset = (k: 'month' | 'quarter' | 'year') => {
    const n = new Date();
    const start = k === 'month' ? new Date(n.getFullYear(), n.getMonth(), 1) : k === 'quarter' ? new Date(n.getFullYear(), Math.floor(n.getMonth() / 3) * 3, 1) : new Date(n.getFullYear(), 0, 1);
    setFrom(ymd(start)); setTo(ymd(n));
  };
  const csv = async () => {
    setBusy(true); setErr('');
    try {
      const token = api.getToken();
      const res = await fetch(`${API_URL}/expenses${qs(true)}`, { headers: { 'x-churchos-app': 'staff', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      if (!res.ok) throw new Error('Could not download the file. Try again.');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = `expenses-${from}-to-${to}.csv`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) { setErr(friendly(e?.message ?? 'Could not download the file.')); }
    setBusy(false);
  };
  const months: any[] = x?.byMonth ?? [];
  const mMax = Math.max(1, ...months.map((m) => Number(m.amount)));
  const total = Number(x?.totals?.amount ?? 0);
  const empty = x && Number(x.totals?.count ?? 0) === 0;
  const neg = x && Number(x.balance) < 0;

  return (
    <div className="stack">
      <Block title="Spending report">
        <div className="xt-filters form-row">
          <Field label="From"><input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
          {branches.length > 1 && (
            <Field label="Branch"><select value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">All branches</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
          )}
          <div className="xt-presets">
            <Button small kind="ghost" onClick={() => preset('month')}>This month</Button>
            <Button small kind="ghost" onClick={() => preset('quarter')}>This quarter</Button>
            <Button small kind="ghost" onClick={() => preset('year')}>This year</Button>
          </div>
        </div>
      </Block>
      <Loaded loading={d.loading} error={d.error} hasData={!!x}>
        {x && (
          <div className="stack">
            <StatTiles>
              <Stat label="Total spent" value={kes(x.totals.amount)} />
              <Stat label="Expenses" value={x.totals.count} />
              <Stat label="Have a receipt" value={x.totals.receiptShare == null ? '-' : `${x.totals.receiptShare}%`} hint={`${x.totals.withReceipt} of ${x.totals.count}`} />
              <Stat label="Income" value={kes(x.income?.total)} hint={`Giving ${kes(x.income?.giving)} · Cash ${kes(x.income?.cash)}`} />
              <Stat label="Balance" value={kes(x.balance)} hint="Income minus spending" tone={neg ? 'bad' : undefined} />
            </StatTiles>
            <p className="tiny" style={{ margin: 0 }}>Income is what members gave and the church counted, after fees.</p>
            {empty ? <Card><Empty>No approved expenses in these dates.</Empty></Card> : (
              <>
                <Block title="Spending by month">
                  <div className="xt-month">
                    <div className="xt-cols" role="img" aria-label="Spending by month">
                      {months.map((m) => (
                        <div className="xt-col" key={m.name}><span className="val">{shortKes(m.amount)}</span><i style={{ height: `${Math.max(1, (Number(m.amount) / mMax) * 130)}px` }} title={`${monthName(m.name)}: ${kes(m.amount)}`} /></div>
                      ))}
                    </div>
                    <div className="xt-names">{months.map((m) => <div key={m.name}>{monthName(m.name)}</div>)}</div>
                  </div>
                  <p className="tiny" style={{ marginBottom: 0 }}>Amounts are in thousands (K) of shillings.</p>
                </Block>
                <div className="xt-two">
                  <Block title="By category"><HBars rows={x.byCategory ?? []} total={total} /></Block>
                  <Block title="By project"><HBars rows={x.byProject ?? []} total={total} /></Block>
                </div>
                {(x.byBranch?.length ?? 0) > 1 && (
                  <Block title="By branch">
                    <table className="xt-table">
                      <thead><tr><th>Branch</th><th className="num">Expenses</th><th className="num">Spent</th><th className="num">Share</th></tr></thead>
                      <tbody>{x.byBranch.map((b: any) => (
                        <tr key={b.name}><td className="xt-first">{b.name}</td><td className="num" data-l="Expenses">{b.count}</td><td className="num" data-l="Spent">{kes(b.amount)}</td><td className="num" data-l="Share">{total > 0 ? Math.round((Number(b.amount) / total) * 100) : 0}%</td></tr>
                      ))}</tbody>
                    </table>
                  </Block>
                )}
              </>
            )}
            {err && <ErrorNote>{err}</ErrorNote>}
            <div><Button kind="ghost" disabled={busy} onClick={csv}>{busy ? 'Preparing...' : 'Download expenses (CSV)'}</Button></div>
          </div>
        )}
      </Loaded>
    </div>
  );
}

/* ---------------- Rules ---------------- */

function CategoryRow({ c, canManage, onDone }: { c: any; canManage: boolean; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(c.name);
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(c.name), [c.name]);
  const go = async (body: any, ok: string) => {
    setBusy(true);
    try { await patch(`/expenses/categories/${c.id}`, body); toast.show(ok); onDone(); }
    catch (e: any) { toast.show(e?.code === 'duplicate' ? 'You already have a category with that name.' : friendly(e?.message), 'bad'); }
    setBusy(false);
  };
  return (
    <div className={'xt-cat' + (c.active ? '' : ' off')}>
      <input type="text" aria-label="Category name" value={name} maxLength={60} disabled={!canManage || busy} onChange={(e) => setName(e.target.value)} />
      {canManage && <Button small kind="ghost" disabled={busy || !name.trim() || name.trim() === c.name} onClick={() => go({ name: name.trim() }, 'Category renamed')}>Save name</Button>}
      <label><input type="checkbox" checked={c.active} disabled={!canManage || busy} onChange={(e) => go({ active: e.target.checked }, e.target.checked ? 'Category is in use again' : 'Category switched off')} /> {c.active ? 'In use' : 'Switched off'}</label>
      {toast.node}
    </div>
  );
}

export function ExpenseRules() {
  const toast = useToast();
  const d = useSetup();
  const s = d.data?.settings;
  const can = d.data?.can ?? {};
  const [mode, setMode] = useState<'all' | 'above_limit'>('all');
  const [limit, setLimit] = useState('');
  const [two, setTwo] = useState(false);
  const [twoAmt, setTwoAmt] = useState('');
  const [rec, setRec] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [newCat, setNewCat] = useState('');
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (!s) return;
    setMode(s.approvalMode); setLimit(toKes(s.approvalLimit));
    setTwo(s.twoApproverLimit != null); setTwoAmt(toKes(s.twoApproverLimit));
    setRec(toKes(s.receiptRequiredAbove));
  }, [s]);
  const cats: any[] = d.data?.categories ?? [];
  const sorted = useMemo(() => [...cats].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)), [cats]);
  const off = !can.settings;

  const save = async () => {
    setErr('');
    const lim = parseKes(limit), tw = parseKes(twoAmt), rc = parseKes(rec);
    if (mode === 'above_limit' && !lim) return setErr('Please enter the amount above which expenses need approval.');
    if (two && !tw) return setErr('Please enter the amount above which two approvers are needed.');
    if (two && mode === 'above_limit' && lim && tw! <= lim) return setErr('The two-approver amount must be more than the approval amount.');
    if (rc === undefined || tw === undefined || lim === undefined) return setErr('Please use numbers only for the amounts.');
    setBusy(true);
    try {
      await api.put('/expenses/settings', { approvalMode: mode, approvalLimit: mode === 'above_limit' ? lim : Number(toKes(s?.approvalLimit)) || 0, twoApproverLimit: two ? tw : null, receiptRequiredAbove: rc ?? 0 });
      toast.show('Rules saved'); d.reload();
    } catch (e: any) {
      setErr(e?.code === 'bad_amount' ? 'Please check the amounts. The two-approver amount must be more than the approval amount.' : e?.code === 'bad_mode' ? 'Please choose when an expense needs approval.' : friendly(e?.message));
    }
    setBusy(false);
  };
  const addCat = async () => {
    setAdding(true);
    try { await api.post('/expenses/categories', { name: newCat.trim() }); setNewCat(''); toast.show('Category added'); d.reload(); }
    catch (e: any) { toast.show(e?.code === 'duplicate' ? 'You already have a category with that name.' : friendly(e?.message), 'bad'); }
    setAdding(false);
  };

  return (
    <div className="stack">
      <Block title="Approval rules">
        <Loaded loading={d.loading} error={d.error} hasData={!!s}>
          <div className="stack">
            {off && <Note>Only the owner can change these rules.</Note>}
            {s?.standard && <Note tone="warn">These are the standard rules. Check them for your church.</Note>}
            <div className="xt-rule" role="radiogroup" aria-label="When does an expense need approval?">
              <h4>When does an expense need approval?</h4>
              <label className="xt-opt"><input type="radio" name="xt-mode" checked={mode === 'all'} disabled={off} onChange={() => setMode('all')} />
                <span><span className="t">Every expense</span><span className="tiny" style={{ display: 'block' }}>Each one is checked and approved before it counts.</span></span></label>
              <label className="xt-opt"><input type="radio" name="xt-mode" checked={mode === 'above_limit'} disabled={off} onChange={() => setMode('above_limit')} />
                <span><span className="t">Only expenses above this amount</span><span className="tiny" style={{ display: 'block' }}>Smaller ones are approved straight away but still recorded.</span></span></label>
              {mode === 'above_limit' && <div className="xt-amt"><span>KES</span><input inputMode="decimal" aria-label="Approval amount in KES" value={limit} disabled={off} onChange={(e) => setLimit(e.target.value)} /></div>}
              <p className="tiny" style={{ marginBottom: 0 }}>Claims from volunteers always need approval.</p>
            </div>
            <div className="xt-rule">
              <h4>Two different approvers</h4>
              <label className="xt-opt"><input type="checkbox" checked={two} disabled={off} onChange={(e) => setTwo(e.target.checked)} />
                <span><span className="t">Ask for two different approvers above</span><span className="tiny" style={{ display: 'block' }}>Big expenses need two people to say yes. Off means one approver is always enough.</span></span></label>
              {two && <div className="xt-amt"><span>KES</span><input inputMode="decimal" aria-label="Two approvers amount in KES" value={twoAmt} disabled={off} onChange={(e) => setTwoAmt(e.target.value)} /></div>}
            </div>
            <div className="xt-rule">
              <h4>Ask for a receipt above</h4>
              <p className="tiny" style={{ marginTop: 0 }}>Expenses above this amount cannot be sent without a photo or file of the receipt. Use 0 to ask for a receipt every time.</p>
              <div className="xt-amt" style={{ marginLeft: 0 }}><span>KES</span><input inputMode="decimal" aria-label="Receipt amount in KES" value={rec} disabled={off} onChange={(e) => setRec(e.target.value)} /></div>
            </div>
            {err && <ErrorNote>{err}</ErrorNote>}
            {!off && <div><Button disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save rules'}</Button></div>}
          </div>
        </Loaded>
      </Block>
      <Block title="Categories">
        {!d.data ? null : (
          <div>
            {!can.manage && <Note>Only the treasurer and the owner can change categories.</Note>}
            {sorted.length === 0 ? <Empty>No categories yet.</Empty> : sorted.map((c) => <CategoryRow key={c.id} c={c} canManage={!!can.manage} onDone={d.reload} />)}
            {can.manage && (
              <form className="xt-add" onSubmit={(e) => { e.preventDefault(); if (newCat.trim()) addCat(); }}>
                <input aria-label="New category name" placeholder="New category, for example Transport" value={newCat} maxLength={60} onChange={(e) => setNewCat(e.target.value)} />
                <Button type="submit" disabled={adding || !newCat.trim()}>{adding ? 'Adding...' : 'Add category'}</Button>
              </form>
            )}
            <p className="tiny">Switching a category off hides it for new expenses. Old expenses keep it.</p>
          </div>
        )}
      </Block>
      {toast.node}
    </div>
  );
}
