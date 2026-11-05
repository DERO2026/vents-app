// Where "Creator Studio" takes a person.
//
// Root cause this replaces (PR #82's App.openCreatorStudio): it set
// screen 'home' with userRole 'organizer'. Nothing renders differently for
// userRole at screen 'home', so organizers landed on the attendee Home
// feed. Non-organizers hit an early `return`, so the tap did nothing.
//
// Rules:
//   * organizer capability (users.is_organizer, admin/sub-admin, root;
//     the same predicate as hasAnyOrganizerCapability) -> Creator Studio
//     ('org-dashboard', the screen Home's "+" already opens);
//   * otherwise re-read the authoritative flags once. The app's role sync
//     polls every 15s, so a just-approved organizer can still look like a
//     non-organizer locally. An approval found here opens Creator Studio
//     straight away;
//   * still not an organizer -> the organizer application (VENTS Work's
//     OrganizerRequestSheet). Nothing here grants a capability: only
//     admin_decide_organizer_request does that, server-side.

import { hasAnyOrganizerCapability, type PermissionUser } from './permissions';

export type CreatorStudioDestination = 'creator-studio' | 'organizer-application';

export interface CreatorStudioDecision {
  destination: CreatorStudioDestination;
  // true when the re-read found organizer capability the local user
  // object did not have yet; the caller should update currentUser.
  confirmedOrganizer: boolean;
}

export type FetchOrganizerFlags = () => Promise<{ is_organizer?: boolean | null; role?: string | null } | null>;

export async function decideCreatorStudioDestination(
  user: PermissionUser | null | undefined,
  fetchFlags: FetchOrganizerFlags,
): Promise<CreatorStudioDecision> {
  if (!user) return { destination: 'organizer-application', confirmedOrganizer: false };
  if (hasAnyOrganizerCapability(user)) return { destination: 'creator-studio', confirmedOrganizer: false };

  let flags: Awaited<ReturnType<FetchOrganizerFlags>> = null;
  try {
    flags = await fetchFlags();
  } catch {
    flags = null; // can't confirm: fall through to the application, never to Studio
  }
  if (flags && hasAnyOrganizerCapability({ id: user.id, role: flags.role ?? user.role, isOrganizer: flags.is_organizer === true })) {
    return { destination: 'creator-studio', confirmedOrganizer: true };
  }
  return { destination: 'organizer-application', confirmedOrganizer: false };
}
