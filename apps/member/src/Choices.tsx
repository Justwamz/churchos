import { useState } from 'react';
import { Card, ErrorNote, Spinner, useAsync, useToast } from '@churchos/ui';
import { api, errText } from './api';

export function MessageChoices() {
  const p = useAsync<any>(() => api.get('/me/preferences'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const toast = useToast();

  const save = async (patch: { whatsappOptIn?: boolean; smsOptOut?: boolean }) => {
    setBusy(true); setError(undefined);
    try {
      const r = await api.put('/me/preferences', patch);
      p.setData({ ...p.data, whatsappOptIn: r.whatsappOptIn, smsOptOut: r.smsOptOut });
      toast.show('Saved');
    } catch (e) { setError(errText(e)); toast.show('We could not save that', 'bad'); }
    setBusy(false);
  };

  return (
    <Card title="Message choices">
      {p.loading && !p.data ? <Spinner /> : p.error && !p.data ? <ErrorNote>{p.error}</ErrorNote> : (
        <div className="stack">
          <label className="switch-row">
            <input type="checkbox" disabled={busy} checked={!!p.data?.whatsappOptIn} onChange={(e) => save({ whatsappOptIn: e.target.checked })} />
            <span><strong>WhatsApp messages from my church</strong><br /><span className="tiny">Only turn this on if you want your church to message you on WhatsApp</span></span>
          </label>
          <label className="switch-row">
            <input type="checkbox" disabled={busy} checked={!p.data?.smsOptOut} onChange={(e) => save({ smsOptOut: !e.target.checked })} />
            <span><strong>SMS messages from my church</strong><br /><span className="tiny">Receipts for your own giving are always sent</span></span>
          </label>
          {error && <ErrorNote>{error}</ErrorNote>}
        </div>
      )}
      {toast.node}
    </Card>
  );
}
