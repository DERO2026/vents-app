import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { getVcBalance } from '../../../lib/vcBalanceCache';
import { formatNaira } from '../../../lib/workRoles';
import { workPage, workScroll, WorkBar, Tiles, Tile, WorkButton, ErrorNote } from './workUi';

interface Earnings {
  withdrawableKobo: number;
  pendingPayoutKobo: number;
  pendingPayoutSince: string | null;
  ventsWalletKobo: number | null;
  vcSpendable: number | null;
  vcLifetime: number | null;
  rep: null | { creditedKobo: number; payoutsEnabled: boolean; open: number };
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// VENTS Earn (approved mockup C): separately labelled balances, never
// added together. Withdraw and Statement open the existing earnings wallet
// (WalletScreen) -- for organizers AND service providers.
export function VentsEarningsScreen({ currentUser, onBack, onNavigate }: {
  currentUser: { id: string } | null;
  onBack: () => void;
  onNavigate: (screen: string) => void;
}) {
  const [data, setData] = useState<Earnings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!currentUser?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const settle = <T,>(p: PromiseLike<T>) => Promise.resolve(p).then((v) => v, () => null);
        const [wallet, payouts, vw, vc, tier, rep, recruiter] = await Promise.all([
          settle(supabase.from('organizer_wallets').select('balance_kobo').eq('organizer_id', currentUser.id).maybeSingle()),
          settle(supabase.from('organizer_withdrawal_requests').select('amount_kobo, created_at')
            .eq('organizer_id', currentUser.id).in('status', ['pending', 'processing']).order('created_at', { ascending: false })),
          settle(supabase.rpc('get_my_wallet')),
          settle(getVcBalance(currentUser.id)),
          settle(supabase.rpc('vc_tier_and_multiplier_for_user' as any, { p_user_id: currentUser.id })),
          settle(supabase.rpc('get_my_representative_rewards' as any)),
          settle(supabase.from('recruiters').select('id').eq('id', currentUser.id).maybeSingle()),
        ]);
        if (cancelled) return;
        if ((wallet as any)?.error) throw (wallet as any).error;
        const payoutRows: { amount_kobo: number; created_at: string }[] = (payouts as any)?.data ?? [];
        const vwRow = Array.isArray((vw as any)?.data) ? (vw as any).data[0] : (vw as any)?.data;
        const tierRow = Array.isArray((tier as any)?.data) ? (tier as any).data[0] : (tier as any)?.data;
        const repData = (rep as any)?.data;
        const claims: { status: string; amount_kobo: number }[] = repData?.claims ?? [];
        setData({
          withdrawableKobo: (wallet as any)?.data?.balance_kobo ?? 0,
          pendingPayoutKobo: payoutRows.reduce((s, r) => s + (r.amount_kobo || 0), 0),
          pendingPayoutSince: payoutRows[0]?.created_at ?? null,
          ventsWalletKobo: typeof vwRow?.balance_kobo === 'number' ? vwRow.balance_kobo : null,
          vcSpendable: (vc as any)?.spendable ?? null,
          vcLifetime: tierRow?.lifetime_earned ?? null,
          // Before the rewards backend is deployed the RPC is missing:
          // a representative still shows as one, with nothing paid.
          rep: repData?.representative || ((rep as any)?.error && (recruiter as any)?.data)
            ? {
                creditedKobo: claims.filter((c) => c.status === 'credited').reduce((s, c) => s + c.amount_kobo, 0),
                payoutsEnabled: !!repData?.payouts_enabled,
                open: claims.filter((c) => ['pending_organizer', 'pending_review', 'approved', 'funded'].includes(c.status)).length,
              }
            : null,
        });
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Could not load your earnings.');
      }
    })();
    return () => { cancelled = true; };
  }, [currentUser?.id]);

  const dash = '—';
  const rep = data?.rep;

  return (
    <div data-testid="vents-earnings-screen" style={workPage}>
      <WorkBar title="Earnings" sub="Across your VENTS roles" onBack={onBack} />
      <div style={workScroll}>
        {error && <ErrorNote>{error}</ErrorNote>}
        <Tiles>
          <Tile wide testId="earn-tile-withdrawable" k="Withdrawable · Earnings wallet"
            v={data ? formatNaira(data.withdrawableKobo) : dash} s="From ticket sales, bookings and rewards" />
          <Tile testId="earn-tile-pending" k="Pending payout"
            v={data ? formatNaira(data.pendingPayoutKobo) : dash}
            s={data?.pendingPayoutSince ? `Requested ${shortDate(data.pendingPayoutSince)}` : 'None requested'} />
          <Tile testId="earn-tile-vents-wallet" k="VENTS Wallet"
            v={data?.ventsWalletKobo != null ? formatNaira(data.ventsWalletKobo) : dash} s="Spendable, not withdrawable"
            onClick={() => onNavigate('customer-wallet')} />
          <Tile testId="earn-tile-vc" k="VENTS Cents"
            v={data?.vcSpendable != null ? `${data.vcSpendable.toLocaleString()} VC` : dash}
            s={data?.vcLifetime != null ? `Lifetime ${data.vcLifetime.toLocaleString()} VC` : undefined}
            onClick={() => onNavigate('referral')} />
          {rep ? (
            rep.creditedKobo > 0 ? (
              <Tile testId="earn-tile-rep" k="Representative" v={formatNaira(rep.creditedKobo)}
                s="In your earnings wallet" onClick={() => onNavigate('representative-rewards')} />
            ) : (
              <Tile testId="earn-tile-rep" k="Representative" small v="Not paid yet"
                s={rep.payoutsEnabled ? `${rep.open} reward${rep.open === 1 ? '' : 's'} in progress` : 'Payouts not open yet'}
                onClick={() => onNavigate('representative-rewards')} />
            )
          ) : (
            <Tile testId="earn-tile-rep" k="Representative" small v="Not joined" s="₦50,000 per qualifying organizer"
              onClick={() => onNavigate('representatives')} />
          )}
        </Tiles>
        <WorkButton testId="earn-withdraw" onClick={() => onNavigate('wallet')}>Withdraw earnings</WorkButton>
        <WorkButton ghost onClick={() => onNavigate('wallet')}>Statement</WorkButton>
      </div>
    </div>
  );
}
