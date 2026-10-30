// VENTS Work: one role row component, every state (approved mockup E).
// Pure derivations from the statuses the app already reads, so the hub,
// the Profile card chips and the tests all agree. Nothing here grants a
// capability: every action routes to the existing onboarding flow, and the
// server stays the only source of truth for what a role may do.

export type PillTone = 'on' | 'wait' | 'off' | 'soon';

export type RoleAction =
  | 'organizer-apply'      // opens the organizer application sheet (any state but active)
  | 'organizer-verify'     // CAC verification
  | 'organizer-studio'     // switch into the organizer view
  | 'provider-verify'      // ServiceProviderVerificationScreen (apply / status)
  | 'provider-setup'       // ServiceProviderSetupScreen (create / edit listing)
  | 'representative'       // Representatives dashboard (join or manage)
  | 'support'              // suspended: contact support
  | 'none';                // nothing to open (staff without organizer capability)

export interface RoleRow {
  key: 'organizer' | 'provider' | 'representative';
  title: string;
  subtitle: string;
  pill: { label: string; tone: PillTone };
  // Short label for the Profile card chip ("Provider · in review").
  chip: { label: string; tone: PillTone };
  action: RoleAction;
}

export type RequestStatus = 'none' | 'pending' | 'approved' | 'rejected';

export interface OrganizerInputs {
  isOrganizer: boolean;           // currentUser.isOrganizer
  isStaff: boolean;               // admin / sub-admin / root: never the application CTA
  isVerified: boolean;            // CAC-verified
  request: RequestStatus;         // latest organizer_requests row
}

export function organizerRole({ isOrganizer, isStaff, isVerified, request }: OrganizerInputs): RoleRow {
  const base = { key: 'organizer' as const, title: 'Organizer' };
  // An 'approved' request is trusted immediately, without waiting for the
  // 15s role-sync poll to flip currentUser.isOrganizer.
  // Staff never get the application CTA. The organizer view itself opens
  // only for an organizer or an admin (App.openCreatorStudio; isOrganizer
  // is already true for admins), so a sub-admin without the capability
  // gets an inert row rather than an "Active" one that does nothing.
  if (isStaff && !isOrganizer) {
    return { ...base, subtitle: 'Not needed for staff accounts', pill: { label: 'Staff', tone: 'off' }, chip: { label: 'Organizer', tone: 'off' }, action: 'none' };
  }
  const active = isOrganizer || request === 'approved';
  if (active) {
    if (isVerified || isStaff) {
      return { ...base, subtitle: isStaff ? 'Organizer tools' : 'Verified Organizer', pill: { label: isStaff ? 'Active' : 'Verified', tone: 'on' }, chip: { label: 'Organizer', tone: 'on' }, action: 'organizer-studio' };
    }
    return { ...base, subtitle: 'Get verified with CAC', pill: { label: 'Active', tone: 'on' }, chip: { label: 'Organizer', tone: 'on' }, action: 'organizer-verify' };
  }
  if (request === 'pending') {
    return { ...base, subtitle: 'Application submitted', pill: { label: 'In review', tone: 'wait' }, chip: { label: 'Organizer · in review', tone: 'wait' }, action: 'organizer-apply' };
  }
  if (request === 'rejected') {
    return { ...base, subtitle: 'Apply again', pill: { label: 'Retry', tone: 'off' }, chip: { label: 'Organizer · apply again', tone: 'off' }, action: 'organizer-apply' };
  }
  return { ...base, subtitle: 'Become an Organizer', pill: { label: 'Start', tone: 'off' }, chip: { label: 'Organizer · start', tone: 'off' }, action: 'organizer-apply' };
}

export interface ProviderInputs {
  isProvider: boolean;            // currentUser.is_service_provider
  isStaff: boolean;
  request: RequestStatus;         // latest service_provider_requests row
  profileStatus: string | null;   // service_providers.status, null when no listing
}

