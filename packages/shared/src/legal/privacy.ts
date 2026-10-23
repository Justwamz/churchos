import { churchContactSentence, churchName, contactLine, note, odpcSentence, p, table, ul, type LegalCtx, type LegalDoc } from './types';

export function privacyNotice(c: LegalCtx): LegalDoc {
  const { op } = c;
  const church = churchName(c);
  return {
    slug: 'privacy',
    title: 'Privacy Notice',
    blurb: 'What personal data ChurchOS and your church collect, why, who sees it, how long it is kept and what you can do.',
    summary: [
      `ChurchOS is a service run by ${op.name}. Your church decides why your membership, giving and attendance data is collected. ${op.name} runs the system for the church and looks after your account and the security of the platform.`,
      'We collect your name and phone number, and what you do in the app: giving, attendance, messages, groups, prayer requests and, for children, class check-in and pick-up.',
      'Belonging to a church can reveal religious belief, and children are involved. We treat both as sensitive.',
      'We do not sell your data and we do not show advertising. We make no decisions about you by automated means.',
      'You can download your data, correct it, close your account, withdraw message choices and complain to the Office of the Data Protection Commissioner.',
    ],
    sections: [
      {
        id: 'who', title: 'Who we are and who the church is',
        blocks: [
          p(`ChurchOS is run by ${op.name}. We call ourselves "we" or "the operator" in this notice. Our office is at ${op.address}. Our postal address is ${op.postalAddress}. Our privacy contact is ${op.email}.`),
          p('Two organisations are involved in your data, and they have different roles under the Data Protection Act, 2019 (No. 24 of 2019):'),
          ul(
            `The church is the data controller for its members and visitors. ${church === 'your church' ? 'The church you belong to' : church} decides why your membership, attendance, giving, children's ministry and pastoral data is collected and how it is used. We process that data for the church, on its instructions, as its data processor.`,
            `${op.name} is the data controller for your ChurchOS account and sign-in, for security and abuse prevention, for our audit trail of actions in the system, for billing the churches we serve, and for improving the service in ways that do not look at the content of anyone's records.`,
          ),
          p(churchContactSentence(c)),
          p(odpcSentence(op)),
          p("This notice should be read with our Terms of Use, our Cookie and Local Storage Notice and, where children are involved, our Children's Data Notice."),
        ],
      },
      {
        id: 'collect', title: 'What we collect and why',
        blocks: [
          p('The table shows each kind of data, why it is used, and the legal basis. The bases come from the Data Protection Act, 2019: a contract with you, a legal obligation, your consent, and the legitimate interests of the church or of us.'),
          table(['Data', 'What it covers', 'Why', 'Basis'], [
            ['Account', 'Name, phone number, email address if you add one, passkeys if you add one, when and from which device you signed in.', 'To let you sign in and to keep the account secure.', 'Contract; legitimate interest in security'],
            ['Membership', 'Church and branch, member number, date joined, household, and date of birth and sex if the church records them.', 'To run your membership and to know who belongs to the church.', "Your consent to the church keeping your details (recorded when you are registered); the church's legitimate interest as a religious body in its own members"],
            ['Giving and payments', 'Amount, date, method, purpose, receipt reference, the phone number the payment came from, pledges, regular giving plans, statements. If you give anonymously, the church does not see who you are, but a private link is kept so you can see your own history.', 'To take, receipt and report gifts and payments and to keep honest books.', 'Contract; legal obligation (tax and accounting records)'],
            ['Attendance', 'Services you check in to, how you checked in, and for check-in at a place, whether your phone was inside the service area. For members this is the distance from the church and the accuracy of the reading, not a trail of where you have been.', 'To know who was present and to confirm in-person check-in.', "Church's legitimate interest; your consent to share your phone's location when your phone asks"],
            ['Visitors', 'Name and phone number given at the door or on the visitor page, visit dates, follow-up notes the church writes.', 'To welcome and follow up visitors.', "The visitor's consent; church's legitimate interest"],
            ['Events, bookings, shop and credit', 'Tickets, orders, bookings, event credit and refunds.', 'To sell, deliver and refund what you ordered.', 'Contract'],
            ['What you write', 'Prayer requests, suggestions, group posts and comments.', 'To give you the feature you used.', 'Your consent when you submit it'],
            ['Messages', 'Messages sent to you, your message choices, and a delivery log of SMS and email.', 'To tell you what the church wants you to know and to prove what was sent.', "Your choices; the church's legitimate interest in notices it must give; legal obligation to honour an opt-out"],
            ['Children', "See the Children's Data Notice. Name, date of birth, guardians, class check-in and pick-up records.", "Child safety and children's ministry.", "Consent of a parent or guardian; the child's best interests"],
            ['Church verification', "Documents a church uploads to prove it exists and who may be paid, such as a registration certificate, a tax certificate and an authorised signatory's identity document.", 'To check a church before money is paid out to it.', 'Legal obligation and legitimate interest in preventing fraud'],
            ['Security and platform', 'Session records, rate-limit counters, audit log of who did what and when, error lines with personal details removed.', 'To keep the platform safe and to investigate misuse.', 'Legitimate interest; legal obligation'],
          ]),
          p('Where the law allows us to rely on legitimate interest, we weigh it against your rights. You can object (see "Your rights").'),
        ],
      },
      {
        id: 'sensitive', title: 'Sensitive data',
        blocks: [
          p("The Data Protection Act, 2019 treats some data as sensitive, including data revealing religious belief and data about children. Being a member of a church, baptism and marriage records and prayer requests can reveal religious belief. Children's class and pick-up records are children's data."),
          ul(
            'We only collect this data because you or a parent or guardian gave it to the church or to us, or because it comes from the use of a church service you asked for.',
            "Access is limited by role and branch. Staff pastoral notes are visible only to staff with the right to see them. Looking at a person's giving record needs a stated reason and is logged, and you can see who looked.",
            'We do not use this data for advertising and we do not sell it.',
          ),
        ],
      },
      {
        id: 'sources', title: 'Where the data comes from',
        blocks: [
          ul(
            'From you, when you sign in, give, check in, write something or change your choices.',
            'From your church, when its staff register you, your household or your children, or record a cash gift or a visit.',
            'From payment providers, which tell us whether a payment succeeded and give us its reference.',
            'From a parent or guardian, for a child.',
          ),
        ],
      },
      {
        id: 'share', title: 'Who we share data with',
        blocks: [
          p('We share data only as described here.'),
          ul(
            'Your church and its authorised staff. Staff see what their role and branch allow. Another church cannot see your data at this church.',
            "Payment providers: the mobile money providers and the card payment provider used to take payments. They receive what they need to process the payment, such as the amount, a reference and the phone number to prompt. Card details are entered on the card provider's own page and never reach us.",
            'Messaging providers: the SMS provider and the email provider receive the phone number or email address and the message text needed to deliver it. WhatsApp messages are sent only to people who have opted in.',
            'Hosting: our servers are hosted by a cloud provider in Frankfurt, Germany.',
            'Regulators, courts and the police, when the law requires it or on a lawful request. We check that a request is lawful before we answer it.',
            'Professional advisers and auditors, under a duty of confidentiality, where needed.',
          ),
          p('We do not sell personal data. We can tell you the names of the providers we use if you write to us.'),
        ],
      },
      {
        id: 'transfers', title: 'Transfers outside Kenya',
        blocks: [
          p('Our servers are in Frankfurt, Germany, so your data is transferred outside Kenya when it is stored and processed. Some providers we use may also process data outside Kenya.'),
          p('The Data Protection Act, 2019 and the Data Protection (General) Regulations, 2021 set conditions for transfers. We rely on safeguards that include contracts with our providers that require them to protect the data, and limits on what each provider receives. You can ask us for the details of the safeguards for your data.'),
          note('Some transfers of sensitive data may need a further basis under the Act. We keep this under review with our legal advisers.'),
        ],
      },
      {
        id: 'retention', title: 'How long we keep data',
        blocks: [
          p('These are the periods we apply today. The periods for attendance, visitors and children are the same for every church.'),
          table(['Data', 'Kept', 'What happens'], [
            ['Financial records (journal, payments, giving ledger, payouts, statements)', '7 years', 'Never deleted by an automatic job. The law requires them. After you close your account they stay but no longer name you.'],
            ['Audit log', '7 years', 'Never deleted by an automatic job.'],
            ['Attendance (names and the link to a person)', '3 years', 'Removed automatically each hour. The row and the counts stay so reports still add up.'],
            ["Children's check-in, log and pick-up code details", '7 years', "Names and ids are removed automatically each hour after 7 years. Times, classes and results stay for safeguarding. The child's profile is kept until the child turns 21 and is then reviewed by hand."],
            ['Visitor details', '12 months after the last visit, unless the person joins', 'Name, phone and notes are removed automatically each hour. The visit count and dates stay.'],
            ['Prayer requests', 'Until you withdraw them or the church closes them', 'You can remove your own.'],
            ['Sign-in codes', '24 hours after they expire', 'Deleted automatically.'],
            ['Sessions', 'Until they expire or are ended, plus 30 days', 'Deleted automatically.'],
            ['In-app notifications', '90 days', 'Deleted automatically.'],
            ['Your account and member record', 'Until you ask us to close it', 'See "Deleting your data".'],
            ['Records that you accepted our terms and notices', 'As legal evidence, after your account is closed too', 'Kept linked to the closed account, which no longer carries your name or phone number. The record holds a keyed hash of the network address and a short browser description, not the address itself.'],
          ]),
          p("Some of these periods are working defaults that our legal advisers are still reviewing. If a period changes we will say so here."),
        ],
      },
      {
        id: 'security', title: 'How we protect data',
        blocks: [
          p('No system is perfectly secure. These are measures that exist in the product today:'),
          ul(
            'Sign-in with a one-time code sent to your phone. Passkeys are available, and can be required for platform administrator accounts.',
            'Sessions use random tokens that expire, can be ended from the account, and are ended everywhere when an account is closed. A token is never put in a web address.',
            'Traffic between your device and the service is encrypted in transit (HTTPS) on the hosted service.',
            'Access control by role and branch: staff see only the church and branches they are given.',
            "Row-level security in the database separates one church's data from another's, so a mistake in one request cannot read another church's rows.",
            'An audit log, protected against change, of sensitive actions and of who looked at giving records.',
            'Rate limits on sign-in, code requests, data downloads and other sensitive actions.',
            'Logs have personal details removed: phone numbers show only their last digits and error messages are scrubbed.',
            "Card details are entered on the card provider's own page and never reach us.",
          ),
        ],
      },
      {
        id: 'rights', title: 'Your rights',
        blocks: [
          p('Under the Data Protection Act, 2019 you have these rights. For data held by a church, the church is the controller and we help it answer you.'),
          table(['Right', 'How to use it'], [
            ['Be told how your data is used', 'This notice.'],
            ['Access your data and get a copy (portability)', 'Member app, your picture or initials at the top, then My data and privacy, "Download my data". It gives you a file of your own data. You can do this 3 times a day.'],
            ['Correct your data', 'Change your email and message choices in the member app. Ask the church to change your name, date of birth or household.'],
            ['Delete your data', 'Member app, your picture or initials at the top, then My data and privacy, "Delete my account". Your church (or a platform administrator, if you belong to more than one church) must approve. You are shown first what is removed, what is kept and why.'],
            ['Object to processing, or ask us to restrict it', `Write to ${op.email} or to your church.`],
            ['Withdraw consent', 'Member app, your picture or initials at the top, then My profile and church, message choices. You can withdraw consent to WhatsApp or SMS at any time. Withdrawing does not affect what was done before.'],
            ['Not be subject to automated decisions', 'We make no decision about you by automated means that has legal or similar effect.'],
          ]),
          p('We answer within the time the law allows. We may need to confirm who you are first.'),
        ],
      },
      {
        id: 'deleting', title: 'Deleting your data',
        blocks: [
          p('When a deletion is approved, we remove or anonymise your name, phone, email, member records, inbox, message choices, what you wrote and your names on attendance, tickets and similar records. Regular giving is cancelled. Event credit is lost.'),
          p("We must keep some records. These stay for the periods in the table above, but no longer name you: financial records and receipts, the audit log, giving statements already issued, church registers such as baptism and marriage entries, and the children's safeguarding log. The payer's phone number stays on the payment record itself because it is part of the financial record."),
          p('You cannot close your account here if you are a platform administrator, the only Organisation Owner of a church, or you have a refund still being processed. The app tells you why.'),
        ],
      },
      {
        id: 'breach', title: 'If something goes wrong',
        blocks: [
          p('If personal data is lost or accessed without authority, we tell the affected church without undue delay. Where the law requires, the controller reports to the Office of the Data Protection Commissioner within 72 hours of becoming aware, and tells the people affected where the risk to them is high.'),
        ],
      },
      {
        id: 'cookies', title: 'Cookies and storage',
        blocks: [
          p('The apps do not set advertising or tracking cookies. They keep a few items in your browser to keep you signed in and to remember your settings. The Cookie and Local Storage Notice lists each one.'),
        ],
      },
      {
        id: 'complaints', title: 'Complaints',
        blocks: [
          p(`Please write to us first at ${op.email} and we will try to put it right. You also have the right to complain to the Office of the Data Protection Commissioner. Its website is odpc.go.ke.`),
        ],
      },
      {
        id: 'changes', title: 'Changes to this notice',
        blocks: [
          p('When this notice changes in a way that matters, we change its version date and ask you to read and accept it again the next time you sign in. Earlier versions are available on request.'),
          p(`Contact: ${contactLine(op)}.`),
        ],
      },
    ],
  };
}
