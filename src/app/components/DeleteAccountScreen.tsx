import { LegalLayout, B, A, Ul, Li } from './legal/LegalLayout';

export function DeleteAccountScreen() {
  return (
    <LegalLayout
      title="Delete Your Account"
      lastUpdated="August 2026"
      intro="You can permanently delete your Vents account and its associated data at any time, either directly in the app or by requesting deletion here."
      otherPages={[
        { href: '/privacy', label: 'Privacy Policy' },
        { href: '/terms', label: 'Terms of Service' },
        { href: '/', label: '← Back to Vents' },
      ]}
      sections={[
        {
          id: 'in-app',
          title: '1. Delete In-App (Fastest)',
          body: (
            <>
              If you have the Vents app installed:
              <Ul>
                <Li>Open Vents and sign in</Li>
                <Li>Go to <B>Settings</B></Li>
                <Li>Tap <B>Delete Account</B> (under Account, in red)</Li>
                <Li>Confirm the deletion</Li>
              </Ul>
              Your account is deleted immediately — no waiting period, no email confirmation required.
            </>
          ),
        },
        {
          id: 'web',
          title: '2. Request Deletion Without the App',
          body: (
            <>
              Don&apos;t have the app installed, or can&apos;t sign in? Email{' '}
              <A href="mailto:support@getvents.com?subject=Account%20Deletion%20Request">support@getvents.com</A>{' '}
              from the email address on your Vents account with the subject line &quot;Account Deletion Request&quot;. Include:
              <Ul>
                <Li>The email address or username on the account</Li>
                <Li>Any phone number associated with the account, if you remember it</Li>
              </Ul>
              We verify the request is coming from the account owner and process it within <B>7 business days</B>. You&apos;ll receive an email confirming once deletion is complete.
            </>
          ),
        },
        {
          id: 'what-is-deleted',
          title: '3. What Gets Deleted',
          body: (
            <>
              Deleting your account removes:
              <Ul>
                <Li>Your profile, login credentials, and account settings</Li>
                <Li>Your saved payment/payout bank details</Li>
                <Li>Your messages, follows, and notification history</Li>
                <Li>Events you organized that have no ticket sales attached</Li>
              </Ul>
            </>
          ),
        },
        {
          id: 'what-is-retained',
          title: '4. What We Retain, and Why',
          body: (
            <>
              A limited set of records is kept even after deletion, as required by law or to protect other users:
              <Ul>
                <Li>
                  <B>Transaction and payment records</B> for events with completed ticket sales — required for tax, accounting, and dispute/chargeback purposes under Nigerian financial record-keeping requirements
                </Li>
                <Li>
                  <B>Fraud and abuse reports</B> filed against or by the account, retained to protect other users from repeat bad actors
                </Li>
              </Ul>
              These retained records are anonymized or restricted from further use where possible, and are not used to reconstruct your profile or contact you again.
            </>
          ),
        },
        {
          id: 'irreversible',
          title: '5. This Is Permanent',
          body: (
            <>
              Account deletion cannot be undone. If you organize events with upcoming ticket sales, cancel or transfer those events first — deleting your account does not automatically refund attendees.
            </>
          ),
        },
        {
          id: 'contact',
          title: '6. Contact',
          body: (
            <>
              Vents App Ltd
              <br />
              Gwarimpa, Abuja, Nigeria
              <br />
              Email: <A href="mailto:support@getvents.com">support@getvents.com</A>
              <br />
              WhatsApp: <A href="https://wa.me/2349030737368">+234 9030 737 368</A>
            </>
          ),
        },
      ]}
    />
  );
}