export function providerRole({ isProvider, isStaff, request, profileStatus }: ProviderInputs): RoleRow {
  const base = { key: 'provider' as const, title: 'Service Provider' };
  if (profileStatus === 'suspended') {
    return { ...base, subtitle: 'Contact support', pill: { label: 'Paused', tone: 'wait' }, chip: { label: 'Provider · paused', tone: 'wait' }, action: 'support' };
  }
  const canSetUp = isProvider || isStaff || request === 'approved';
  if (canSetUp) {
    return profileStatus
      ? { ...base, subtitle: 'Manage your services', pill: { label: 'Active', tone: 'on' }, chip: { label: 'Provider', tone: 'on' }, action: 'provider-setup' }
      : { ...base, subtitle: 'Set up your service profile', pill: { label: 'Active', tone: 'on' }, chip: { label: 'Provider · set up', tone: 'on' }, action: 'provider-setup' };
  }
  if (request === 'pending') {
    return { ...base, subtitle: 'Application submitted', pill: { label: 'In review', tone: 'wait' }, chip: { label: 'Provider · in review', tone: 'wait' }, action: 'provider-verify' };
  }
  if (request === 'rejected') {
    return { ...base, subtitle: 'Apply again', pill: { label: 'Retry', tone: 'off' }, chip: { label: 'Provider · apply again', tone: 'off' }, action: 'provider-verify' };
  }
  return { ...base, subtitle: 'Become a Service Provider', pill: { label: 'Start', tone: 'off' }, chip: { label: 'Provider · start', tone: 'off' }, action: 'provider-verify' };
}

export function representativeRole(status: 'none' | 'active' | 'suspended'): RoleRow {
  const base = { key: 'representative' as const, title: 'Representative' };
  if (status === 'active') {
    return { ...base, subtitle: 'Your team and rewards', pill: { label: 'Active', tone: 'on' }, chip: { label: 'Representative', tone: 'on' }, action: 'representative' };
  }
  if (status === 'suspended') {
    return { ...base, subtitle: 'Contact support', pill: { label: 'Paused', tone: 'wait' }, chip: { label: 'Representative · paused', tone: 'wait' }, action: 'support' };
  }
  return { ...base, subtitle: 'Bring organizers and providers to VENTS', pill: { label: 'Join', tone: 'off' }, chip: { label: 'Representative · join', tone: 'off' }, action: 'representative' };
}

export function toRequestStatus(s: string | null | undefined): RequestStatus {
  return s === 'pending' || s === 'approved' || s === 'rejected' ? s : 'none';
}

// ---------------------------------------------------------------------------
// Representative reward claims: the seven earning states, in plain words.
// ---------------------------------------------------------------------------
export type ClaimStatus =
  | 'pending_organizer' | 'pending_review' | 'approved' | 'funded' | 'credited' | 'rejected' | 'reversed';

export interface ClaimStateView { label: string; tone: PillTone; detail: string }

export function claimStateView(status: ClaimStatus, opts: { payoutsEnabled: boolean; fundingAvailable: boolean }): ClaimStateView {
  switch (status) {
    case 'pending_organizer':
      return { label: 'Pending', tone: 'wait', detail: 'Waiting for the organizer to confirm' };
    case 'pending_review':
      return { label: 'Pending', tone: 'wait', detail: 'Organizer confirmed · VENTS is reviewing' };
    case 'approved':
      return opts.fundingAvailable
        ? { label: 'Approved', tone: 'on', detail: 'Ready to claim' }
        : { label: 'Approved', tone: 'on', detail: 'Waiting for VENTS profit to fund it' };
    case 'funded':
      return opts.payoutsEnabled
        ? { label: 'Funded', tone: 'on', detail: 'Funded · claim to add it to your earnings wallet' }
        : { label: 'Funded', tone: 'on', detail: 'Funded · paid into your earnings wallet when payouts start' };
    case 'credited':
      return { label: 'Withdrawable', tone: 'on', detail: 'In your earnings wallet' };
    case 'rejected':
      return { label: 'Rejected', tone: 'off', detail: 'Not approved' };
    case 'reversed':
      return { label: 'Reversed', tone: 'off', detail: 'Reversed by VENTS' };
  }
}

const ELIGIBILITY_REASON_TEXT: Record<string, string> = {
  event_not_over: 'Event has not ended yet',
  settlement_hold: 'Ticket sales are still settling',
  pending_payments: 'Some ticket payments are still pending',
  pending_purchases: 'Some purchases are still in progress',
  pending_refunds: 'A refund is still being processed',
  event_not_live: 'Event is not published',
  event_deleted: 'Event was deleted',
  event_hidden_by_admin: 'Event was taken down',
  event_not_found: 'Event not found',
};

export function eligibilityReasonText(reason: string): string {
  return ELIGIBILITY_REASON_TEXT[reason] ?? reason.replace(/_/g, ' ');
}

export function formatNaira(kobo: number | null | undefined): string {
  const n = Math.round((kobo ?? 0) / 100);
  return `₦${n.toLocaleString('en-NG')}`;
}
