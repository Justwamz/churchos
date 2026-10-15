import { Badge, shortDate } from '@churchos/ui';

export function MessageStatus({ m }: { m: any }) {
  if (m.status === 'scheduled') return <Badge tone="info">Goes out {shortDate(m.scheduled_at)}</Badge>;
  if (m.status === 'sent') return <Badge tone="good">Sent</Badge>;
  if (m.status === 'cancelled') return <Badge tone="muted">Cancelled</Badge>;
  if (m.status === 'failed') return <Badge tone="bad">Failed</Badge>;
  return <Badge>Sending</Badge>;
}
