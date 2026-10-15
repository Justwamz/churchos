import { useEffect, useRef, useState } from 'react';
import { Button, ErrorNote, Note, useAsync } from '@churchos/ui';
import { api, errText } from './api';
import { Composer } from './MyGroups';
import { relTime } from './Community';
import { Icon, Sheet, Skeleton } from './ui';

const initialsOf = (n: string) => (n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || '?';
const enc = encodeURIComponent;
const people = (n: number) => `${n} ${n === 1 ? 'person' : 'people'}`;

// ---------------- the Groups tab ----------------

export function Groups() {
  const g = useAsync<any[]>(() => api.get('/me/groups'));
  const [open, setOpen] = useState<any | null>(null);
  const [find, setFind] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const rows = g.data ?? [];
  const leaderKey = rows.filter((r) => r.role === 'leader').map((r) => r.id).join(',');

  const loadCounts = () => {
    leaderKey.split(',').filter(Boolean).forEach((id) => {
      api.get(`/me/groups/${enc(id)}/requests`).then((r: any[]) => setCounts((c) => ({ ...c, [id]: r.length }))).catch(() => { /* silent */ });
    });
  };
  useEffect(loadCounts, [leaderKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (open) return <GroupPage group={open} onBack={() => { setOpen(null); g.reload(); loadCounts(); }} onCount={(n) => setCounts((c) => ({ ...c, [open.id]: n }))} />;
  return (
    <div className="stack">
      <button type="button" className="find-card" onClick={() => setFind(true)}>
        <span className="msg-ico"><Icon name="groups" size={20} /></span>
        <span className="find-main"><strong>Find a group</strong><span className="tiny">See groups you can ask to join</span></span>
        <Icon name="chev" size={20} />
      </button>
      {g.loading && !g.data ? <div className="card"><Skeleton lines={4} /></div> : g.error && !g.data ? (
        <div className="stack"><ErrorNote>{g.error}</ErrorNote><Button kind="ghost" onClick={g.reload}>Try again</Button></div>
      ) : !rows.length ? (
        <div className="empty-state"><Icon name="groups" size={40} /><strong>You are not in any groups yet</strong><span>Tap Find a group to ask to join one.</span></div>
      ) : (
        <ul className="notice-list">
          {rows.map((r) => (
            <li key={r.id} className="block">
              <button type="button" className="group-card" onClick={() => setOpen(r)}>
                <span className="group-av" aria-hidden="true">{initialsOf(r.name)}</span>
                <span className="group-main">
                  <strong>{r.name}</strong>
                  <span className="tiny ell">{[r.church, r.branch].filter(Boolean).join(' · ')}</span>
                  <span className="tiny">{people(r.memberCount)}</span>
                </span>
                <span className="group-side">
                  <span className={`badge ${r.role === 'leader' ? 'info' : 'muted'}`}>{r.role === 'leader' ? 'Leader' : 'Member'}</span>
                  {(counts[r.id] ?? 0) > 0 && <span className="badge warn">{counts[r.id]} {counts[r.id] === 1 ? 'request' : 'requests'}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <FindSheet open={find} onClose={() => setFind(false)} onChanged={g.reload} />
    </div>
  );
}

// ---------------- find a group ----------------

function FindSheet({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Find a group">
      <FindList onChanged={onChanged} />
    </Sheet>
  );
}

function FindList({ onChanged }: { onChanged: () => void }) {
  const q = useAsync<any[]>(() => api.get('/me/groups/discover'));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const act = async (id: string, withdraw: boolean) => {
    setBusy(id); setError(undefined);
    try { await api.post(`/me/groups/${enc(id)}/join-request${withdraw ? '/withdraw' : ''}`, {}); q.reload(); onChanged(); } catch (e) { setError(errText(e)); q.reload(); }
    setBusy(null);
  };
  const rows = q.data ?? [];
  if (q.loading && !q.data) return <Skeleton lines={4} />;
  if (q.error && !q.data) return <div className="stack"><ErrorNote>{q.error}</ErrorNote><Button kind="ghost" onClick={q.reload}>Try again</Button></div>;
  if (!rows.length) return <p className="mini-empty">No groups are open for requests right now.</p>;
  return (
    <div className="stack">
      {error && <ErrorNote>{error}</ErrorNote>}
      <ul className="find-list">
        {rows.map((r) => (
          <li key={r.id}>
            <strong>{r.name}</strong>
            <span className="tiny">{[r.church, r.branch].filter(Boolean).join(' · ')} · {people(r.memberCount)}</span>
            {r.description && <p className="find-desc">{r.description}</p>}
            {r.myRequest === 'pending' ? (
              <div className="find-act"><span className="badge good">Request sent</span><button type="button" className="link-btn" disabled={busy === r.id} onClick={() => act(r.id, true)}>Withdraw</button></div>
            ) : (
              <Button small disabled={busy === r.id} onClick={() => act(r.id, false)}>{busy === r.id ? 'Sending…' : 'Ask to join'}</Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------- a single group ----------------

type Seg = 'wall' | 'about' | 'requests';

function GroupPage({ group, onBack, onCount }: { group: any; onBack: () => void; onCount: (n: number) => void }) {
  const leader = group.role === 'leader';
  const [seg, setSeg] = useState<Seg>('wall');
  const [msg, setMsg] = useState(false);
  const reqs = useAsync<any[]>(() => (leader ? api.get(`/me/groups/${enc(group.id)}/requests`) : Promise.resolve([])), [group.id]);
  const n = reqs.data?.length ?? 0;
  useEffect(() => { if (reqs.data) onCount(reqs.data.length); }, [reqs.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (msg) return <Composer group={group} onBack={() => setMsg(false)} />;
  return (
    <div className="gpage">
      <div className="gp-head">
        <button type="button" className="icon-btn gp-back" aria-label="Back to my groups" onClick={onBack}><Icon name="back" size={22} /></button>
        <div className="gp-title"><strong>{group.name}</strong><span className="tiny ell">{[group.church, group.branch].filter(Boolean).join(' · ')} · {people(group.memberCount)}</span></div>
      </div>
      <p className="privacy"><Icon name="check" size={14} /> Only people in this group can see this wall.</p>
      {leader && group.canMessage && <Button kind="ghost" onClick={() => setMsg(true)}><Icon name="send" size={18} /> Message the group</Button>}
      <div className="seg" role="tablist" aria-label="Group sections">
        <button type="button" role="tab" aria-selected={seg === 'wall'} className={seg === 'wall' ? 'on' : ''} onClick={() => setSeg('wall')}>Wall</button>
        <button type="button" role="tab" aria-selected={seg === 'about'} className={seg === 'about' ? 'on' : ''} onClick={() => setSeg('about')}>{leader ? 'Members' : 'About'}</button>
        {leader && <button type="button" role="tab" aria-selected={seg === 'requests'} className={seg === 'requests' ? 'on' : ''} onClick={() => setSeg('requests')}>Requests{n > 0 && <span className="seg-count">{n}</span>}</button>}
      </div>
      {seg === 'wall' && <Wall group={group} />}
      {seg === 'about' && <About group={group} leader={leader} />}
      {seg === 'requests' && <Requests group={group} q={reqs} />}
    </div>
  );
}

function About({ group, leader }: { group: any; leader: boolean }) {
  const d = useAsync<any>(() => api.get(`/me/groups/${enc(group.id)}`), [group.id]);
  if (d.loading && !d.data) return <div className="card"><Skeleton lines={3} /></div>;
  if (d.error && !d.data) return <ErrorNote>{d.error}</ErrorNote>;
  const members: any[] = d.data?.members ?? [];
  return (
    <div className="stack">
      <div className="block">
        <strong>{group.name}</strong>
        <p className="tiny" style={{ margin: '4px 0 0' }}>{[group.church, group.branch].filter(Boolean).join(' · ')}</p>
        <p className="tiny" style={{ margin: '4px 0 0' }}>{people(group.memberCount)} · You are {leader ? 'a leader' : 'a member'}</p>
        {d.data?.description && <p className="full-text" style={{ marginTop: 10 }}>{d.data.description}</p>}
      </div>
      {leader && (
        <div className="block">
          <div className="block-head"><h3>Members</h3></div>
          {!members.length ? <p className="mini-empty">No one to show yet</p> : (
            <ul className="plain-list">
              {members.map((m) => (
                <li key={m.id} className="gift-row">
                  <span className="group-av sm" aria-hidden="true">{initialsOf(m.name)}</span>
                  <span className="gift-main"><strong>{m.name}</strong></span>
                  {m.role === 'leader' && <span className="badge info">Leader</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Requests({ group, q }: { group: any; q: { data?: any[]; error?: string; loading: boolean; reload: () => void } }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [note, setNote] = useState<string | undefined>();
  const decide = async (r: any, approve: boolean) => {
    setBusy(r.userId); setError(undefined); setNote(undefined);
    try {
      await api.post(`/me/groups/${enc(group.id)}/requests/${enc(r.userId)}/decide`, { approve });
      setNote(approve ? `${r.name} is now in the group.` : `You declined ${r.name}.`);
    } catch (e) { setError(errText(e)); }
    setBusy(null);
    q.reload();
  };
  const rows = q.data ?? [];
  if (q.loading && !q.data) return <div className="card"><Skeleton lines={3} /></div>;
  return (
    <div className="stack">
      {error && <ErrorNote>{error}</ErrorNote>}
      {note && <Note tone="good">{note}</Note>}
      {!rows.length ? <p className="mini-empty">No requests waiting</p> : (
        <ul className="notice-list">
          {rows.map((r) => (
            <li key={r.userId} className="block req">
              <span className="group-av sm" aria-hidden="true">{initialsOf(r.name)}</span>
              <span className="req-main"><strong>{r.name}</strong><span className="tiny">Asked {relTime(r.requestedAt)}</span></span>
              <span className="req-btns">
                <Button small disabled={busy === r.userId} onClick={() => decide(r, true)}>Approve</Button>
                <Button small kind="ghost" disabled={busy === r.userId} onClick={() => decide(r, false)}>Decline</Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------- wall ----------------

const WALL_ERR: Record<string, string> = {
  forbidden: 'Only leaders can do that here.',
  bad_body: 'Write something up to the limit.',
};

function Wall({ group }: { group: any }) {
  const gid = enc(group.id);
  const w = useAsync<any>(() => api.get(`/me/groups/${gid}/wall`), [group.id]);
  const [menu, setMenu] = useState<any | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const leader = (w.data?.group?.role ?? group.role) === 'leader';
  const posts: any[] = w.data?.posts ?? [];

  const run = async (path: string, body: any = {}) => {
    setBusy(true); setError(undefined);
    try { await api.post(`/me/groups/${gid}/wall${path}`, body); } catch (e: any) { setError(WALL_ERR[e?.code] ?? errText(e)); }
    setBusy(false);
    w.reload();
  };

  return (
    <div className="wall">
      <div className="wall-bar">
        <span className="tiny">{posts.length ? `${posts.length} ${posts.length === 1 ? 'post' : 'posts'}` : ''}</span>
        <button type="button" className="link-btn" onClick={w.reload} disabled={w.loading}><Icon name="refresh" size={16} /> {w.loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {w.loading && !w.data ? <div className="card"><Skeleton lines={4} /></div> : w.error && !w.data ? (
        <div className="stack"><ErrorNote>{w.error}</ErrorNote><Button kind="ghost" onClick={w.reload}>Try again</Button></div>
      ) : !posts.length ? (
        <div className="empty-state"><Icon name="chat" size={40} /><strong>Nothing here yet</strong><span>{w.data?.canPost ? 'Be the first to share something with the group.' : 'Posts from your leaders will show here.'}</span></div>
      ) : (
        <ul className="notice-list">
          {posts.map((p) => (
            <Post key={p.id} p={p} leader={leader} expanded={!!open[p.id]} onToggle={() => setOpen((o) => ({ ...o, [p.id]: !o[p.id] }))}
              onMenu={() => setMenu(p)} onComment={async (text) => { await api.post(`/me/groups/${gid}/wall/${enc(p.id)}/comments`, { body: text }); w.reload(); }}
              onRemoveComment={(cid) => run(`/${enc(p.id)}/comments/${enc(cid)}/remove`)} />
          ))}
        </ul>
      )}
      {w.data && <Composer2 gid={gid} canPost={!!w.data.canPost} leader={leader} onPosted={w.reload} />}
      <Sheet open={!!menu} onClose={() => setMenu(null)} title="Post options">
        {menu && (
          <div className="menu-list">
            {leader && <button type="button" disabled={busy} onClick={() => { const p = menu; setMenu(null); run(`/${enc(p.id)}/pin`, { pinned: !p.pinned }); }}><Icon name="pin" size={20} /> {menu.pinned ? 'Unpin' : 'Pin to top'}</button>}
            {menu.mine && <button type="button" className="danger" disabled={busy} onClick={() => { const p = menu; setMenu(null); run(`/${enc(p.id)}/remove`); }}>Delete</button>}
            {leader && !menu.mine && <button type="button" className="danger" disabled={busy} onClick={() => { const p = menu; setMenu(null); run(`/${enc(p.id)}/remove`); }}>Remove</button>}
            {!leader && !menu.mine && <p className="tiny">There is nothing you can change on this post.</p>}
          </div>
        )}
      </Sheet>
    </div>
  );
}

function Post({ p, leader, expanded, onToggle, onMenu, onComment, onRemoveComment }: { p: any; leader: boolean; expanded: boolean; onToggle: () => void; onMenu: () => void; onComment: (t: string) => Promise<void>; onRemoveComment: (cid: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const announce = p.kind === 'announcement';
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setBusy(true); setErr(undefined);
    try { await onComment(t); setText(''); } catch (e) { setErr(errText(e)); }
    setBusy(false);
  };
  const canMenu = leader || p.mine;
  return (
    <li className={`post block ${announce ? 'announce' : ''}`}>
      <div className="post-head">
        <span className="group-av sm" aria-hidden="true">{initialsOf(p.author)}</span>
        <span className="post-who"><strong className="ell">{p.author}</strong><span className="tiny">{relTime(p.createdAt)}</span></span>
        {announce && <span className="badge warn"><Icon name="megaphone" size={12} /> Announcement</span>}
        {p.pinned && <span className="badge info"><Icon name="pin" size={12} /> Pinned</span>}
        {canMenu && <button type="button" className="icon-btn" aria-label="Post options" onClick={onMenu}><Icon name="more" size={22} /></button>}
      </div>
      <p className="post-body">{p.body}</p>
      <button type="button" className="link-btn post-link" aria-expanded={expanded} onClick={onToggle}>{p.comments.length ? `${p.comments.length} ${p.comments.length === 1 ? 'comment' : 'comments'}` : 'Comment'}</button>
      {expanded && (
        <div className="comments">
          {p.comments.map((c: any) => (
            <div key={c.id} className="comment">
              <span className="group-av xs" aria-hidden="true">{initialsOf(c.author)}</span>
              <div className="comment-main">
                <div><strong>{c.author}</strong> <span className="tiny">{relTime(c.createdAt)}</span></div>
                <p>{c.body}</p>
                {(c.mine || leader) && <button type="button" className="link-btn tiny-link" onClick={() => onRemoveComment(c.id)}>{c.mine ? 'Delete' : 'Remove'}</button>}
              </div>
            </div>
          ))}
          <div className="comment-form">
            <input value={text} maxLength={500} placeholder="Write a comment" aria-label="Write a comment" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
            <button type="button" className="icon-btn send" aria-label="Send comment" disabled={busy || !text.trim()} onClick={send}><Icon name="send" size={20} /></button>
          </div>
          {err && <p className="tiny err">{err}</p>}
        </div>
      )}
    </li>
  );
}

function Composer2({ gid, canPost, leader, onPosted }: { gid: string; canPost: boolean; leader: boolean; onPosted: () => void }) {
  const [text, setText] = useState('');
  const [announce, setAnnounce] = useState(false);
  const [alert, setAlert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const ta = useRef<HTMLTextAreaElement>(null);
  if (!canPost) return <div className="composer"><p className="tiny composer-note">Only leaders can post in this group. You can still comment on posts.</p></div>;
  const post = async () => {
    const body = text.trim();
    if (!body) return;
    setBusy(true); setError(undefined);
    try {
      await api.post(`/me/groups/${gid}/wall`, { body, kind: leader && announce ? 'announcement' : 'post', notify: leader && announce && alert });
      setText(''); setAnnounce(false); setAlert(false);
      onPosted();
    } catch (e) { setError(errText(e)); }
    setBusy(false);
  };
  return (
    <div className="composer">
      {leader && (
        <div className="composer-opts">
          <label className="check-row"><input type="checkbox" checked={announce} onChange={(e) => { setAnnounce(e.target.checked); if (!e.target.checked) setAlert(false); }} /> Make this an announcement</label>
          {announce && <label className="check-row"><input type="checkbox" checked={alert} onChange={(e) => setAlert(e.target.checked)} /> Also alert the group</label>}
        </div>
      )}
      {error && <p className="tiny err">{error}</p>}
      <div className="composer-row">
        <textarea ref={ta} rows={1} maxLength={1000} value={text} placeholder="Share something with the group" aria-label="Write a post" onChange={(e) => setText(e.target.value)} />
        <button type="button" className="btn primary post-btn" disabled={busy || !text.trim()} onClick={post}>{busy ? 'Posting…' : 'Post'}</button>
      </div>
      {text.length >= 850 && <span className={`tiny counter ${text.length >= 1000 ? 'max' : ''}`}>{text.length}/1000</span>}
    </div>
  );
}
