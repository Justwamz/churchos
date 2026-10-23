import { churchName, contactLine, p, ul, type LegalCtx, type LegalDoc } from './types';

export function termsOfUse(c: LegalCtx): LegalDoc {
  const { op } = c;
  const church = churchName(c);
  return {
    slug: 'terms',
    title: 'Terms of Use',
    blurb: 'The rules for using the ChurchOS apps and the giving pages.',
    summary: [
      `These terms are between you and ${op.name}, which runs ChurchOS. They cover the member, staff, giving and platform administrator apps.`,
      'You sign in with your phone number and a one-time code. Keep your phone and codes to yourself.',
      'Churches are responsible for the data of their members. A gift is a payment to the church, not to us. Fees are shown before you pay.',
      'We run the service on a best-effort basis. Nothing here takes away your rights under Kenyan law, including consumer rights.',
      'Kenyan law applies and the courts of Kenya decide disputes, after we try to settle it with you first.',
    ],
    sections: [
      {
        id: 'about', title: 'About these terms',
        blocks: [
          p(`ChurchOS is run by ${op.name}, ${op.address}. Postal address: ${op.postalAddress}. Contact: ${op.email}. By ticking the box when you sign in, or by using the giving pages after seeing the link to these terms, you agree to them. If you do not agree, please do not use the service.`),
          p('You must be 18 or older to have your own account. Children do not have accounts. A parent or guardian registers a child with the church. See the Children\'s Data Notice.'),
        ],
      },
      {
        id: 'accounts', title: 'Accounts and phone sign-in',
        blocks: [
          ul(
            'You sign in with your phone number and a one-time code sent to it. In a demonstration or test version the code may be a fixed test code. Do not use a demonstration version for real money or real people.',
            'You are responsible for what happens under your account. Do not share your code or let others use your phone to sign in as you.',
            'Tell us at once at the contact above if you think someone else has your account or your phone number has changed hands.',
            'Give true information. A church may link your account to your membership record using your phone number.',
            'We may limit sign-in attempts and code requests to protect accounts.',
          ),
        ],
      },
      {
        id: 'use', title: 'Acceptable use',
        blocks: [
          p('You must use ChurchOS lawfully and with respect. In line with the Computer Misuse and Cybercrimes Act, 2018, you must not:'),
          ul(
            'try to get into accounts, data or systems you are not allowed to use, or help someone else to;',
            'probe, overload or disrupt the service, or get around limits or security measures;',
            'put in malicious code, or use the service to send spam, harass, threaten or deceive;',
            'look at members\' data without a church duty that needs it (staff), or copy and share it outside the church;',
            'upload content you have no right to, or content that is unlawful;',
            'use the service for money laundering, fraud or any other crime.',
          ),
          p('We may suspend or limit an account that breaks these rules or puts others at risk, and we may report a crime to the authorities.'),
        ],
      },
      {
        id: 'church', title: "The church's responsibilities",
        blocks: [
          p(`${church === 'your church' ? 'Each church' : church} that uses ChurchOS is the controller of its members' data under the Data Protection Act, 2019. A church must:`),
          ul(
            'have a lawful reason to collect each kind of data and tell its members about it;',
            'give staff only the access they need, and remove access when a person leaves a role;',
            'get a parent\'s or guardian\'s agreement before registering a child;',
            'send messages only as set out in the Acceptable Use and Messaging Policy;',
            'answer members\' data requests, with our help;',
            'accept the Data Processing Agreement before sending bulk messages. The Organisation Owner accepts it online for the church.',
          ),
          p('We act for the church as its processor and not as its adviser. A church should take its own legal advice.'),
        ],
      },
      {
        id: 'payments', title: 'Payments, fees, refunds and event credit',
        blocks: [
          ul(
            'A gift is a payment to the church you give to. The church, not ChurchOS, receives it. We run the payment service and the records.',
            'Payments are made through licensed payment service providers (mobile money and card) under the National Payment System Act, 2011. We do not see your card details.',
            'Any fee is shown before you pay. The church chooses whether the fee is added to your payment or taken from what the church receives, and the screen shows the total you will pay.',
            'A mobile money prompt goes to the phone number you enter. Check it is yours and on the right network before you approve.',
            'Gifts and offerings are normally final. If you paid by mistake, ask for a reversal in the app or contact the church. The church and, where needed, a platform administrator review it.',
            'Tickets: if an event is cancelled or you cancel before any ticket is used, you may get your money back or, if you choose, keep it as event credit with that church. Event credit belongs to you, does not expire, can be spent on any ticketed event of the same church, and does not include the service fee. Refund rules for an event can be set by the church, and some tickets, such as ones already used, cannot be refunded.',
            'Closing your account ends event credit and regular giving. The app warns you first.',
            'Statements are issued for the periods the church sets and are kept as issued.',
          ),
        ],
      },
      {
        id: 'availability', title: 'Availability',
        blocks: [
          p('We work to keep ChurchOS available, but we run it on a best-effort basis. It may be unavailable for maintenance, because of a provider fault such as the mobile network, SMS or payment providers, or for reasons outside our control. Staff screens need a connection. We do not promise a particular level of uptime unless we agree one in writing with a church.'),
        ],
      },
      {
        id: 'ip', title: 'Intellectual property',
        blocks: [
          p(`${op.name} owns the ChurchOS software, design and name. We give you a limited, non-exclusive right to use the apps for their intended purpose. A church keeps ownership of its own content, such as its name, logo, notices and records, and gives us the right to host and process it to run the service. You must not copy, reverse engineer or resell the service.`),
        ],
      },
      {
        id: 'liability', title: 'Limits on our liability',
        blocks: [
          p('To the extent Kenyan law allows, we are not liable for loss that we could not reasonably foresee, for loss of profit or opportunity, or for faults of providers outside our control. Nothing in these terms limits liability that cannot lawfully be limited, including liability for fraud, for death or personal injury caused by negligence, or for a breach of a duty under the Data Protection Act, 2019 that cannot be excluded.'),
          p('Nothing in these terms takes away your rights under the Consumer Protection Act, 2012 or any other law. If a term here conflicts with a right the law gives you, the law wins.'),
        ],
      },
      {
        id: 'privacy', title: 'Your data',
        blocks: [
          p('Our Privacy Notice explains what we collect and your rights. Our Cookie and Local Storage Notice lists what the apps keep in your browser. You can download your data and ask for your account to be closed at any time in the member app.'),
        ],
      },
      {
        id: 'records', title: 'Electronic records',
        blocks: [
          p('We keep electronic records of actions in the system, such as sign-ins, acceptances, payments and approvals. You agree that these records may be used as evidence of what happened, in line with the Evidence Act. You can still show that a record is wrong.'),
        ],
      },
      {
        id: 'changes', title: 'Changes to these terms',
        blocks: [
          p('We may change these terms. When a change matters, we change the version date and ask you to accept again the next time you sign in. If you do not accept, you can close your account.'),
        ],
      },
      {
        id: 'termination', title: 'Ending your use',
        blocks: [
          p('You can stop using ChurchOS and close your account in the member app at any time. We may suspend or end access for a serious or repeated breach of these terms, for legal reasons, or if a church stops using the service, in which case we handle the church\'s data as the Data Processing Agreement says. Parts that are meant to continue, such as the sections on liability, records and governing law, continue after that.'),
        ],
      },
      {
        id: 'law', title: 'Governing law and disputes',
        blocks: [
          p(`These terms are governed by the laws of Kenya. If you have a complaint, write to ${op.email} and we will reply and try to settle it in good faith. If that does not settle it, either side may take it to the courts of Kenya, which have jurisdiction. This does not stop you from complaining to the Office of the Data Protection Commissioner or from using any statutory consumer remedy.`),
          p(`Contact: ${contactLine(op)}.`),
        ],
      },
    ],
  };
}
