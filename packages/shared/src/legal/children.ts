import { churchContactSentence, churchName, contactLine, p, table, ul, type LegalCtx, type LegalDoc } from './types';

export function childrenNotice(c: LegalCtx): LegalDoc {
  const { op } = c;
  const church = churchName(c);
  return {
    slug: 'children',
    title: "Children's Data Notice",
    blurb: "What is collected for children's ministry, who agrees to it, and how long it is kept.",
    summary: [
      `A parent or guardian agrees before ${church === 'your church' ? 'the church' : church} registers a child. The church records who agreed, when, and which version of this notice applied.`,
      'We keep a child\'s name, date of birth, guardians and class check-in and pick-up records. We do not collect a child\'s phone number, and children have no accounts.',
      'Pick-up is by a one-time code and by people the guardian has named. Every drop-off and pick-up is logged for safety.',
      'A guardian can see, correct and ask for deletion of a child\'s data. Some safety records are kept for a set period.',
    ],
    sections: [
      {
        id: 'who', title: 'Who is responsible',
        blocks: [
          p(`The church runs its children's ministry and is the controller of children's data under the Data Protection Act, 2019. ${op.name} runs the ChurchOS system for the church as its processor. See the Privacy Notice for the full picture.`),
          p(churchContactSentence(c)),
          p('The Data Protection Act, 2019 requires special care with children\'s data: it may be processed only with the consent of a parent or guardian and in a way that protects and advances the child\'s rights and best interests. The Children Act, 2022 puts the best interests of the child first. A child here means a person under 18.'),
        ],
      },
      {
        id: 'collect', title: 'What is collected',
        blocks: [
          table(['Data', 'Where it comes from', 'Why'], [
            ['Child\'s name, date of birth and sex if given, member number, class', 'The church, from the parent or guardian', 'To register the child, place them in the right class and see when they become an adult at 18'],
            ['Guardians and household', 'The church and the guardian', 'To know who may drop off and collect'],
            ['Check-in record: tag number, time in and out, class, who dropped off and who collected, which staff member and device', 'Made at drop-off and pick-up', 'Child safety and a record of who had the child'],
            ['Pick-up people: name, phone number, relationship and, if the guardian gives it, an identity number', 'The guardian, in the member app', 'So the child is released only to someone the guardian chose'],
            ['One-time codes sent by SMS to a guardian or pick-up person', 'Created at drop-off or pick-up', 'To prove the right person is collecting. The code itself is stored only as a one-way hash and it expires'],
            ['Whether a phone was near the church at check-in or pick-up', "The phone's location reading, if the person allows it", "To check that pick-up is happening where it should. The distance and the result are logged, not the person's coordinates"],
            ['A log of actions and any safeguarding escalation', 'Staff', 'Child safety and a record that can be looked at if a concern is raised'],
          ]),
          p('We do not ask for health or medical details, photographs or a child\'s phone number in the children\'s module. Please do not put such details in notes.'),
        ],
      },
      {
        id: 'consent', title: 'Who agrees, and how it is recorded',
        blocks: [
          p('A parent or guardian must agree before a child is registered. When a church worker registers a child in the staff app, they confirm that a guardian has agreed to the church keeping these details and has been shown this notice. ChurchOS records who ticked the box, when, and the version of the notice. The member record also keeps the date and the person who recorded the agreement.'),
          p('A guardian can withdraw agreement at any time by telling the church. The church then removes the child or ends the registration, except for records the law or child safety requires it to keep.'),
        ],
      },
      {
        id: 'access', title: 'Who can see it',
        blocks: [
          ul(
            'Children\'s ministry staff and teachers for their own branch and class, while they work.',
            'The guardians of the child, in the member app: their children, check-in state and pick-up people.',
            'Church staff with the right permission for the branch, for example to answer a data request.',
            'Platform administrators of ChurchOS only where needed for support, security or a lawful request, and what they do is logged.',
            'Nobody else, and children\'s data is never used for advertising or sold.',
          ),
        ],
      },
      {
        id: 'retention', title: 'How long it is kept',
        blocks: [
          table(['Data', 'Kept', 'What happens'], [
            ["Child's profile", 'Until the child turns 21, then reviewed by hand', 'A guardian can ask for deletion earlier. An adult who was registered as a child can ask for their own record'],
            ['Check-in, log lines and pick-up code details', '7 years', 'After 7 years names and ids are removed automatically. The time, class, tag and result stay for safeguarding'],
            ['Pick-up people', 'Until the guardian removes them', 'Removing a person ends their right to collect'],
          ]),
          p('The 7 year period for the safeguarding log is a working default that is being reviewed.'),
        ],
      },
      {
        id: 'rights', title: 'Rights of the guardian and the child',
        blocks: [
          ul(
            'See a child\'s data: member app, Family. The "Download my data" file lists the children in your household by name.',
            'Correct it: tell the church, or change pick-up people in the member app.',
            'Delete it: ask the church. If a child\'s only guardians have had their accounts erased, the child\'s details are anonymised too.',
            'Complain: to the church, to us at the contact below, or to the Office of the Data Protection Commissioner (odpc.go.ke).',
          ),
        ],
      },
      {
        id: 'safeguarding', title: 'Safeguarding comes first',
        blocks: [
          p('A church has a duty to keep children safe. Where there is a concern for a child\'s safety, the church may need to keep or share records with the authorities, such as the police or the children\'s services, even if a guardian asks for deletion. The law lets a church do this to protect a child.'),
          p(`Contact: ${contactLine(op)}.`),
        ],
      },
    ],
  };
}
