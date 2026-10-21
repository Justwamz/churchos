import type { ReactNode, SVGProps } from 'react';

/**
 * Admin app line icons. 24px grid, 1.75 stroke, currentColor. No icon library: every glyph is a few SVG paths.
 * Usage: <Icon name="money" size={20} />  (size defaults to 24). Icons are decorative (aria-hidden); put the words next to them.
 */
const P: Record<string, ReactNode> = {
  today: <><rect x="3.5" y="4.5" width="17" height="16" rx="3" /><path d="M3.5 9.5h17M8 3v3M16 3v3" /><path d="M8 14h3" /></>,
  people: <><circle cx="9" cy="8" r="3.2" /><path d="M3 19.5c.6-3.3 3-5 6-5s5.4 1.7 6 5" /><circle cx="17" cy="9" r="2.4" /><path d="M16.5 14.2c2.3.2 3.9 1.7 4.5 4.3" /></>,
  worship: <><path d="M12 3v5M9.5 5.5h5" /><path d="M5 20.5v-8.2L12 8l7 4.3v8.2" /><path d="M10 20.5v-4.2a2 2 0 0 1 4 0v4.2M3 20.5h18" /></>,
  money: <><rect x="3" y="6" width="18" height="12" rx="3" /><circle cx="12" cy="12" r="2.8" /><path d="M6.5 9.5v.01M17.5 14.5v.01" /></>,
  communicate: <><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5z" /><path d="M8.5 9h7M8.5 12h4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 3.2l1.3 2.2 2.5-.6.9 2.4 2.4.9-.6 2.5 2.2 1.3-2.2 1.3.6 2.5-2.4.9-.9 2.4-2.5-.6L12 20.8l-1.3-2.2-2.5.6-.9-2.4-2.4-.9.6-2.5L3.3 12l2.2-1.3-.6-2.5 2.4-.9.9-2.4 2.5.6z" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  bell: <><path d="M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15z" /><path d="M10 21h4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  alert: <><path d="M12 4l9 16H3z" /><path d="M12 10v4.5M12 17.5v.01" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  grid: <><rect x="4" y="4" width="6.5" height="6.5" rx="2" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="2" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="2" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="2" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  user: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c.7-3.6 3.3-5.5 7-5.5s6.3 1.9 7 5.5" /></>,
  signout: <><path d="M14 4.5h3.5A2.5 2.5 0 0 1 20 7v10a2.5 2.5 0 0 1-2.5 2.5H14" /><path d="M10 8l-4 4 4 4M6 12h10" /></>,
  download: <><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5" /><path d="M5 19.5h14" /></>,
  receipt: <><path d="M6 3.5h12v17l-2.5-1.7-1.8 1.7-1.7-1.7-1.7 1.7-1.8-1.7L6 20.5z" /><path d="M9 8.5h6M9 12h6" /></>,
  message: <><rect x="3.5" y="5.5" width="17" height="13" rx="3" /><path d="M4.5 7.5l7.5 5.5 7.5-5.5" /></>,
  checkin: <><rect x="4" y="4" width="6" height="6" rx="1.5" /><rect x="14" y="4" width="6" height="6" rx="1.5" /><rect x="4" y="14" width="6" height="6" rx="1.5" /><path d="M14 14h2.5v2.5M20 14v.01M14 20h.01M17 20h3v-3" /></>,
  child: <><circle cx="12" cy="7.5" r="3" /><path d="M7 20v-3.5A5 5 0 0 1 12 12a5 5 0 0 1 5 4.5V20" /></>,
  heart: <path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z" />,
  book: <><path d="M5 4.5h11a3 3 0 0 1 3 3v12H8a3 3 0 0 1-3-3z" /><path d="M5 16.5a3 3 0 0 1 3-3h11" /></>,
  wallet: <><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v14H6.5A2.5 2.5 0 0 1 4 16.5z" /><path d="M18 9.5h2v5h-2a2.5 2.5 0 0 1 0-5z" /></>,
  shield: <><path d="M12 3.5l7 2.5v5.5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z" /><path d="M9 12l2.2 2.2L15 10.5" /></>,
  list: <><path d="M9 7h11M9 12h11M9 17h11" /><path d="M4.5 7v.01M4.5 12v.01M4.5 17v.01" /></>,
  sparkle: <path d="M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z" />,
  edit: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>,
  home: <><path d="M4 11l8-6.5 8 6.5" /><path d="M6 9.5V20h12V9.5M10 20v-5h4v5" /></>,
  tool: <><path d="M14.5 6.5a4 4 0 0 0-5 5L4 17l3 3 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z" /></>,
  refresh: <><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M19.5 4.5V8h-3.5" /></>,
  filter: <path d="M4 6h16M7 12h10M10 18h4" />,
  swap: <><path d="M7 7h12l-3-3M17 17H5l3 3" /></>,
  megaphone: <><path d="M4 10v4h3l8 4V6L7 10z" /><path d="M18.5 9.5a3.5 3.5 0 0 1 0 5" /></>,
  plug: <><path d="M9 4v4M15 4v4M6.5 8h11v3a5.5 5.5 0 0 1-11 0z" /><path d="M12 16.5V20" /></>,
  tag: <><path d="M4 12.5V5a1 1 0 0 1 1-1h7.5l7.5 7.5-8 8z" /><circle cx="8.5" cy="8.5" r="1.2" /></>,
  inbox: <><path d="M4 13l2.5-7.5h11L20 13v5.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" /><path d="M4 13h4.5l1 2.5h5l1-2.5H20" /></>,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 7.8v.01" /></>,
  more: <path d="M5 12v.01M12 12v.01M19 12v.01" />,
  building: <><path d="M5 20.5V5.5a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 15 5.5v15M15 10h3.5a1.5 1.5 0 0 1 1.5 1.5v9M3.5 20.5h17" /><path d="M8.5 8h3M8.5 11.5h3M8.5 15h3" /></>,
};

export type IconName = keyof typeof P;
export const iconNames = Object.keys(P) as IconName[];

export function Icon({ name, size = 24, ...rest }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {P[name] ?? P.list}
    </svg>
  );
}
