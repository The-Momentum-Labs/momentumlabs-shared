/**
 * Every Momentum Labs live session, in one list.
 *
 * This is the only place a night is added, moved or removed. Both
 * momentumlabs.ai and admissionsos.ai read from here, so an edit lands on both
 * sites at once. Tag each event with the products it belongs to: a site asking
 * for one product sees only its own, a site asking for nothing sees them all.
 */

export type ProductKey = 'admissionsos';

export type LiveEvent = {
  id: string;
  /** Which products claim this event. Empty means company-wide only. */
  products: readonly ProductKey[];
  when: string;
  date: string;
  time: string;
  whenIso: string;
  endIso: string;
  title: string;
  city: string;
  state: string;
  postalCode: string;
  venue: string;
  /** Short venue name for the flier overlay. */
  venueShort: string;
  /** Second line of the flier overlay, written the way it should read. */
  placeLabel: string;
  address: string;
  format: string;
  length: string;
  audience: string;
  blurb: string;
  /** Card body with bold. `blurb` stays plain for JSON-LD. */
  blurbHtml: string;
  signupHref: string;
  /** Filename inside events/assets, or undefined for no flier. */
  image?: string;
};

const FLIER = 'events-flier-machine.webp';
const VENUE = 'Alliance Marine - Innovation & Technology 6-12 Complex';
const VENUE_SHORT = 'Alliance Marine';
const PLACE_LABEL = 'Sun Valley, CA';
const ADDRESS = '11933 Allegheny St, Sun Valley, CA 91352, USA';
const MAIL = (night: string) =>
  `mailto:contact@momentumlabs.ai?subject=The%20Admissions%20Machine%2C%20${encodeURIComponent(night)}&body=Name%3A%0ARole%20(student%2C%20parent%2C%20counselor)%3A%0ASchool%20or%20practice%3A`;
const CARD_BLURB =
  'See how a former UC Berkeley admissions officer actually reads an application, using real awards, activities, essays, and student stories. Then learn how to use technology to find better-fit schools, understand your true cost, strengthen your application, and stay on top of every deadline.';
const CARD_BLURB_HTML =
  'See how a former <strong>UC Berkeley</strong> admissions officer <strong>actually reads</strong> an application, using real awards, activities, essays, and student stories. Then learn how to use technology to find <strong>better-fit</strong> schools, understand your <strong>true cost</strong>, strengthen your application, and stay on top of every <strong>deadline</strong>.';

export const EVENTS: LiveEvent[] = [
  {
    id: 'la-1',
    products: ['admissionsos'],
    when: 'Night one',
    date: 'Tuesday, September 29, 2026',
    time: '5-7pm',
    whenIso: '2026-09-29T17:00:00-07:00',
    endIso: '2026-09-29T19:00:00-07:00',
    title: 'The Admissions Machine',
    city: 'Sun Valley',
    state: 'California',
    postalCode: '91352',
    venue: VENUE,
    venueShort: VENUE_SHORT,
    placeLabel: PLACE_LABEL,
    address: ADDRESS,
    format: 'In person',
    length: '5-7pm',
    audience: 'Counselors and families',
    blurb: CARD_BLURB,
    blurbHtml: CARD_BLURB_HTML,
    image: FLIER,
    signupHref: MAIL('Los Angeles night one'),
  },
  {
    id: 'la-2',
    products: ['admissionsos'],
    when: 'Night two',
    date: 'Tuesday, October 27, 2026',
    time: '5-7pm',
    whenIso: '2026-10-27T17:00:00-07:00',
    endIso: '2026-10-27T19:00:00-07:00',
    title: 'The Admissions Machine',
    city: 'Sun Valley',
    state: 'California',
    postalCode: '91352',
    venue: VENUE,
    venueShort: VENUE_SHORT,
    placeLabel: PLACE_LABEL,
    address: ADDRESS,
    format: 'In person',
    length: '5-7pm',
    audience: 'Counselors and families',
    blurb: CARD_BLURB,
    blurbHtml: CARD_BLURB_HTML,
    image: FLIER,
    signupHref: MAIL('Los Angeles night two'),
  },
];

/** Events for one product, or every event when no product is named. */
export function eventsFor(product?: ProductKey): LiveEvent[] {
  if (!product) return EVENTS;
  return EVENTS.filter((e) => e.products.includes(product));
}
