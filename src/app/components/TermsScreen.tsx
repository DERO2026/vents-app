import { LegalLayout, B, A, Ul, Li } from './legal/LegalLayout';

export function TermsScreen() {
  return (
    <LegalLayout
      title="Terms of Service"
      lastUpdated="August 2026"
      intro="These Terms govern your use of Vents, our event discovery and ticketing platform. They cover accounts, buying and selling tickets, messaging other users, and what happens if something goes wrong."
      otherPages={[
        { href: '/privacy', label: 'Privacy Policy' },
        { href: '/refunds', label: 'Refund Policy' },
        { href: '/', label: '← Back to Vents' },
      ]}
      sections={[
        {
          id: 'acceptance',
          title: '1. Acceptance of Terms',
          body: (
            <>
              By creating an account or using the Vents mobile application or website (&quot;Service&quot;) you agree to these Terms of Service. If you do not agree, do not use the platform. You must be at least 13 years old to create an account. If you are between 13 and 18 years old you may only use the Service with parental or guardian consent.
            </>
          ),
        },
        {
          id: 'about',
          title: '2. About Vents',
          body: (
            <>
              Vents is an event discovery and ticketing platform operated by Vents App Ltd, a company registered in Gwarimpa, Abuja, Nigeria. We connect event organizers with attendees across Nigeria. Vents is a marketplace — we are not the organizer of any event listed on the platform unless explicitly stated.
            </>
          ),
        },
        {
          id: 'accounts',
          title: '3. User Accounts',
          body: (
            <Ul>
              <Li>You must be at least 13 years old to create an account</Li>
              <Li>You must provide accurate and truthful information when registering</Li>
              <Li>You are responsible for keeping your account credentials secure</Li>
              <Li>One person may not create multiple accounts</Li>
              <Li>You may not create an account if you have been permanently banned from the Service</Li>
              <Li>
                You may delete your account at any time from Settings → Account → Delete Account. This is immediate and irreversible — see our{' '}
                <A href="/privacy">Privacy Policy</A> for what happens to your data.
              </Li>
              <Li>We reserve the right to suspend or terminate accounts that violate these Terms</Li>
            </Ul>
          ),
        },
        {
          id: 'attendee-terms',
          title: '4. Attendee Terms',
          body: (
            <Ul>
              <Li>Tickets purchased are subject to the organizer&apos;s event terms and entry requirements</Li>
              <Li>Vents charges no additional fees to attendees beyond the displayed ticket price</Li>
              <Li>Ticket QR codes are for single use only and may not be duplicated or resold</Li>
              <Li>Vents Cents loyalty points have no cash value and cannot be withdrawn or converted to currency</Li>
              <Li>
                See our <A href="/refunds">Refund Policy</A> for information on cancellations and refunds
              </Li>
            </Ul>
          ),
        },
        {
          id: 'organizer-terms',
          title: '5. Organizer Terms',
          body: (
            <Ul>
              <Li>Organizers must provide accurate event information including date, venue, capacity, and description</Li>
              <Li>Organizers are responsible for delivering the event as advertised</Li>
              <Li>Vents charges a 5% platform fee on all paid ticket sales, deducted before payout</Li>
              <Li>Organizer payouts are processed within 1–3 business days after the event concludes</Li>
              <Li>Organizers are responsible for the accuracy of the bank/payout details they provide, and for door check-in of their own events</Li>
              <Li>Organizers must comply with all applicable Nigerian laws, regulations, and venue requirements</Li>
              <Li>Organizers must clearly state their refund policy on their event listing</Li>
              <Li>Vents reserves the right to remove events that violate our policies or receive significant complaints</Li>
              <Li>Organizers who cancel events are responsible for all associated refund costs</Li>
            </Ul>
          ),
        },
        {
          id: 'payments',
          title: '6. Payments',
          body: (
            <Ul>
              <Li>All payments are processed securely by Paystack Technology Limited</Li>
              <Li>Prices are displayed in Nigerian Naira (NGN)</Li>
              <Li>Vents does not store payment card information — all card data goes directly to Paystack</Li>
              <Li>Failed payments will not result in ticket issuance</Li>
              <Li>
                Paystack&apos;s terms are available at{' '}
                <A href="https://paystack.com/terms" external>
                  paystack.com/terms
                </A>
              </Li>
            </Ul>
          ),
        },
        {
          id: 'refunds',
          title: '7. Refunds and Cancellations',
          body: (
            <>
              See our full <A href="/refunds">Refund Policy</A> for complete details on when refunds are available and how to request one.
            </>
          ),
        },
        {
          id: 'vents-cents',
          title: '8. Vents Cents',
          body: (
            <>
              Vents Cents are in-app reward points awarded at our discretion. They:
              <Ul>
                <Li>
                  Are <B>not real money</B> and have no cash value
                </Li>
                <Li>Cannot be withdrawn, transferred, or converted to any currency</Li>
                <Li>May only be used for in-app discounts on ticket purchases</Li>
                <Li>May expire or be adjusted at any time at Vents&apos; discretion</Li>
                <Li>Are not transferable between accounts</Li>
              </Ul>
            </>
          ),
        },
        {
          id: 'community',
          title: '9. Messaging, Following & Community Features',
          body: (
            <>
              Vents lets you follow other users, send direct messages, and report or block accounts. These features are provided for legitimate event-related communication only.
              <Ul>
                <Li>You are responsible for the content of the messages you send</Li>
                <Li>Blocking a user immediately prevents them from messaging you or seeing your activity</Li>
                <Li>Reports are reviewed by our team, and repeated or serious violations can result in suspension or a permanent ban</Li>
                <Li>We may access message content when investigating a report, abuse, or a legal request</Li>
                <Li>Do not use messaging to spam, harass, solicit outside payment, or send unsolicited commercial content</Li>
              </Ul>
            </>
          ),
        },
        {
          id: 'prohibited-conduct',
          title: '10. Prohibited Conduct',
          body: (
            <>
              You may not:
              <Ul>
                <Li>Post false, misleading, or fraudulent event information</Li>
                <Li>Use the platform for illegal activities</Li>
                <Li>Attempt to bypass or circumvent security measures</Li>
                <Li>Harass, threaten, or impersonate other users</Li>
                <Li>Create fake accounts or use automated tools to access the platform</Li>
                <Li>Resell tickets at inflated prices (scalping) without written permission from Vents</Li>
                <Li>Post or distribute content that is unlawful, defamatory, obscene, or that infringes third-party rights</Li>
              </Ul>
            </>
          ),
        },
        {
          id: 'ip',
          title: '11. Intellectual Property',
          body: (
            <>
              The Vents name, logo, and platform are owned by Vents App Ltd and may not be used without written permission. User-generated content (event listings, profile photos, reviews) remains owned by the user. By posting content you grant Vents a non-exclusive, royalty-free license to display and distribute that content in connection with the Service.
            </>
          ),
        },
        {
          id: 'liability',
          title: '12. Limitation of Liability',
          body: (
            <>
              Vents is a platform connecting organizers and attendees. We are not responsible for the quality, safety, or delivery of events organized by third parties. The Service is provided &quot;as is&quot; without warranties of any kind. Our total liability for any claim arising from your use of the Service is limited to the amount you paid Vents in the 12 months preceding the claim.
            </>
          ),
        },
        {
          id: 'suspension',
          title: '13. Account Suspension',
          body: (
            <>
              Vents may suspend or permanently ban accounts that violate these Terms. Banned users may not create new accounts. To appeal a ban, email <A href="mailto:support@getvents.com">support@getvents.com</A>.
            </>
          ),
        },
        {
          id: 'changes',
          title: '14. Changes to These Terms',
          body: (
            <>
              We may update these Terms at any time. Material changes will be notified via email or in-app notification at least 7 days before they take effect. Continued use after that date constitutes acceptance of the updated Terms.
            </>
          ),
        },
        {
          id: 'governing-law',
          title: '15. Governing Law',
          body: (
            <>
              These Terms are governed by the laws of the Federal Republic of Nigeria. Disputes shall be subject to the exclusive jurisdiction of Nigerian courts.
            </>
          ),
        },
        {
          id: 'contact',
          title: '16. Contact',
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
