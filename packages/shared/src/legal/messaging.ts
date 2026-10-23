import { contactLine, p, table, ul, type LegalCtx, type LegalDoc } from './types';

export function messagingPolicy(c: LegalCtx): LegalDoc {
  const { op } = c;
  return {
    slug: 'messaging',
    title: 'Acceptable Use and Messaging Policy',
    blurb: 'The rules for churches that send SMS, WhatsApp, email and in-app messages through ChurchOS.',
    summary: [
      'Send messages only to people who should expect them from your church, about your church\'s own activities.',
      'WhatsApp needs a person\'s opt-in. SMS goes out unless the person (or your church) has recorded an opt-out. Every opt-out must be honoured at once.',
      'No unsolicited marketing, no selling of lists, and no messages that deceive, threaten or harass.',
      'Bulk messages need the church\'s Data Processing Agreement to have been accepted by its Organisation Owner.',
    ],
    sections: [
      {
        id: 'who', title: 'Who this is for',
        blocks: [
          p(`This policy applies to every church and every staff member or group leader who sends a message through ChurchOS. It sits alongside the Terms of Use and is part of the church's agreement with ${op.name}. Laws that apply include the Data Protection Act, 2019, the Data Protection (General) Regulations, 2021 (which cover direct marketing and the right to opt out), the Kenya Information and Communications Act and the rules of the Communications Authority of Kenya on SMS, including that people must be able to opt out of messages.`),
        ],
      },
      {
        id: 'how', title: 'How consent and opt-out work in ChurchOS',
        blocks: [
          table(['Channel', 'When ChurchOS sends', 'What you must do'], [
            ['In-app message', 'Always included for members who have the app', 'Keep messages relevant'],
            ['SMS', 'To a number unless the person opted out in the member app or your church recorded an opt-out for that number', 'Only message people who belong to or have dealt with your church. Record an opt-out the moment you are told of one'],
            ['WhatsApp', 'Only to numbers with an opt-in, given by the person in the member app or recorded by your church', 'Record an opt-in only when the person really gave it, and keep evidence. Do not tick it for them'],
            ['Email', 'To the email addresses held on record', 'Same rules as SMS. Include who you are'],
          ]),
          p('A person\'s own choice in the member app applies to every church and always wins. Your church cannot undo it. One church cannot change what another may send.'),
        ],
      },
      {
        id: 'rules', title: 'Rules for sending',
        blocks: [
          ul(
            'Consent or a clear reason first. Message people who gave you their number for church contact, joined, attended, bought a ticket or asked to hear from you. Do not message numbers bought, copied or guessed.',
            'Say who you are. A message should make clear that it comes from your church.',
            'Church business only. Notices, service times, events, pastoral care and giving receipts are fine. Do not use ChurchOS to advertise businesses, politics or products for profit unless the church itself is the seller and the recipient asked to hear about it.',
            'No unsolicited marketing. Marketing messages need the recipient\'s consent.',
            'Honour opt-outs. When someone asks to stop, record it at once in their member record. Do not message them by that channel again. Do not punish a person for opting out.',
            'Send at sensible hours and no more often than people would expect.',
            'No personal or sensitive details in a bulk message. Do not put anyone\'s giving, health, family problems or prayer requests in a message sent to many people.',
            'No content that is false, threatening, harassing, hateful, sexual towards a child, or that breaks the law, including the Computer Misuse and Cybercrimes Act, 2018.',
            'Do not use a sender name that pretends to be someone else. Sender names are approved before use.',
            'Group leaders may reach only their own groups and within the daily limit set in the app.',
          ),
        ],
      },
      {
        id: 'children', title: 'Children',
        blocks: [
          p('Message a child\'s guardian, not the child. A message to the contact of a child goes to the guardian\'s number.'),
        ],
      },
      {
        id: 'dpa', title: 'Before you send bulk messages',
        blocks: [
          p('A church must have accepted the Data Processing Agreement before it can send a bulk message. The Organisation Owner accepts it in the staff app. If it has not been accepted, the send is refused and the screen explains how to accept. Messages to a single member, sign-in codes and security messages are not affected.'),
        ],
      },
      {
        id: 'cost', title: 'Cost and records',
        blocks: [
          p('SMS and WhatsApp use the church\'s messaging credit. The estimate is shown before you send. ChurchOS keeps a log of what was sent, to whom, when and with what result, so that a complaint can be checked. The text of a message may be removed from the log when a person\'s account is erased.'),
        ],
      },
      {
        id: 'breach', title: 'If you break these rules',
        blocks: [
          p(`We may block a message, limit sending, suspend messaging or end a church's access if it sends unlawful or unwanted messages or ignores opt-outs. Complaints from recipients, mobile networks or the Communications Authority of Kenya are taken seriously. To report a message or ask about this policy, write to ${op.email}.`),
          p(`Contact: ${contactLine(op)}.`),
        ],
      },
    ],
  };
}
