import { churchName, contactLine, odpcSentence, p, table, ul, type LegalCtx, type LegalDoc } from './types';

export function dataProcessingAgreement(c: LegalCtx): LegalDoc {
  const { op } = c;
  const church = churchName(c);
  const party = church === 'your church' ? 'the church' : church;
  return {
    slug: 'dpa',
    title: 'Data Processing Agreement',
    blurb: `The agreement between a church (the controller) and ${op.name} (the processor).`,
    summary: [
      `This agreement is between ${party} (the controller) and ${op.name} (the processor). It applies when the church uses ChurchOS.`,
      `${op.name} processes the church's members' data only on the church's instructions, keeps it confidential and secure, helps the church answer data requests, tells the church of a breach without undue delay, and returns or deletes the data when the service ends.`,
      'The Organisation Owner accepts this agreement online in the staff app on behalf of the church. The acceptance is recorded with who accepted, when and the version.',
      'A church must accept it before it sends bulk messages.',
    ],
    sections: [
      {
        id: 'parties', title: 'Parties and law',
        blocks: [
          p(`The controller is ${party}, accepting through its Organisation Owner. The processor is ${op.name}, ${op.address}; post ${op.postalAddress}; contact ${op.email}.`),
          p('This agreement is made under the Data Protection Act, 2019 (No. 24 of 2019) and the Data Protection (General) Regulations, 2021, which require a controller to have a written contract with a processor. Kenyan law governs it.'),
          p(odpcSentence(op)),
        ],
      },
      {
        id: 'subject', title: 'Subject matter, nature and purpose',
        blocks: [
          p('The processor provides the ChurchOS service: software the church uses to manage membership, households, attendance, giving and payments, events and tickets, bookings, a shop, groups, prayer requests, messages, children\'s ministry check-in and pick-up, records and statements.'),
          p('The processing is to store and show this data to the church and its members, take and record payments through payment providers, send messages the church asks to send, produce reports and statements, keep records safe, and give support. The processor does not use church data for its own purposes except as section "Processor\'s own purposes" says.'),
        ],
      },
      {
        id: 'data', title: 'Types of data and of data subjects',
        blocks: [
          table(['Data subjects', 'Types of data'], [
            ['Members and their household members', 'Name, phone number, email, date of birth, sex, member number, household, attendance, giving and payment records, tickets, bookings, messages, prayer requests, group posts, message choices'],
            ['Children', "Name, date of birth, guardians, class check-in and pick-up records (see the Children's Data Notice)"],
            ['Visitors', 'Name, phone number, visit dates and follow-up notes'],
            ['Church staff and volunteers', 'Name, phone number, email, role, actions in the audit log'],
            ['Pick-up people and event buyers', 'Name, phone number, relationship, identity number if given; buyer name, phone and email'],
          ]),
          p('This includes sensitive personal data: data that reveals religious belief, and children\'s data. The processor takes the extra care the Act requires for them.'),
        ],
      },
      {
        id: 'duration', title: 'Duration',
        blocks: [
          p('The agreement lasts from the time the Organisation Owner accepts it until the church stops using ChurchOS and the data has been returned or deleted as set out below. The retention periods in the Privacy Notice continue to apply while the service is in use.'),
        ],
      },
      {
        id: 'instructions', title: "Processor's obligations",
        blocks: [
          ul(
            'Instructions. The processor processes the data only on the church\'s documented instructions, which are this agreement and the church\'s use of the features of the service. If the processor thinks an instruction breaks the law it tells the church.',
            'Confidentiality. People who can reach church data are bound by confidentiality. Platform administrator actions on church data are logged.',
            'Security. The processor keeps the technical and organisational measures in the Privacy Notice: access control by role and branch, row-level separation of one church\'s data from another\'s, encryption in transit, a protected audit log, rate limits and removal of personal details from logs. It reviews them as the service changes.',
            'Sub-processors. The church agrees that the processor may use sub-processors in these categories: cloud hosting; mobile money and card payment providers; SMS, WhatsApp and email delivery providers. The processor binds each one to protect the data and stays responsible for them. It gives the church the current list on request and tells the church of a new category before it is used where it can, so that the church may object.',
            'Assisting with rights. The processor gives the church tools to answer data subjects: the download of a person\'s own data, correction, and the erasure workflow. It helps with other requests within a reasonable time.',
            'Assisting with security, impact assessments and the regulator. The processor gives the information the church reasonably needs for a data protection impact assessment and to deal with the Office of the Data Protection Commissioner.',
            'Breach. The processor tells the church without undue delay after it becomes aware of a personal data breach affecting the church\'s data, with what it knows about what happened, the data and the people involved, the likely effects, and what is being done. The church decides whether to notify the Office of the Data Protection Commissioner, which the law requires within 72 hours of becoming aware where the breach is likely to put people at risk.',
            'Records. The processor keeps a record of the processing it carries out for the church.',
          ),
        ],
      },
      {
        id: 'church', title: "Controller's obligations",
        blocks: [
          ul(
            'The church has a lawful basis for the data it puts in ChurchOS, and has told its members about it.',
            'The church uses roles and branches sensibly and keeps its staff list up to date.',
            'The church follows the Acceptable Use and Messaging Policy when it sends messages.',
            'The church registers with the Office of the Data Protection Commissioner if the law requires it to.',
          ),
        ],
      },
      {
        id: 'transfers', title: 'Transfers outside Kenya',
        blocks: [
          p('The service is hosted in Frankfurt, Germany, so church data is transferred outside Kenya. The church agrees to this transfer. The processor relies on its contract with the hosting provider and the safeguards in the Privacy Notice, and will not move the data to another country without telling the church, except where the law requires.'),
        ],
      },
      {
        id: 'end', title: 'Return and deletion at the end',
        blocks: [
          p('When the church stops using ChurchOS, the processor, at the church\'s choice, returns a copy of the church\'s data in a common format, or deletes it, except where the law requires it to be kept. Financial records and the audit log are kept for 7 years because the law requires financial records to be kept. Deletion from copies that exist in other systems follows their own life cycle.'),
        ],
      },
      {
        id: 'audit', title: 'Audits',
        blocks: [
          p('The church may ask for the information needed to show the processor keeps this agreement, and may carry out or appoint an auditor for a reasonable audit with notice, in business hours, under confidentiality and without harm to other churches\' data. The audit log in the staff app is available to the church for its own data at any time.'),
        ],
      },
      {
        id: 'own', title: "Processor's own purposes",
        blocks: [
          p(`${op.name} is a controller in its own right for the account, security, billing and platform data described in the Privacy Notice. It does not sell church data, does not use it for advertising and looks at its content only to give support the church asks for, to keep the service secure, or when the law requires.`),
        ],
      },
      {
        id: 'accept', title: 'Acceptance and liability',
        blocks: [
          p('The Organisation Owner accepts this agreement online. The system records who accepted, for which church, when, and the version. A new version needs a new acceptance. Each side is liable as the law provides; nothing here limits a liability that cannot be limited. The Terms of Use apply otherwise. If this agreement conflicts with the Terms of Use about personal data, this agreement wins.'),
          p(`Contact: ${contactLine(op)}.`),
        ],
      },
    ],
  };
}
