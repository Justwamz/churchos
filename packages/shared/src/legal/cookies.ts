import { contactLine, p, table, ul, type LegalCtx, type LegalDoc } from './types';

export function cookieNotice(c: LegalCtx): LegalDoc {
  const { op } = c;
  return {
    slug: 'cookies',
    title: 'Cookie and Local Storage Notice',
    blurb: 'Exactly what each ChurchOS app keeps in your browser, and why.',
    summary: [
      'The ChurchOS apps do not set cookies of their own and use no advertising or tracking tools.',
      'They keep a small number of items in your browser storage and the app files in a cache so the apps work offline. Nothing is used for tracking you.',
      'The list below is complete for the apps as built. You can clear any of it in your browser settings. Signing out removes your sign-in items.',
    ],
    sections: [
      {
        id: 'what', title: 'What this covers',
        blocks: [
          p(`The apps are run by ${op.name}. Browsers let a site keep small pieces of data on your device: cookies, local storage, session storage and caches. The ChurchOS member, staff, giving and platform administrator apps use local storage, session storage and, for the member and staff apps, a service worker cache. They do not use cookies of their own.`),
          p('Local storage stays until it is cleared. Session storage goes when you close the tab. A cache holds copies of app files.'),
        ],
      },
      {
        id: 'tracking', title: 'Tracking and advertising',
        blocks: [
          p('There are no advertising cookies, analytics scripts, tracking pixels or third-party widgets in the apps, and the fonts are served with the app. We do not build a profile of you from your browsing.'),
          p('The services that deliver the apps to your device, such as our hosting and network providers, may use technical cookies or similar means for security and delivery. We do not control these and do not use them for tracking. When you pay by card you are taken to the card provider\'s page, which has its own notice.'),
        ],
      },
      {
        id: 'all', title: 'Used in every app',
        blocks: [
          table(['Item', 'Where', 'What it holds', 'Why', 'How long'], [
            ['churchos:member-token, churchos:staff-token, churchos:admin-token', 'Member, staff, platform administrator apps', 'The random sign-in token for your session', 'To keep you signed in. Strictly needed.', 'Until you sign out or the session ends'],
            ['ChurchOS Member:user, ChurchOS Staff:user, Platform Admin:user', 'Member, staff, platform administrator apps', 'The basic profile returned when you signed in (name, phone, and which screens you may see)', 'To show the right screens at once', 'Until you sign out'],
            ['churchos:passkey-device', 'Any app where you add a passkey', 'A flag that this device has a passkey', 'To offer "Sign in with a passkey"', 'Until cleared'],
          ]),
        ],
      },
      {
        id: 'member', title: 'Member app',
        blocks: [
          table(['Item', 'What it holds', 'Why', 'How long'], [
            ['churchos:member-install-dismissed', 'That you closed the "install the app" prompt', 'So we do not keep asking', 'Until cleared'],
            ['churchos:shop-pending, churchos:ticket-pending', 'The order you started before going to the card page (order number and branch)', 'To bring you back to your order after you pay', 'Removed once you return'],
            ['churchos:basket:(branch)', 'The items and quantities in your shop basket for a branch', 'To keep your basket if you leave the page', 'Until you pay, clear it or clear the browser'],
            ['churchos:device', 'A short random device label such as "Member device 1A2B"', 'So the church\'s children\'s log can show which phone made a pick-up code', 'Until cleared'],
            ['Service worker caches: churchos-member-shell and churchos-member-public', 'App files and icons, and the last copy of public church pages (church name and branding)', 'To open the app fast and show screens offline', 'Replaced when the app updates; the public copy is removed when you sign out. Sign-in, personal data and payment requests are never cached'],
          ]),
        ],
      },
      {
        id: 'staff', title: 'Staff app',
        blocks: [
          table(['Item', 'What it holds', 'Why', 'How long'], [
            ['churchos:staff-nav-collapsed', 'Whether you hid the page list', 'Your preference', 'Until cleared'],
            ['churchos:staff-recent', 'Your recent searches and jumps in the command bar', 'To offer them again', 'Until cleared'],
            ['churchos:staff-visits', 'How many times you opened each page', 'To show your most-used pages as shortcuts. It stays on your device', 'Until cleared'],
            ['churchos:staff-install-dismissed', 'That you closed the install prompt', 'So we do not keep asking', 'Until cleared'],
            ['churchos:wallet-notice-dismissed (session storage)', 'That you closed the low messaging credit notice', 'So it does not reappear in the same visit', 'Until you close the tab'],
            ['churchos:kyc-welcome:(your user id) (session storage)', 'That you saw the verification reminder', 'So it shows once per visit', 'Until you close the tab'],
            ['churchos:device', 'A short random device label such as "Staff device 1A2B"', 'So the children\'s log can show which device did what', 'Until cleared'],
            ['churchos:dpa-remind', 'For an Organisation Owner: the time until which the reminder to accept the Data Processing Agreement is hidden (7 days)', 'So the reminder does not return every visit', 'Until cleared'],
            ['churchos:resources-view', 'Your list or grid choice for resources', 'Your preference', 'Until cleared'],
            ['churchos:kiosk-device', 'On a paired kiosk only: the device token that lets the screen do self check-in', 'To keep the kiosk paired. It can be revoked by the church', 'Until the kiosk is unpaired'],
            ['Service worker cache: churchos-staff-shell', 'App files and icons only', 'To open the app and show a friendly offline page', 'Replaced when the app updates. Nothing from the API is ever cached'],
          ]),
        ],
      },
      {
        id: 'giving', title: 'Giving page',
        blocks: [
          p('The giving page needs no sign-in to give. It keeps these items so you do not retype them. You can remove them by clearing site data.'),
          table(['Item', 'What it holds', 'Why', 'How long'], [
            ['churchos:church', 'The code of the church you last gave to', 'To open the right church next time', 'Until you change church or clear it'],
            ['churchos:lastChurch', 'The church you last picked', 'To suggest it again', 'Until cleared'],
            ['churchos:phone', 'The phone number you last gave from', 'To fill it in next time', 'Until cleared'],
            ['churchos:visitor', 'The name and phone number you gave on the visitor check-in page', 'To fill them in at your next visit', 'Until cleared'],
            ['churchos:giving:token, churchos:giving:attend, churchos:giving:checkout, churchos:giving:statement, churchos:giving:tickets', 'A sign-in token for that part of the page, present only after you sign in or verify a code there', 'To keep you signed in while you use it', 'Until you sign out or it expires'],
          ]),
        ],
      },
      {
        id: 'admin', title: 'Platform administrator app',
        blocks: [
          table(['Item', 'What it holds', 'Why', 'How long'], [
            ['churchos:admin-nav-collapsed', 'Whether you hid the page list', 'Your preference', 'Until cleared'],
            ['churchos:admin-recent', 'Your recent searches in the command bar', 'To offer them again', 'Until cleared'],
          ]),
        ],
      },
      {
        id: 'legal', title: 'Legal pages',
        blocks: [
          p('When you accept our Terms of Use and Privacy Notice, the acceptance is recorded on our server against your account, not in your browser. The legal pages themselves store nothing in your browser.'),
        ],
      },
      {
        id: 'control', title: 'Your control',
        blocks: [
          ul(
            'Signing out removes your sign-in token and profile, and asks the service worker to clear its public cache.',
            'You can clear site data in your browser at any time. You will be signed out and the apps forget your preferences.',
            'Blocking storage entirely still lets the apps work for the visit, but you will have to sign in again each time.',
          ),
          p(`Questions: ${contactLine(op)}.`),
        ],
      },
    ],
  };
}
