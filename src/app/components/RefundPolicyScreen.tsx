import { LegalLayout, B, A, Ul, Li } from './legal/LegalLayout';

export function RefundPolicyScreen() {
  return (
    <LegalLayout
      title="Refund Policy"
      lastUpdated="August 2026"
      intro="This policy explains when and how refunds are issued for ticket purchases made on Vents."
      otherPages={[
        { href: '/privacy', label: 'Privacy Policy' },
        { href: '/terms', label: 'Terms of Service' },
        { href: '/', label: '← Back to Vents' },
      ]}
      sections={[
        {
          id: 'commitment',
          title: '1. Our Refund Commitment',
          body: (
            <>
              Vents is committed to ensuring a fair experience for both attendees and organizers. This policy explains when and how refunds are issued for ticket purchases made on the Vents platform.
            </>
          ),
        },
        {
          id: 'eligible',
          title: '2. Eligible Refunds — Attendees',
          body: (
            <>
              You are eligible for a full refund in the following situations:
              <Ul>
                <Li>
                  You request a refund <B>within 48 hours of purchase</B> AND at least 24 hours before the event start time
                </Li>
                <Li>
                  The event is <B>cancelled by the organizer</B>
                </Li>
                <Li>
                  The event is <B>significantly different</B> from what was advertised (different date, venue, or headliner)
                </Li>
                <Li>
                  A <B>technical error</B> resulted in duplicate ticket purchases
                </Li>
              </Ul>
            </>
          ),
        },
        {
          id: 'how-to-request',
          title: '3. How to Request a Refund',
          body: (
            <>
              Email <A href="mailto:support@getvents.com">support@getvents.com</A> with the following information:
              <Ul>
                <Li>Your full name and the email address used to purchase</Li>
                <Li>The event name and date</Li>
                <Li>Your ticket reference number (found in the app under My Tickets)</Li>
                <Li>Reason for your refund request</Li>
              </Ul>
              We will respond within 24 hours. Approved refunds are processed within 5–7 business days back to your original payment method.
            </>
          ),
        },
        {
          id: 'non-refundable',
          title: '4. Non-Refundable Situations',
          body: (
            <>
              Refunds will not be issued if:
              <Ul>
                <Li>
                  The refund request is made <B>less than 24 hours before the event</B>
                </Li>
                <Li>
                  The event has <B>already taken place</B>
                </Li>
                <Li>
                  The ticket was <B>used to gain entry</B> to the event
                </Li>
                <Li>You simply changed your mind more than 48 hours after purchase</Li>
                <Li>The request does not meet the conditions in Section 2</Li>
                <Li>
                  Any <B>Vents Cents</B> applied as a discount — Vents Cents are not real money and are never refunded in cash; only the naira amount actually paid is eligible
                </Li>
              </Ul>
            </>
          ),
        },
        {
          id: 'cancelled-events',
          title: '5. Cancelled Events',
          body: (
            <>
              If an organizer cancels their event, you will be notified by email and in-app notification as soon as the cancellation is confirmed, and your ticket is refunded in full at no cost to you. Refunds for a cancelled event are initiated by the organizer or by Vents on the organizer&apos;s behalf, and typically clear within 5–7 business days of the cancellation being confirmed. If you have not received a refund confirmation within 7 business days of a cancellation, contact <A href="mailto:support@getvents.com">support@getvents.com</A> and we will process it directly.
            </>
          ),
        },
        {
          id: 'organizer-responsibilities',
          title: '6. Organizer Responsibilities',
          body: (
            <>
              Organizers who cancel events are responsible for all associated refund costs including Paystack processing fees where applicable. Organizers with repeated cancellations may have their accounts suspended and may be required to pre-fund future events.
            </>
          ),
        },
        {
          id: 'disputes',
          title: '7. Disputes',
          body: (
            <>
              If you believe a refund was incorrectly denied, email <A href="mailto:support@getvents.com">support@getvents.com</A> with &quot;Refund Dispute&quot; in the subject line. We will review all disputes within 48 hours and communicate our decision. Our decision on disputes is final.
            </>
          ),
        },
        {
          id: 'processing',
          title: '8. Paystack Refund Processing',
          body: (
            <>
              All refunds are processed through Paystack back to the original payment method (debit card or bank account used at checkout). Processing times depend on your bank and card issuer and typically take 5–7 business days after Vents approves the refund. Vents is not responsible for delays caused by your bank or card issuer.
            </>
          ),
        },
        {
          id: 'platform-fees',
          title: '9. Platform Fees',
          body: (
            <>
              Vents&apos; 5% platform fee charged to organizers is non-refundable in cases where the refund is not due to a Vents technical error. In cases of event cancellation by the organizer, the full ticket amount paid by the attendee is refunded.
            </>
          ),
        },
        {
          id: 'contact',
          title: '10. Contact',
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
