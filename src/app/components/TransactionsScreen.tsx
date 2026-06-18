import { useState, useEffect } from 'react';
import { ArrowLeft, Ticket, CheckCircle, Clock, XCircle } from 'lucide-react';
import { insforge } from '../../lib/insforge';

interface Transaction {
  id: string;
  event_title: string;
  event_date: string | null;
  amount: number;
  quantity: number;
  ticket_type: string | null;
  payment_status: string;
  payment_ref: string | null;
  created_at: string;
}

interface TransactionsScreenProps {
  onBack: () => void;
}

function formatNaira(amount: number) {
  if (amount === 0) return 'Free';
  return '₦' + amount.toLocaleString('en-NG');
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'paid') return <CheckCircle size={14} color="#10B981" />;
  if (status === 'failed' || status === 'refunded') return <XCircle size={14} color="#EF4444" />;
  return <Clock size={14} color="#F59E0B" />;
}

export function TransactionsScreen({ onBack }: TransactionsScreenProps) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 90);

        const { data, error: dbErr } = await insforge.database
          .from('tickets')
          .select('id, amount, quantity, ticket_type, payment_status, payment_ref, created_at, event_id')
          .gte('created_at', cutoff.toISOString())
          .order('created_at', { ascending: false });

        if (dbErr) throw dbErr;
        if (!data || data.length === 0) { setTransactions([]); return; }

        // Fetch event titles for all tickets in one query
        const eventIds = [...new Set(data.map((t: any) => t.event_id))];
        const { data: eventsData } = await insforge.database
          .from('events')
          .select('id, title, event_date')
          .in('id', eventIds);

        const eventMap: Record<string, { title: string; event_date: string | null }> = {};
        if (eventsData) {
          eventsData.forEach((e: any) => { eventMap[e.id] = { title: e.title, event_date: e.event_date }; });
        }

        setTransactions(data.map((t: any) => ({
          id: t.id,
          event_title: eventMap[t.event_id]?.title ?? 'Unknown Event',
          event_date: eventMap[t.event_id]?.event_date ?? null,
          amount: Number(t.amount) * (t.quantity ?? 1),
          quantity: t.quantity ?? 1,
          ticket_type: t.ticket_type,
          payment_status: t.payment_status,
          payment_ref: t.payment_ref,
          created_at: t.created_at,
        })));
      } catch (err: any) {
        setError(err?.message || 'Failed to load transactions.');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  return (
    <div style={{ background: '#060A12', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: 'calc(20px + env(safe-area-inset-top)) 16px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
        <button onClick={onBack} style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
          <ArrowLeft size={16} color="#C4C9E0" />
        </button>
        <div>
          <h1 style={{ color: '#F0F0FF', fontSize: '20px', fontWeight: 700, margin: 0 }}>Transactions</h1>
          <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '2px 0 0' }}>Last 90 days</p>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', scrollbarWidth: 'none' }}>
        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '200px', color: '#8B8FA8', fontSize: '14px' }}>
            Loading…
          </div>
        ) : error ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: '#F87171', fontSize: '13px' }}>{error}</div>
        ) : transactions.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 20px' }}>
            <Ticket size={40} color="#2D2D4E" style={{ margin: '0 auto 12px' }} />
            <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 600, margin: 0 }}>No transactions yet</p>
            <p style={{ color: '#8B8FA8', fontSize: '12px', marginTop: '4px' }}>Your ticket purchases from the last 90 days will appear here.</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {transactions.map((tx) => (
              <div key={tx.id} style={{ background: '#131629', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '16px', padding: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ color: '#F0F0FF', fontSize: '14px', fontWeight: 700, margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {tx.event_title}
                    </p>
                    <p style={{ color: '#8B8FA8', fontSize: '11px', margin: '3px 0 0' }}>
                      {tx.ticket_type ?? 'General'} · {tx.quantity} ticket{tx.quantity !== 1 ? 's' : ''} · {formatDate(tx.created_at)}
                    </p>
                    {tx.payment_ref && (
                      <p style={{ color: '#4B5563', fontSize: '10px', margin: '3px 0 0', fontFamily: 'monospace' }}>
                        Ref: {tx.payment_ref}
                      </p>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px', flexShrink: 0 }}>
                    <span style={{ color: '#F0F0FF', fontSize: '15px', fontWeight: 800 }}>{formatNaira(tx.amount)}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <StatusIcon status={tx.payment_status} />
                      <span style={{ fontSize: '11px', color: tx.payment_status === 'paid' ? '#10B981' : tx.payment_status === 'failed' || tx.payment_status === 'refunded' ? '#EF4444' : '#F59E0B', fontWeight: 600 }}>
                        {tx.payment_status.charAt(0).toUpperCase() + tx.payment_status.slice(1)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
